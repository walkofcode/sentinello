// A deliberately tiny TOML reader scoped to ONE shape: arrays-of-tables like `[[package]]` whose values
// are scalars (strings, bools, numbers) and arrays-of-strings. Cargo.lock, poetry.lock, and uv.lock are
// machine-generated and use exactly this regular structure, so a line-oriented block reader is reliable
// for them and lets us avoid adding a full TOML dependency (offline, sync, no supply-chain surface). It is
// NOT a general TOML parser — nested tables, inline tables, and multi-line strings are intentionally not
// supported, because these lockfiles don't use them inside `[[package]]` entries.

export type TomlTable = Record<string, string | string[]>

// Extract every `[[<tableName>]]` array-of-tables entry as a flat key→value map. A scalar value is stored
// as a string (quotes stripped); a single-line `key = ["a", "b"]` array becomes a string[]. Any nested
// `[<tableName>.sub]` header (e.g. `[package.dependencies]`) ends the current entry and is skipped until
// the next `[[<tableName>]]`.
export function parseArrayOfTables(text: string, tableName: string): TomlTable[] {
    const arrayHeader = '[[' + tableName + ']]'
    const out: TomlTable[] = []
    let current: TomlTable | null = null
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripComment(rawLine).trim()
        if (line.length === 0) continue
        if (line === arrayHeader) {
            current = {}
            out.push(current)
            continue
        }
        // Any other table header (`[x]` or `[[y]]`) closes the current entry.
        if (line.startsWith('[')) {
            current = null
            continue
        }
        if (!current) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        const value = line.slice(eq + 1).trim()
        if (key.length === 0) continue
        current[key] = parseValue(value)
    }
    return out
}

// Strip a trailing `#` comment, but only when the `#` is not inside a quoted string (Cargo.lock checksums
// and names never contain `#`, but version/source strings could in principle, so we respect quotes).
function stripComment(line: string): string {
    let inString = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') inString = !inString
        else if (ch === '#' && !inString) return line.slice(0, i)
    }
    return line
}

function parseValue(raw: string): string | string[] {
    if (raw.startsWith('[')) {
        // Single-line array of (mostly quoted) scalars: ["a", "b"].
        const inner = raw.replace(/^\[/, '').replace(/\]$/, '')
        const parts: string[] = []
        for (const seg of inner.split(',')) {
            const v = unquote(seg.trim())
            if (v.length > 0) parts.push(v)
        }
        return parts
    }
    return unquote(raw)
}

function unquote(raw: string): string {
    const s = raw.trim()
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
        return s.slice(1, -1)
    }
    return s
}
