import { parseArgs } from 'node:util'
import { liveScanners, loadExportBuilder } from './smoke-common'
import { openScratchEnv } from './scratch-env'

// Prints one project's advisory document — exactly what get_project_advisory returns — from a scratch COPY
// of the live database, optionally after rescanning the project there first (live registry, recording
// notifier, nothing sent). For reading the way out a real project gets without touching the live instance.
//
//   print-advisory.ts --db <scratch.sqlite> --project <id> [--rescan] [--prompt]
//
// The prompt is left out unless --prompt is given; the findings are what is being looked at.

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { db: { type: 'string' }, project: { type: 'string' }, rescan: { type: 'boolean' }, prompt: { type: 'boolean' } } })
    if (!values.db || !values.project) {
        console.error('usage: print-advisory.ts --db <scratch.sqlite> --project <id> [--rescan] [--prompt]')
        return 2
    }
    const env = await openScratchEnv({ db: values.db })
    try {
        const { getProjectById } = await import('@sentinello/db')
        const project = getProjectById(env.db, values.project)
        if (!project) {
            console.error('project ' + values.project + ' is not in ' + values.db)
            return 1
        }
        if (values.rescan) await env.scan(project, await liveScanners(env))
        const exported = (await loadExportBuilder()).buildProjectAdvisoryExport(env.db, project.id, 'all', Date.now())
        const markdown = exported ? exported.markdown : ''
        const findings = markdown.indexOf('## Findings')
        console.log(values.prompt || findings < 0 ? markdown : markdown.slice(findings))
        return 0
    } finally {
        env.close()
    }
}

main().then(function exit(code) {
    process.exit(code)
}, function crash(err: unknown) {
    console.error(err)
    process.exit(1)
})
