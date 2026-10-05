# Synthetic registry layer for the CLI e2e

Served by `tests/fixtures/registry-stub.ts` on top of `apps/worker/test/fixtures/registry/base/` when
`tests/e2e/cli` scans `tests/fixtures/projects/npm-basic`. Synthetic, not recorded: just enough of a
packument (`dist-tags`, `time`, `versions`) for the fixture advisories' stated fixes to be published, so
lodash 4.17.21 and minimist 1.2.6 settle `released` and the CLI's "upgrade to" path is exercised end to
end. axios is absent on purpose: it has no finding, so the registry is never asked about it.
