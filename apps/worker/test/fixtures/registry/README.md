# Recorded registry fixtures

Packuments recorded from registry.npmjs.org on 2026-10-03 and trimmed to the fields Sentinello reads
(`name`, `dist-tags`, maintainer names, `repository`, `time`, and per version its `dependencies`,
`optionalDependencies`, `peerDependencies`, `peerDependenciesMeta` and `deprecated`). Served by
`apps/worker/scripts/stub-registry.ts` so the `--fixture` smokes never reach the network and their
historical outcomes never move.

- `base/` — the registry as it was on 2026-10-03: braces' newest is 3.0.3, node-forge's 1.4.0, qs has 6.16.0
  and no 6.15.4. It also holds every package the way-out walk reads for the fixture project (the nodemon
  and @next/eslint-plugin-next chains, their closures, and the curated alternatives tinyglobby, picomatch
  and zeptomatch). Those were recorded with prerelease versions left out: the registry client drops
  prereleases on arrival, so no outcome depends on them. `_downloads.json` holds last week's download
  counts for the packages whose signals the guidance shows (served on npm's
  `/downloads/point/last-week/<name>` route).
- `braces-released/` — overlays `base/`: braces 3.0.4 published outside `<=3.0.3`. A correct changed
  outcome the live invariants must accept and the historical sets must reject.
- `nodemon-escape/` — overlays `base/`: a synthetic nodemon 3.2.0 (published 2026-10-02) declaring
  3.1.14's dependencies with chokidar `^4.0.0`, so its whole closure is braces-free. braces stays
  `none_released`; the nodemon chain becomes "upgrade nodemon to ≥ 3.2.0". smoke-remediation's historical
  set must reject it; smoke-fix-status's still holds.
