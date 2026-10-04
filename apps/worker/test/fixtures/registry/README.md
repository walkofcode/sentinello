# Recorded registry fixtures

Packuments recorded from registry.npmjs.org on 2026-10-03 and trimmed to the fields Sentinello reads
(`name`, `dist-tags`, maintainer names, `repository`, `time`, and per version its `dependencies`,
`optionalDependencies`, `peerDependencies`, `peerDependenciesMeta` and `deprecated`). Served by
`apps/worker/scripts/stub-registry.ts` so the `--fixture` smoke never reaches the network and its
historical outcomes never move.

- `base/` — the registry as it was on 2026-10-03: braces' newest is 3.0.3, node-forge's 1.4.0, qs has 6.16.0
  and no 6.15.4.
- `braces-released/` — overlays `base/`: braces 3.0.4 published outside `<=3.0.3`. A correct changed
  outcome the live invariants must accept and the historical set must reject.
