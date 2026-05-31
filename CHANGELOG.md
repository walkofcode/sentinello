# Changelog

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
