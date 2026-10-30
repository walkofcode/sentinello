import type { FindingInstallation } from '@sentinello/core'

// Whether a finding's card names the manifests it is installed through: when there is more than one (a fix
// has to reach each), or its one manifest sits below the project root (ios/Gemfile.lock says which app it is
// in). A single root lockfile is what every npm project has, and naming it says nothing.
export function installationsWorthShowing(installations: readonly FindingInstallation[]): boolean {
    if (installations.length > 1) return true
    return installations.some(function nested(i) { return i.manifestPath.includes('/') })
}

// "ios/Gemfile.lock 2.0.8, android/Gemfile.lock 2.1.0".
export function installationsText(installations: readonly FindingInstallation[]): string {
    return installations.map(function copy(i) { return i.manifestPath + ' ' + i.version }).join(', ')
}
