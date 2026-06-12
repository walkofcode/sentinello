// A library is identified by (ecosystem, packageName); its detail route encodes both segments so a
// same-named package in two ecosystems gets two distinct URLs. Centralized so every link builder and the
// revalidatePath calls construct the identical path.
export function libraryHref(ecosystem: string, packageName: string): string {
    return '/libraries/' + encodeURIComponent(ecosystem) + '/' + encodeURIComponent(packageName)
}
