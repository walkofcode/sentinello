# Changelog

## [2.2.0](https://github.com/walkofcode/sentinello/compare/v2.1.0...v2.2.0) (2026-06-09)


### Features

* **db:** store enumerated affected versions for OSV advisories ([ad99492](https://github.com/walkofcode/sentinello/commit/ad994924d9f7b412db4e6caa959ce14e238f189a))
* **scanners:** unify version matching behind a shared resolver and engine ([087ca3c](https://github.com/walkofcode/sentinello/commit/087ca3c6d748c880de4bbb062f646fafa0b7ad72))
* **worker:** preserve real MAL ranges and enumerated versions in OSV cache ([8aebf29](https://github.com/walkofcode/sentinello/commit/8aebf296feae0f104f093b16f541f1a48ba68aad))


### Bug Fixes

* **db:** self-heal duplicate finding orphans on the next scan ([59bad7d](https://github.com/walkofcode/sentinello/commit/59bad7de2d2ae9c32ff0919678bb999acde0dc41))


### Documentation

* **readme:** note OSV malware findings match the compromised version ([e40cc1e](https://github.com/walkofcode/sentinello/commit/e40cc1e117d653eab2674f734fb7aab512d692d4))
* **releases:** add 2.2.0 release notes ([e74747e](https://github.com/walkofcode/sentinello/commit/e74747eb1d152a8673884deeef25b3b837252d63))

## [2.1.0](https://github.com/walkofcode/sentinello/compare/v2.0.1...v2.1.0) (2026-06-06)


### Features

* **web:** add icon-only variants to triage header controls ([5ae17f7](https://github.com/walkofcode/sentinello/commit/5ae17f796b620ac814d4e174acf920791717b662))
* **web:** simplify project header and add an enabled-source filter ([55ba68e](https://github.com/walkofcode/sentinello/commit/55ba68e43bb42c72c3f099505e75c1a335cd7ee4))
* **web:** unify dropdowns into one searchable component ([08d3f12](https://github.com/walkofcode/sentinello/commit/08d3f12adc512a0e0c6cfa3af508ab109acceb92))


### Documentation

* **release:** require docs(...) not chore for release-notes commits ([295bf56](https://github.com/walkofcode/sentinello/commit/295bf565514fc6e3591a7bef83d8e44f7a301431))
* remove ARCHITECTURE.md ([c5a1e74](https://github.com/walkofcode/sentinello/commit/c5a1e7438a7d65610879fdd425f12f98e9e37a84))
* remove shipped what's-new plan and design docs ([8196a23](https://github.com/walkofcode/sentinello/commit/8196a238cbcdef79c995d1812ab7266ba8d5c760))

## [2.0.1](https://github.com/walkofcode/sentinello/compare/v2.0.0...v2.0.1) (2026-06-04)


### Documentation

* **changelog:** expand the 2.0.0 breaking-changes notes with accurate upgrade steps ([555231e](https://github.com/walkofcode/sentinello/commit/555231e3ad0d4cdb492495261f43206517be5e80))
* **readme:** note the localhost-only port binding in the upgrade steps ([13d6cb1](https://github.com/walkofcode/sentinello/commit/13d6cb1e64d722f7a1c652023758081e66b3a38d))

## [2.0.0](https://github.com/walkofcode/sentinello/compare/v1.4.0...v2.0.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* **docker:** the container now runs as an **unprivileged user (`uid 10001`)**, and the nvm cache mount moved from `/root/.nvm` to `/home/sentinello/.nvm`. On upgrade the container **hard-fails by design** until you migrate the volumes: **delete and recreate** the nvm cache volume (it's a pure cache — do *not* `chown` it) and **`chown` the data volume** to `10001:10001`. Full steps: [README → Upgrading](https://github.com/walkofcode/sentinello/blob/main/README.md#upgrading).
* **mcp:** the MCP endpoint is now **disabled by default and requires a token**. Set `SENTINELLO_MCP_ENABLED=true` and `SENTINELLO_MCP_API_TOKEN` to keep existing MCP integrations working.
* **docker:** the compose / `docker run` examples now bind `127.0.0.1:` (**localhost-only**) and drop all Linux capabilities. To reach the portal from another host, drop the prefix and put auth in front. Prefer pinning a digest (`…:v2.0.0@sha256:<digest>`) over `:latest`.

### Features

* **about:** document every env var in a Configuration table ([7c40e04](https://github.com/walkofcode/sentinello/commit/7c40e042ad6cdcc3744fda66b0b563575b3f047c))
* **auth:** add an optional portal login gate ([fc0d11b](https://github.com/walkofcode/sentinello/commit/fc0d11b9e080af01e5680d1488cbd1a8232ffc9c))
* **db:** dedupe findings by advisory identity and filter by active source ([9a87b31](https://github.com/walkofcode/sentinello/commit/9a87b316ef95cb6c3b60a81453c5c6459a67c9e8))
* **docker:** run the container as an unprivileged user ([16f33ce](https://github.com/walkofcode/sentinello/commit/16f33cebe501d6b2b1aca7be86e9b869ca4be9a7))
* **findings:** merge findings across sources with source tags, filter, and dep-path popover ([fe58ec9](https://github.com/walkofcode/sentinello/commit/fe58ec9bf4eff678376d7d32ffbdfa92e4e9452a))
* **health:** fail the probe when the data directory is read-only ([19eda29](https://github.com/walkofcode/sentinello/commit/19eda29ace6c8f21f701ae1ae064fc053d4f1ee6))
* **health:** stop exposing the running version on the health probe ([2eaa618](https://github.com/walkofcode/sentinello/commit/2eaa6180082603f0945bae191f1c74dd8f3a868d))
* **homepage:** tighten landing — flat sections, merged narrative, self-host in hero ([c2d5756](https://github.com/walkofcode/sentinello/commit/c2d575610d104a4915bb61cc995a5e660670227f))
* **mcp:** disable the endpoint by default and require a token ([3bef66e](https://github.com/walkofcode/sentinello/commit/3bef66e163b9fa837759ad70c8de1f144fc82aa8))
* **notifications:** guard webhook dispatch against SSRF ([33a46c8](https://github.com/walkofcode/sentinello/commit/33a46c8b5f5e5aa4b3ef887b3adfdc3aab5779ed))
* **scanners:** add OSV as an opt-in vulnerability source with malicious-package detection ([e6ffa55](https://github.com/walkofcode/sentinello/commit/e6ffa550001cad08730b345b90f4ea047d022632))
* **settings:** make Settings a top-level section with a left sidebar and Profile page ([309bea2](https://github.com/walkofcode/sentinello/commit/309bea2623f94755c0b3a267c368c178ba45451f))
* **settings:** replace the OSV checkbox with an accessible Switch toggle ([decdc58](https://github.com/walkofcode/sentinello/commit/decdc58fed48db718ad078dc9e7476cecf62a7da))
* **triage:** mute and unmute merged finding rows across all identities ([10ee739](https://github.com/walkofcode/sentinello/commit/10ee739c9f9560c96bcee8e1aa209999da9bef89))


### Bug Fixes

* **about:** clarify the privacy note now that OSV is an optional source ([a27af5a](https://github.com/walkofcode/sentinello/commit/a27af5afcd1bb0d3725eaeadf9d1bc2867d83a19))
* **merge:** store the source/advisory key separator as an escape, not a raw NUL byte ([1aa3806](https://github.com/walkofcode/sentinello/commit/1aa380603de698edd9af943fc5a8ec7793082f09))
* **notifications:** bump axios to 1.16.1 (proxy/prototype-pollution advisories) ([ab44fa2](https://github.com/walkofcode/sentinello/commit/ab44fa2cfc270817cfab2464e7070dc5077decd9))


### Documentation

* **about:** reflect OSV source and rename title to Sentinello ([b28efb0](https://github.com/walkofcode/sentinello/commit/b28efb0041fa10ec30ca6d104c1725128ef246c2))
* **docker:** clarify the compose-prefixed nvm/data volume names on upgrade ([22d8ca0](https://github.com/walkofcode/sentinello/commit/22d8ca067db9666e2b5fdafa351532b7596d8c43))
* **readme:** restructure around the long-tail positioning ([653bc18](https://github.com/walkofcode/sentinello/commit/653bc18ce78789b876bad8f7002e576ea211e0b8))
* **releases:** add the 2.0.0 what's-new entry ([2bc7bb5](https://github.com/walkofcode/sentinello/commit/2bc7bb594001720956f62686b81ec8c8cfaf52c2))
* **security:** document the hardened self-hosting posture ([aa435d8](https://github.com/walkofcode/sentinello/commit/aa435d8162007a90608aee39e37fc0ffadbed181))

## [1.4.0](https://github.com/walkofcode/sentinello/compare/v1.3.1...v1.4.0) (2026-05-29)


### Features

* **core:** share release-notes data; backfill to 1.0; surface on homepage ([b8aa5a9](https://github.com/walkofcode/sentinello/commit/b8aa5a9c534f46fe5c00dd2266371bd357f8bc2e))
* **mcp:** host an MCP server at /api/mcp with read + action tools ([3110a22](https://github.com/walkofcode/sentinello/commit/3110a2239eb47536fd5c049a55129f98ade7eb3e))
* **web:** add release-highlights index for what's-new ([44c69f3](https://github.com/walkofcode/sentinello/commit/44c69f33ae921cbd733fe02389f7e5405aeb1451))
* **web:** add Settings → What's new version history page ([902bb02](https://github.com/walkofcode/sentinello/commit/902bb02b4ce6e0d651ecd42462b5b0e06222e2eb))
* **web:** add what's-new pill with dismissible highlights popover ([a243270](https://github.com/walkofcode/sentinello/commit/a243270c913507c3c7bb64bdfb8b3e20254ff084))
* **web:** mount what's-new pill in the top bar via layout slot ([8cdfa8d](https://github.com/walkofcode/sentinello/commit/8cdfa8d15e0cea3b680d23f8d73565c288c79527))
* **web:** move MCP settings to a dedicated section with server URL ([36fce99](https://github.com/walkofcode/sentinello/commit/36fce99738a218e8ad92537a68f91611f2863f3d))
* **web:** move what's-new pill next to the Settings nav link ([3403d3f](https://github.com/walkofcode/sentinello/commit/3403d3f00291a700f481a86f890f74e047bf5236))


### Bug Fixes

* **build:** pass SENTINELLO_* env through turbo strict mode ([35ea40b](https://github.com/walkofcode/sentinello/commit/35ea40bc7f41a39649a52b76d1b08904a359c7ce))
* **mcp:** correct severity filtering and tighten tool input schemas ([fe466a5](https://github.com/walkofcode/sentinello/commit/fe466a5a14393e4947a4fb8d3c60fe6a0354da02))
* **web:** equalize overview cards so severity stops squeezing metrics ([a48f979](https://github.com/walkofcode/sentinello/commit/a48f97942a170c20a195e1f3acec954a999ee507))
* **web:** shrink last-scan card so severity gets more room ([4e582eb](https://github.com/walkofcode/sentinello/commit/4e582eb49556e708af193986df7fb5c2d05cfb9d))
* **web:** sort roots alphabetically in filter and settings ([a1ef3aa](https://github.com/walkofcode/sentinello/commit/a1ef3aa4be66b1e870f9a5a51235ccbd97ad138d))
* **web:** store WhatsNew.releases as an array — next-intl forbids '.' in message keys ([a23465e](https://github.com/walkofcode/sentinello/commit/a23465ea6390321622d3ee3c370ee09b7546b9e3))


### Refactor

* **web:** drop unused getLatestHighlight helper ([46783ed](https://github.com/walkofcode/sentinello/commit/46783ed5765d7bfa4e81bc397d6041819886cfd1))
* **web:** move what's-new history into About 'Release notes' section ([6d204ef](https://github.com/walkofcode/sentinello/commit/6d204ef8a2f7d7ee6add3af987fd27b0098385c1))


### Documentation

* **whats-new:** design spec for what's-new pill + version history ([b381739](https://github.com/walkofcode/sentinello/commit/b381739ea99c350a24fe39c5c8996e1a974a1d76))
* **whats-new:** implementation plan for what's-new pill + version history ([f541347](https://github.com/walkofcode/sentinello/commit/f5413470fd75bc9feebd416375721201b4a362fe))

## [1.3.1](https://github.com/walkofcode/sentinello/compare/v1.3.0...v1.3.1) (2026-05-28)


### Bug Fixes

* **web:** strip 'v' prefix from SENTINELLO_VERSION so footer renders cleanly ([ace676e](https://github.com/walkofcode/sentinello/commit/ace676ed44eb4738ee8b1e713de895c97bdc4677))

## [1.3.0](https://github.com/walkofcode/sentinello/compare/v1.2.0...v1.3.0) (2026-05-28)


### Features

* **notifications:** env filter, simpler edit form, duplicate action ([bd4b4ee](https://github.com/walkofcode/sentinello/commit/bd4b4eec0d8c54a7294f4faf1291bbde30cb8746))


### Refactor

* **db:** extract shared depTypeClause helper ([f9e69a8](https://github.com/walkofcode/sentinello/commit/f9e69a8fe08260d15bd99274d3ee57cf5945b7da))

## [1.2.0](https://github.com/walkofcode/sentinello/compare/v1.1.2...v1.2.0) (2026-05-24)


### Features

* **web:** split home into separate Projects and Libraries pages ([50c4ec9](https://github.com/walkofcode/sentinello/commit/50c4ec9e4f86ff75e92960f67fd20d245e61501c))

## [1.1.2](https://github.com/walkofcode/sentinello/compare/v1.1.1...v1.1.2) (2026-05-24)


### Bug Fixes

* **worker:** live-reload schedule when portal saves changes ([cc4234a](https://github.com/walkofcode/sentinello/commit/cc4234afa50e3b4d5b79d04318fbf60a0d0b2b28))

## [1.1.1](https://github.com/walkofcode/sentinello/compare/v1.1.0...v1.1.1) (2026-05-23)


### Bug Fixes

* **ci:** collapse build outputs into one comma-separated name to keep manifest digest stable across registries ([623d304](https://github.com/walkofcode/sentinello/commit/623d304d4bb15e9f13349d6907b08cfa4ee78569))


### Refactor

* **ci:** split publish into parallel publish-ghcr / publish-hub jobs and rename to publish-image.yml ([89c249a](https://github.com/walkofcode/sentinello/commit/89c249ab426ab75eb15f06620636d628ed928485))

## [1.1.0](https://github.com/walkofcode/sentinello/compare/v1.0.1...v1.1.0) (2026-05-23)


### Features

* **web:** confirm before deleting roots and notification targets ([36d8c2c](https://github.com/walkofcode/sentinello/commit/36d8c2c5bbce270c31dbae1d546237c73f26fabe))
* **web:** replace footer update-available pill with dismissible top-of-page banner ([82d793a](https://github.com/walkofcode/sentinello/commit/82d793a63e538541cf0e56a57f46a3923d9d9fb3))
* **worker:** prune stale /roots/&lt;name&gt; entries on boot when their host mount is gone ([14ebb45](https://github.com/walkofcode/sentinello/commit/14ebb453dbc8f74c83e55e9cbc4df35e1495eedb))


### Bug Fixes

* **db:** cascade-delete projects, scan_requests, and target-roots on deleteRoot ([a233f40](https://github.com/walkofcode/sentinello/commit/a233f40532344763e7fda71aeafb2c7b4b397820))

## [1.0.1](https://github.com/walkofcode/sentinello/compare/v1.0.0...v1.0.1) (2026-05-23)


### Bug Fixes

* **db:** allow deleting a notification target with delivery history ([f5127b4](https://github.com/walkofcode/sentinello/commit/f5127b4da4692506e918ad27aca7b02641f7247e))
* **scanners:** drop audit findings whose lockfile-resolved install isn't in the vulnerable range ([e90a574](https://github.com/walkofcode/sentinello/commit/e90a57426443a72f22a90ba98cdaea8924f5092a))

## [1.0.0](https://github.com/walkofcode/sentinello/compare/v0.1.0...v1.0.0) (2026-05-23)


### Features

* initial open-source release ([8e5a02a](https://github.com/walkofcode/sentinello/commit/8e5a02a9433139af8bd222809a4ffc66f336e045))

## Changelog

All notable changes to Sentinello will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries below this line are generated by [release-please](https://github.com/googleapis/release-please) from conventional commit subjects on `main`. Do not edit by hand.
