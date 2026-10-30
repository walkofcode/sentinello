import type { PublishedResult, PublishedSummary } from './published'
import { getRegistryBody, isRecord, jsonBody, registryBaseUrl, type RegistryFetchOptions } from './request'

// PyPI, read for one purpose: which releases of a project were published and are still installable, so a
// PyPI fix version is a fact rather than arithmetic on a range. One JSON document per project
// (`GET {pypi}/pypi/{name}/json`), reduced on arrival to the published summary.
//
// A release counts as published when it has at least one file: a version registered with no files (old
// Django releases have none) cannot be installed from PyPI. It is yanked (PEP 592) when every one of its
// files is; pip then picks it only for an exact pin, so it is never a fix.

export const DEFAULT_PYPI_URL = 'https://pypi.org'

export function pypiUrl(): string {
    return registryBaseUrl('SENTINELLO_PYPI_URL', DEFAULT_PYPI_URL)
}

// PyPI redirects any spelling of a name to its canonical one, so the name travels as it is, only encoded.
export function pypiPackageUrl(baseUrl: string, name: string): string {
    return baseUrl + '/pypi/' + encodeURIComponent(name) + '/json'
}

export async function fetchPypiPackage(name: string, options?: RegistryFetchOptions): Promise<PublishedResult> {
    const result = await getRegistryBody(pypiPackageUrl(options?.registryUrl ?? pypiUrl(), name), options, jsonBody('project document', [404]))
    if (result.status !== 'ok') return result
    const summary = summarizePypiProject(name, result.body)
    if (summary === null) return { status: 'error', reason: 'project document has no releases map' }
    return { status: 'ok', summary, etag: result.etag }
}

// Null when the body is not a project document at all (no releases map); a malformed release inside one
// is dropped rather than failing the project.
export function summarizePypiProject(name: string, body: unknown): PublishedSummary | null {
    if (!isRecord(body) || !isRecord(body.releases)) return null
    const versions: PublishedSummary['versions'] = {}
    for (const [version, files] of Object.entries(body.releases)) {
        if (!Array.isArray(files) || files.length === 0) continue
        versions[version] = { yanked: files.every(function isYanked(file) { return isRecord(file) && file.yanked === true }) }
    }
    return { v: 1, name, versions }
}
