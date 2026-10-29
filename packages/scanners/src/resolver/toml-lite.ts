// A deliberately small TOML reader for the machine-written files the resolvers read: Cargo.lock,
// poetry.lock, uv.lock, and the `[project]`/`[tool.poetry]`/`[dev-dependencies]` tables of pyproject.toml
// and Cargo.toml. It reads table and array-of-tables headers, `key = value` pairs with bare or quoted keys,
// basic and literal strings, arrays (across lines, trailing comma allowed) and inline tables, which is every
// construct those files put where the resolvers look. It avoids a TOML dependency (offline, sync, no
// supply-chain surface).
//
// It is NOT a general TOML parser: dotted keys, multi-line strings, dates and the numeric forms are not
// interpreted (a number or boolean is kept as its source text), and a value it cannot read is skipped
// rather than guessed at. Nothing the resolvers derive a version or a dependency from needs any of them.

export type TomlValue = string | TomlValue[] | { [key: string]: TomlValue }
export type TomlTable = Record<string, TomlValue>

// One `[header]` or `[[header]]` section, in file order. Keys before the first header belong to a section
// whose header is ''.
export type TomlSection = { header: string; array: boolean; values: TomlTable }

// One `[[<tableName>]]` entry: its own keys, plus each `[<tableName>.<sub>]` section that follows it before
// the next entry (`[package.dependencies]`, `[package.dev-dependencies]`), keyed by `<sub>`.
export type ArrayTableEntry = { values: TomlTable; sub: Record<string, TomlTable> }

export function parseTomlSections(text: string): TomlSection[] {
    const sections: TomlSection[] = [{ header: '', array: false, values: {} }]
    let current = sections[0] as TomlSection
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        let line = stripComment(lines[i] as string).trim()
        if (line.length === 0) continue
        // A key never starts with `[`, so any line that does is a header — including one whose quoted part
        // holds an `=`, like `[target.'cfg(target_os = "linux")'.dev-dependencies]`.
        if (line.startsWith('[')) {
            const array = line.startsWith('[[')
            const header = line.slice(array ? 2 : 1, line.length - (array ? 2 : 1)).trim()
            current = { header, array, values: {} }
            sections.push(current)
            continue
        }
        // A value may continue over the following lines until its brackets and braces close.
        while (!balanced(line) && i + 1 < lines.length) {
            i++
            line += ' ' + stripComment(lines[i] as string).trim()
        }
        const pair = readPair(line)
        if (pair !== null) current.values[pair.key] = pair.value
    }
    return sections
}

// Every `[[<tableName>]]` entry with the `[<tableName>.<sub>]` sections that belong to it. Any other header
// ends the current entry.
export function parseArrayTableEntries(text: string, tableName: string): ArrayTableEntry[] {
    const out: ArrayTableEntry[] = []
    let current: ArrayTableEntry | null = null
    for (const section of parseTomlSections(text)) {
        if (section.array && section.header === tableName) {
            current = { values: section.values, sub: {} }
            out.push(current)
            continue
        }
        if (current !== null && !section.array && section.header.startsWith(tableName + '.')) {
            current.sub[section.header.slice(tableName.length + 1)] = section.values
            continue
        }
        current = null
    }
    return out
}

// The keys of every `[[<tableName>]]` entry, without its sub-tables.
export function parseArrayOfTables(text: string, tableName: string): TomlTable[] {
    return parseArrayTableEntries(text, tableName).map(function own(entry) { return entry.values })
}

export function tomlString(value: TomlValue | undefined): string | null {
    return typeof value === 'string' ? value : null
}

export function tomlArray(value: TomlValue | undefined): TomlValue[] {
    return Array.isArray(value) ? value : []
}

export function tomlTable(value: TomlValue | undefined): TomlTable | null {
    return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : null
}

type Pair = { key: string; value: TomlValue }

function readPair(line: string): Pair | null {
    const reader = new Reader(line)
    const key = reader.key()
    if (key === null || !reader.consume('=')) return null
    const value = reader.value()
    return value === null ? null : { key, value }
}

// Whether every `[` and `{` outside a string has closed.
function balanced(line: string): boolean {
    let depth = 0
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote !== null) {
            if (ch === '\\' && quote === '"') i++
            else if (ch === quote) quote = null
            continue
        }
        if (ch === '"' || ch === "'") quote = ch
        else if (ch === '[' || ch === '{') depth++
        else if (ch === ']' || ch === '}') depth--
    }
    return depth <= 0
}

// Strip a trailing `#` comment, but only when the `#` is not inside a quoted string.
function stripComment(line: string): string {
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote !== null) {
            if (ch === '\\' && quote === '"') i++
            else if (ch === quote) quote = null
            continue
        }
        if (ch === '"' || ch === "'") quote = ch
        else if (ch === '#') return line.slice(0, i)
    }
    return line
}

class Reader {
    private pos = 0
    constructor(private readonly text: string) {}

    key(): string | null {
        this.skipSpace()
        const ch = this.text[this.pos]
        if (ch === '"' || ch === "'") return this.string()
        const match = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.pos))
        if (!match) return null
        this.pos += match[0].length
        return match[0]
    }

    consume(token: string): boolean {
        this.skipSpace()
        if (!this.text.startsWith(token, this.pos)) return false
        this.pos += token.length
        return true
    }

    value(): TomlValue | null {
        this.skipSpace()
        const ch = this.text[this.pos]
        if (ch === '"' || ch === "'") return this.string()
        if (ch === '[') return this.array()
        if (ch === '{') return this.inlineTable()
        // A number, boolean or date: kept as its source text up to the next separator.
        const match = /^[^,\]}\s]+/.exec(this.text.slice(this.pos))
        if (!match) return null
        this.pos += match[0].length
        return match[0]
    }

    private string(): string | null {
        const quote = this.text[this.pos]
        this.pos++
        let out = ''
        while (this.pos < this.text.length) {
            const ch = this.text[this.pos] as string
            this.pos++
            if (ch === quote) return out
            if (ch === '\\' && quote === '"') {
                const next = this.text[this.pos]
                this.pos++
                out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '')
                continue
            }
            out += ch
        }
        return null
    }

    private array(): TomlValue[] | null {
        this.pos++
        const out: TomlValue[] = []
        for (;;) {
            if (this.consume(']')) return out
            const item = this.value()
            if (item === null) return null
            out.push(item)
            if (this.consume(',')) continue
            return this.consume(']') ? out : null
        }
    }

    private inlineTable(): TomlTable | null {
        this.pos++
        const out: TomlTable = {}
        for (;;) {
            if (this.consume('}')) return out
            const key = this.key()
            if (key === null || !this.consume('=')) return null
            const item = this.value()
            if (item === null) return null
            out[key] = item
            if (this.consume(',')) continue
            return this.consume('}') ? out : null
        }
    }

    private skipSpace(): void {
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) this.pos++
    }
}
