import {
    awaitBaseline,
    awaitQueueIdle,
    deleteRequest,
    findingAges,
    insertRunningRequest,
    reset,
    state
} from './db-admin'

// argv-dispatched entry point for db-admin, run under tsx by admin.ts. Everything it prints on stdout
// is JSON, so the caller can parse one line and nothing else needs a protocol.

async function main(): Promise<void> {
    const [sub, ...rest] = process.argv.slice(2)
    if (sub === 'state') {
        console.log(JSON.stringify(state()))
        return
    }
    if (sub === 'await-baseline') {
        const timeout = Number(rest[0] || 120_000)
        const expected = JSON.parse(rest[1] || '{}') as Record<string, number>
        console.log(JSON.stringify(await awaitBaseline(timeout, expected)))
        return
    }
    if (sub === 'await-queue-idle') {
        await awaitQueueIdle(Number(rest[0] || 30_000))
        console.log(JSON.stringify({ ok: true }))
        return
    }
    if (sub === 'reset') {
        console.log(JSON.stringify(await reset()))
        return
    }
    if (sub === 'finding-ages') {
        console.log(JSON.stringify(findingAges()))
        return
    }
    if (sub === 'insert-running-request') {
        if (!rest[0]) throw new Error('[e2e] insert-running-request needs a project id')
        console.log(JSON.stringify({ id: insertRunningRequest(rest[0]) }))
        return
    }
    if (sub === 'delete-request') {
        if (!rest[0]) throw new Error('[e2e] delete-request needs a request id')
        deleteRequest(rest[0])
        console.log(JSON.stringify({ ok: true }))
        return
    }
    throw new Error('[e2e] unknown db-admin subcommand: ' + String(sub))
}

main().catch(function fail(err: unknown) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
})
