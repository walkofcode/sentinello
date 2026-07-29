#!/usr/bin/env node
import { main } from './run'

// The CLI bin. Everything it does lives in ./run — this file exists only to run it and turn the
// returned exit code into process.exitCode.
//
// The split is what makes main() testable: importing THIS module parses process.argv and sets the
// process exit code as an import side effect, so a test could never import it.
//
// The filename is load-bearing. tsup.config.ts declares `entry: { cli: 'src/cli.ts' }`, and its
// comments record that the shebang above is preserved by esbuild from this file rather than added as
// a banner — adding a banner as well emits it twice and the second line fails to parse. package.json's
// `bin` points at the resulting dist/cli.cjs, and the dev script runs this file directly.
//
// process.exitCode rather than process.exit(): the document may have just been written to a pipe, and
// exiting outright can truncate it. Setting the code lets Node flush stdout and leave on its own.

main()
    .then(function exit(code: number) {
        process.exitCode = code
    })
    .catch(function onFatal(err: unknown) {
        const message = err instanceof Error && err.message || String(err)
        process.stderr.write('sentinello: ' + message + '\n')
        process.exitCode = 1
    })
