import { isAbsolute, relative, resolve, sep } from 'node:path'

// Where a resolved package came from, relative to the project and with `/` separators whatever the host,
// so the same tree reads the same everywhere it is recorded.
export function manifestPathOf(projectPath: string, absolutePath: string): string {
    return relative(projectPath, absolutePath).split(sep).join('/')
}

// Whether a local dependency path (`path = "../x"` in Cargo.toml, a Gemfile.lock PATH remote, a uv/poetry
// directory source), read relative to `fromDir`, stays inside the project. Inside, it is the project's own
// code — a workspace member, an engine, the gem being developed — and is not a dependency to audit at all.
// Outside, it is someone's local checkout that no advisory database covers, and the scan says it could not
// audit it.
export function isInsideProject(projectPath: string, fromDir: string, localPath: string): boolean {
    return isWithin(resolve(projectPath), resolve(fromDir, localPath))
}

// Whether `path` is `dir` or below it. Both absolute. Only a `..` path component leaves `dir`: a child
// directory may well be named `..service`.
export function isWithin(dir: string, path: string): boolean {
    const rel = relative(dir, path)
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
