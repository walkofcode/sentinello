// A library is identified by (ecosystem, packageName); its detail route encodes both segments so a
// same-named package in two ecosystems gets two distinct URLs. Centralized so every link builder and the
// revalidatePath calls construct the identical path.
export function libraryHref(ecosystem: string, packageName: string): string {
    return '/libraries/' + encodeURIComponent(ecosystem) + '/' + encodeURIComponent(packageName)
}

// The library detail link from the dashboard's libraries list, carrying its dep type (?ldep there, ?dep on
// the detail page) unless it is the instance default, for the same reason as projectDetailHref.
export function libraryDetailHref(ecosystem: string, packageName: string, depType: string, defaultDepType: string): string {
    const href = libraryHref(ecosystem, packageName)
    if (depType === defaultDepType) return href
    return href + '?dep=' + encodeURIComponent(depType)
}
