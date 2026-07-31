import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, setConfigValue, type DrizzleDb, type SqliteDb } from '@sentinello/db'
import { getConfiguredToken, isMcpEnabled, verifyMcpAuth } from './auth'

// This is the only thing standing in front of the MCP endpoint, and the endpoint can mute findings
// and request scans. The design deliberately collapses two concepts: the token IS the on/off switch,
// so "no token configured" must mean "off", never "open".
//
// getDb() caches its handle on globalThis, so seeding that global with a temp-file database points
// the module under test at a real schema without mocking anything.

const MIGRATIONS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..',
    'packages', 'db', 'drizzle'
)

// Not shaped like any real credential — a realistic-looking fixture would trip secret scanning on
// push even though it is fabricated.
const TOKEN = 'not-a-real-mcp-token'

type GlobalWithDb = typeof globalThis & {
    __sentinelloDb?: { db: DrizzleDb; sqlite: SqliteDb }
}

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function request(authorization?: string): Request {
    const headers = new Headers()
    if (authorization !== undefined) headers.set('authorization', authorization)
    return new Request('https://portal.example.test/api/mcp', { method: 'POST', headers })
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-mcp-auth-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    ;(globalThis as GlobalWithDb).__sentinelloDb = { db, sqlite }
})

afterEach(async function teardown() {
    delete (globalThis as GlobalWithDb).__sentinelloDb
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('getConfiguredToken', function () {
    it('returns null when no token has been set', function () {
        expect(getConfiguredToken()).toBeNull()
    })

    it('returns the configured token', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(getConfiguredToken()).toBe(TOKEN)
    })

    it('trims surrounding whitespace', function () {
        setConfigValue(db, 'mcp_api_token', '  ' + TOKEN + '  ')
        expect(getConfiguredToken()).toBe(TOKEN)
    })

    // A whitespace-only value is an operator clearing the field, not a token made of spaces.
    it('treats a blank value as no token', function () {
        setConfigValue(db, 'mcp_api_token', '   ')
        expect(getConfiguredToken()).toBeNull()
    })

    it('treats an empty string as no token', function () {
        setConfigValue(db, 'mcp_api_token', '')
        expect(getConfiguredToken()).toBeNull()
    })
})

describe('isMcpEnabled', function () {
    // There is no separate enable flag: the presence of a token is both necessary and sufficient, so
    // clearing it is how an operator turns MCP off.
    it('is off until a token is configured', function () {
        expect(isMcpEnabled()).toBe(false)
    })

    it('is on once a token is configured', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(isMcpEnabled()).toBe(true)
    })

    it('goes off again when the token is cleared', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        setConfigValue(db, 'mcp_api_token', '')
        expect(isMcpEnabled()).toBe(false)
    })
})

describe('verifyMcpAuth', function () {
    // The failure that would matter most: no token configured must never mean "let everyone in".
    it('rejects every request when no token is configured', function () {
        const result = verifyMcpAuth(request('Bearer ' + TOKEN))
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.status).toBe(401)
    })

    it('accepts a correct bearer token', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(verifyMcpAuth(request('Bearer ' + TOKEN))).toEqual({ ok: true })
    })

    it('accepts the scheme case-insensitively', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(verifyMcpAuth(request('bearer ' + TOKEN)).ok).toBe(true)
        expect(verifyMcpAuth(request('BEARER ' + TOKEN)).ok).toBe(true)
    })

    it('tolerates extra whitespace around the token', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(verifyMcpAuth(request('Bearer   ' + TOKEN + '  ')).ok).toBe(true)
    })

    it('rejects a wrong token', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        const result = verifyMcpAuth(request('Bearer wrong-token-entirely'))
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.status).toBe(401)
    })

    // Equal length is the interesting case: it is the one that actually reaches timingSafeEqual
    // rather than being short-circuited by the length check.
    it('rejects a wrong token of exactly the right length', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        const sameLength = 'x'.repeat(TOKEN.length)
        expect(sameLength).toHaveLength(TOKEN.length)
        expect(verifyMcpAuth(request('Bearer ' + sameLength)).ok).toBe(false)
    })

    it('rejects a token that is merely a prefix of the real one', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(verifyMcpAuth(request('Bearer ' + TOKEN.slice(0, -1))).ok).toBe(false)
    })

    it('rejects a missing Authorization header', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(verifyMcpAuth(request()).ok).toBe(false)
    })

    it('rejects a malformed Authorization header', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        expect(verifyMcpAuth(request(TOKEN)).ok).toBe(false)
        expect(verifyMcpAuth(request('Basic ' + TOKEN)).ok).toBe(false)
        expect(verifyMcpAuth(request('Bearer')).ok).toBe(false)
        expect(verifyMcpAuth(request('Bearer ')).ok).toBe(false)
    })

    // Every rejection answers 401 so a client cannot tell "MCP is off" from "your token is wrong",
    // which would otherwise disclose whether the endpoint is worth attacking.
    it('answers 401 for every rejection path without disclosing which applies', function () {
        const noToken = verifyMcpAuth(request('Bearer ' + TOKEN))
        setConfigValue(db, 'mcp_api_token', TOKEN)
        const missingHeader = verifyMcpAuth(request())
        const malformed = verifyMcpAuth(request('Basic ' + TOKEN))
        const wrong = verifyMcpAuth(request('Bearer nope'))

        for (const result of [noToken, missingHeader, malformed, wrong]) {
            expect(result.ok).toBe(false)
            expect(result.ok === false && result.status).toBe(401)
        }
    })

    it('never echoes the expected or supplied token in its error body', function () {
        setConfigValue(db, 'mcp_api_token', TOKEN)
        const result = verifyMcpAuth(request('Bearer some-supplied-token'))
        const body = result.ok === false ? JSON.stringify(result.body) : ''
        expect(body).not.toContain(TOKEN)
        expect(body).not.toContain('some-supplied-token')
    })
})
