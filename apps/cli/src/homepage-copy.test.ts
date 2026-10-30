import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseArgs, runsNpmAudit } from './options'

// The homepage's CLI comparison promises that nothing is installed or run to read a project's lockfiles. That
// holds for Python, Go, Rust and Ruby, which are parsed as files, but a default `npx sentinello` runs npm audit
// for a Node.js project, which invokes the Node package manager. Every locale's row has to keep Node.js out of
// that promise and name npm audit for it, for as long as the default run includes npm audit.

const MESSAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homepage', 'messages')

describe('the homepage CLI languages row', function () {
    it('qualifies Node.js with npm audit in every locale, as the default run does', async function () {
        const parsed = parseArgs([])
        if (parsed.kind !== 'options') throw new Error('expected options')
        expect(runsNpmAudit(parsed.options)).toBe(true)

        const files = (await readdir(MESSAGES)).filter(function json(name) { return name.endsWith('.json') })
        expect(files).toHaveLength(10)
        for (const file of files) {
            const messages = JSON.parse(await readFile(join(MESSAGES, file), 'utf8')) as { Cli: { ours_languages: string } }
            expect(messages.Cli.ours_languages, file).toContain('npm audit')
        }
    })
})
