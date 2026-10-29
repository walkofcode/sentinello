// PEP 503 name normalization: lower-case, every run of `-`, `_` and `.` collapsed to one `-`
// (https://peps.python.org/pep-0503/#normalized-names). `Django`, `django` and `DJANGO` are one project on
// PyPI, as are `zope.interface` and `zope-interface`, and a lockfile, OSV and gemnasium each spell them
// however their author did. Every reader of a PyPI name keys on this one function, so an advisory and the
// installed package it is about always meet.
//
// It lives here, beside the version semantics, because it used to be written three times — once in the
// Python resolver and once in each feed normalizer that remembered it. OSV's was the one that did not, so
// its PyPI advisories never joined a resolved package whose name differed by case or separator.
export function normalizePyName(name: string): string {
    return name.trim().toLowerCase().replace(/[-_.]+/g, '-')
}
