# Changelog

## [3.3.0](https://github.com/walkofcode/sentinello/compare/v3.2.0...v3.3.0) (2026-08-15)


### Features

* **sources:** explain each source once, apart from its switch ([4719be1](https://github.com/walkofcode/sentinello/commit/4719be189a84d7aa6ebae2ff4270d598ead409f1))
* **sources:** offer only the ecosystems that are finished, and call npm Node.js ([a556062](https://github.com/walkofcode/sentinello/commit/a5560620b4a8c76214a980f65278790365b26fbf))
* **sources:** one line per source, and the built-in one cannot be switched off ([5f492de](https://github.com/walkofcode/sentinello/commit/5f492de9cc300b5423dd9a6baa45f6cede29226d))


### Bug Fixes

* **cli:** match the portal's dev filter and honour withdrawn advisories ([5edb223](https://github.com/walkofcode/sentinello/commit/5edb2232d29c7cb4755631aa60297a8ef87fa40e))
* **feeds:** keep every advisory version bound exactly as stated ([4292629](https://github.com/walkofcode/sentinello/commit/42926293142dbd0670e9623df30fb152c4c6f5a6))
* **feeds:** replace an advisory only once its replacement has arrived ([533d6f6](https://github.com/walkofcode/sentinello/commit/533d6f65f7dfcae2ed35458520fee8f20b07a5fe))
* **notifications:** describe every event a dispatch consumes ([603b49e](https://github.com/walkofcode/sentinello/commit/603b49e9f8bfd9d47d166b734def00b91cc49958))
* **notifications:** let cross-source escalation reach the severity filter ([89be7e9](https://github.com/walkofcode/sentinello/commit/89be7e9db31e707d0fd79a331d2515c1f9528d3c))
* **notifications:** stop maskSecret printing the secrets it is asked to hide ([52d845d](https://github.com/walkofcode/sentinello/commit/52d845defac0229593acd7f9afc717c36f94c890))
* **scanners:** give npm-audit findings the GHSA id so cross-source dedup can fire ([f6ac4c9](https://github.com/walkofcode/sentinello/commit/f6ac4c9d581a047bedfd332b735bd78619d99d14))
* **scanners:** stop the manifest overriding npm's proof of prod reachability ([bbcb29e](https://github.com/walkofcode/sentinello/commit/bbcb29e1b2baad3e0e3d9f54520fe1c8fc9d1723))
* **severity:** make the three grading vocabularies agree with core's ([784dffa](https://github.com/walkofcode/sentinello/commit/784dffacaece960d9eae2520ede262f695a7ad22))
* **sources:** count only cells that can run when guarding the last source ([1a69e6c](https://github.com/walkofcode/sentinello/commit/1a69e6c80a20709775b12f4d9e5540e090cd1a0e))
* **versions:** treat a zero lower bound as the bottom of the version space ([42d9af9](https://github.com/walkofcode/sentinello/commit/42d9af96fe9d4504fcbcfe71afc55909723ba7f1))
* **worker:** keep the scan cadence across midnight ([4008479](https://github.com/walkofcode/sentinello/commit/40084794d26dcb69f421ae244e918f3acbc72a45))


### Refactor

* **severity:** delete the last two rank tables that disagreed with core ([50e58bb](https://github.com/walkofcode/sentinello/commit/50e58bbb6da7ec6950fd595ea226695e0dfc3079))


### Documentation

* **about:** stop claiming gemnasium ranges are recovered from other sources ([9e23cbc](https://github.com/walkofcode/sentinello/commit/9e23cbc55b2397cfec42789bdd0922f8f17d35ae))
* **homepage:** stop advertising languages Sentinello does not scan ([7a77dd5](https://github.com/walkofcode/sentinello/commit/7a77dd5b59d565760e198045073129499aad4b48))
* **releases:** add the range-precision items to the 3.2.0 notes ([56b9bca](https://github.com/walkofcode/sentinello/commit/56b9bca27af01c5ad46ca671bb477e8d1f766615))
* **releases:** fold the 3.2.1 notes into 3.3.0 ([63322ff](https://github.com/walkofcode/sentinello/commit/63322ffbb08a38d05d040ced54bdc91bfd7d4c50))
* **releases:** move the range-precision notes to 3.2.1 ([5c8a1fe](https://github.com/walkofcode/sentinello/commit/5c8a1feebb25d0fd9c0896bf0133fef91750c4a3))
* **sources:** describe the ecosystem Sentinello actually scans ([e880aba](https://github.com/walkofcode/sentinello/commit/e880aba35295bcbaa2d1233158d33edda78561e1))

## [3.2.0](https://github.com/walkofcode/sentinello/compare/v3.1.1...v3.2.0) (2026-08-15)


### Features

* **findings:** keep which sources agree, and report the worst grade any gave ([895bf95](https://github.com/walkofcode/sentinello/commit/895bf95e7b76f44ba2b494e5110375534b0171d5))


### Bug Fixes

* **feeds:** drop gemnasium advisories that GitLab has retracted ([ef69193](https://github.com/walkofcode/sentinello/commit/ef691937452698665e83437c201202b5d81a3c3c))
* **notifications:** add the corroboration field to the render test fixture ([7abeaec](https://github.com/walkofcode/sentinello/commit/7abeaec69c80d65ec20ba0886984cff25f9b908e))


### Refactor

* **feeds:** honour gemnasium's affected_range and delete the recovery tiers ([e84c536](https://github.com/walkofcode/sentinello/commit/e84c53652a9edd9f12829cd226798157ee87699f))

## [3.1.1](https://github.com/walkofcode/sentinello/compare/v3.1.0...v3.1.1) (2026-08-14)


### Bug Fixes

* **feeds:** stop inventing gemnasium ranges and stop dropping OSV ones ([c3c5cc5](https://github.com/walkofcode/sentinello/commit/c3c5cc599e012cf7e9809eeb4879a1f8da4adc3a))
* **feeds:** stop inventing gemnasium ranges and stop dropping OSV ones ([205a38a](https://github.com/walkofcode/sentinello/commit/205a38a7f14bcdecae5d526a7282edb0d9d26353))


### Documentation

* **releases:** add the 3.1.1 what's-new entry ([93619e5](https://github.com/walkofcode/sentinello/commit/93619e528590cbe05dda2ae883fff45308383008))

## [3.1.0](https://github.com/walkofcode/sentinello/compare/v3.0.1...v3.1.0) (2026-08-13)


### Features

* **triage:** withhold muted findings from the default views ([2e5962d](https://github.com/walkofcode/sentinello/commit/2e5962d705b86530c5d61c99a4e104f0b5bce4e2))
* **worker:** bound scan history with a configurable retention window ([0b0ee18](https://github.com/walkofcode/sentinello/commit/0b0ee185448139d75f8f4296b3cc0db3575bc619))


### Bug Fixes

* **deps:** clear the six remaining advisories in the tree ([b69263e](https://github.com/walkofcode/sentinello/commit/b69263eec21eae81a5641e6ac49e538569987813))
* **mcp:** say that muted projects leave the dashboard totals, and stop dumping rawJson ([82e15db](https://github.com/walkofcode/sentinello/commit/82e15db681d7ece714609c6de5278272656f6123))
* **scanners:** summarise a successful npm-audit run instead of storing its raw output ([7e80070](https://github.com/walkofcode/sentinello/commit/7e80070a407bcd868e0df21a08d4c4734c5ce8eb))
* **ui:** keep focus in dialog fields and stop table styling leaking in ([d763333](https://github.com/walkofcode/sentinello/commit/d7633337c538200a42bf50141134a775c7f7c681))


### Documentation

* **releases:** add the 3.1.0 what's-new entry ([5bec661](https://github.com/walkofcode/sentinello/commit/5bec661195a7b05ee98e5b84ec300ab4aa2f21c5))

## [3.0.1](https://github.com/walkofcode/sentinello/compare/v3.0.0...v3.0.1) (2026-08-04)


### Bug Fixes

* **ci:** dispatch the npm publish from release-please ([371d60a](https://github.com/walkofcode/sentinello/commit/371d60a9ce7f925b790bb816fce40ac508428fad))
* **cli:** make a lost advisory source visible, refusable and retryable ([bd60514](https://github.com/walkofcode/sentinello/commit/bd60514c19b80254e1e9beb7d96ab4e2903556e7))
* **cli:** stop a switched-off source refusing a --fail-on gate forever ([b39c481](https://github.com/walkofcode/sentinello/commit/b39c4818a96c0c53ea2a4000d6fe8ee16238e4e5))
* **feeds:** release the download socket so the CLI actually exits ([dcbb627](https://github.com/walkofcode/sentinello/commit/dcbb62765cb2e2ec2ae98f655caf7b47ecc6891e))
* **feeds:** stop GitLab rejecting the archive download with HTTP 406 ([b8e1518](https://github.com/walkofcode/sentinello/commit/b8e1518f9e8f2b24db75472ed566e2e9c3900e15))
* the gemnasium HTTP 406, plus the 3.0.0 release-chain follow-ups ([8b570c4](https://github.com/walkofcode/sentinello/commit/8b570c4db909a5ab9104851b031e3e5e1fe2118a))


### Documentation

* correct the gemnasium sync description and document both --yes flags ([07f81f6](https://github.com/walkofcode/sentinello/commit/07f81f62b8f277217a00ee7fb4f86cad7ca5dbe7))
* **releases:** add the 3.0.1 what's-new entry ([d7eda01](https://github.com/walkofcode/sentinello/commit/d7eda01c44914143ca81f518851a7bc1a48a5f12))
* **releases:** backfill the missing pt-BR and zh-CN 2.6.0 entries ([3fb3310](https://github.com/walkofcode/sentinello/commit/3fb3310f64dfaccfab000337ee040e0b73f2f9a6))

## [3.0.0](https://github.com/walkofcode/sentinello/compare/v2.6.0...v3.0.0) (2026-08-03)


### Features

* **cli:** add --feed-wait, and narrate the wait so a seed cannot look hung ([a377db5](https://github.com/walkofcode/sentinello/commit/a377db55e40db73fe541160376fa466223173086))
* **homepage:** give the CLI a section, since 3.0 is the release that ships it ([d8d16aa](https://github.com/walkofcode/sentinello/commit/d8d16aa7cfbf0b78c46d5a8585b58df8dbecd896))


### Bug Fixes

* **cli:** quote the gemnasium seed size instead of "unknown size" ([0c1572c](https://github.com/walkofcode/sentinello/commit/0c1572cb832b6a5afb3a46e38ce3566df06bedbf))
* **cli:** reject a flag-shaped value instead of writing a file named "--" ([c21cfaf](https://github.com/walkofcode/sentinello/commit/c21cfafff40edffae072e5fb0001e6fbf37a3f66))
* **cli:** reject a JSON array in sentinello.config.json ([a8a8227](https://github.com/walkofcode/sentinello/commit/a8a82275d65abece878d3dc2bc52f82173d8fa0d))
* **cli:** stop formatDuration carrying a rounded remainder into a new minute ([93ced69](https://github.com/walkofcode/sentinello/commit/93ced69787c9a803a2db7e9d0f9263170fe0bac3))
* **core:** correct the gemnasium archive size to the measured 52 MB ([9311cdf](https://github.com/walkofcode/sentinello/commit/9311cdf5e6a6994268f1c48768d2445fb1ae4929))
* **core:** refresh the OSV npm export size to the measured 204 MB ([54ce237](https://github.com/walkofcode/sentinello/commit/54ce2379cd21c51ab286b8b7bf4e016ff5f4dad6))
* **db:** degrade instead of throwing on malformed dep_path_json ([e453670](https://github.com/walkofcode/sentinello/commit/e4536709035383e94190387fef27ed7d5f6d6fa4))
* **db:** fail open when a source scope column holds JSON null ([0e2431c](https://github.com/walkofcode/sentinello/commit/0e2431cfe100a8ae36932b4abace0a756be81881))
* **feeds:** wait out GitLab's archive refusal instead of retrying into it ([277b967](https://github.com/walkofcode/sentinello/commit/277b967c771c1e50d196691df92189e2ac3b6342))
* **homepage:** sync the Docker snippets with the README they claim to mirror ([5fa0fb5](https://github.com/walkofcode/sentinello/commit/5fa0fb56216fe5d0ee90b266c5c19c6af9de58a5))
* **scanners:** keep a finding when the installed version is a range ([718e301](https://github.com/walkofcode/sentinello/commit/718e301e7c1607242f47893f0d8619afd3edd16d))
* silence the build and lint warnings ([0573790](https://github.com/walkofcode/sentinello/commit/0573790aa7f4e1ccfcb6fdf917763af75f63c9ff))
* **web:** give the triage surfaces the accessibility they never had ([ed13882](https://github.com/walkofcode/sentinello/commit/ed13882db4868831409991a2ec9222143dd1e71a))
* **web:** let a rejected setting say why it was rejected ([222c613](https://github.com/walkofcode/sentinello/commit/222c613a0c26cccf58dcc9f021538ebfc4952f3b))
* **web:** stop the ecosystem filter memo recomputing on every render ([bd45562](https://github.com/walkofcode/sentinello/commit/bd455620d4c34e7372be5ddf6d13b5a124255d1c))
* **web:** stop the What's new popover running off the viewport ([5aef747](https://github.com/walkofcode/sentinello/commit/5aef7471bfce742c76ed4edb3ee6f21034e438ed))
* **worker:** stop discovery deleting projects under an unmounted root ([3670394](https://github.com/walkofcode/sentinello/commit/3670394fb58c517d04436e7f18e4607f46f3fb43))


### Dependencies

* add the React and Next lint plugins, and patch brace-expansion ([61ec674](https://github.com/walkofcode/sentinello/commit/61ec674dfe1704268d8a32b297a1523209c549d2))


### Refactor

* extract the two entry-point bodies and inject npm-audit's spawn ([e49eb00](https://github.com/walkofcode/sentinello/commit/e49eb00fbb7c533afab90765d942b95de39352d7))
* **ui:** adopt the React 19 ref and context APIs ([ef6c6fb](https://github.com/walkofcode/sentinello/commit/ef6c6fb1c1c1dfa8be0c43e556806bf8ee0f4ba3))


### Documentation

* add CI, coverage, release and license badges to both READMEs ([a3f19c8](https://github.com/walkofcode/sentinello/commit/a3f19c8db5ade9d20368d7d132248f7a87121f0c))
* correct the coverage table and scope the 100% function claim ([a2fb844](https://github.com/walkofcode/sentinello/commit/a2fb84467197d0015d34bf9f35bcfb82fcd6e366))
* drop the "Coming with 3.0" callout now that 3.0 publishes the CLI ([a57d2ce](https://github.com/walkofcode/sentinello/commit/a57d2cea129d4ef26e96add026264a947ca5b139))
* label the .gitignore upgrade note by the release that shipped it ([30d1499](https://github.com/walkofcode/sentinello/commit/30d14994446962d14cf83aba35141a382f826a39))
* mark the CLI as shipping with 3.0 and repair the publish runbook ([bb30ab2](https://github.com/walkofcode/sentinello/commit/bb30ab251ca9be1c122e3fab40220137fe748b5d))
* **releases:** add the 3.0.0 what's-new entry ([d015136](https://github.com/walkofcode/sentinello/commit/d01513601fa0b8fd069f235fd6f72dfaa4fe5fc5))
* stop asserting unreachability the evidence does not support ([8b6b12a](https://github.com/walkofcode/sentinello/commit/8b6b12a641949f9d6351c081577d4e30db6e9c5b))


### Chores

* release Sentinello as 3.0.0 ([1cccba4](https://github.com/walkofcode/sentinello/commit/1cccba464959d6a85ea8a8dcb4e62349dda20852))

## [2.6.0](https://github.com/walkofcode/sentinello/compare/v2.5.0...v2.6.0) (2026-07-29)


### Features

* **mcp:** deliver the advisory document, paginate it, describe every tool ([4298238](https://github.com/walkofcode/sentinello/commit/4298238038818f38481a5c54588b936ea5f37a63))


### Bug Fixes

* **db:** bucket every finding severity so counts cannot undercount ([aeacfb1](https://github.com/walkofcode/sentinello/commit/aeacfb1219fd6ec5e45bf9fbd1ed5244242b1214))
* **export:** count distinct advisories, not scanner rows ([95c3c03](https://github.com/walkofcode/sentinello/commit/95c3c031f33ee9dbeaef5f5c89b2f077dff90942))
* **ts:** make the Next apps inherit tsconfig.base, closing a strictness hole ([70dc9f6](https://github.com/walkofcode/sentinello/commit/70dc9f6f79e6ff92e6f39c2eadcb4f11954d4d5b))
* **web:** type finding buckets non-empty instead of guarding at each use ([4f95c5f](https://github.com/walkofcode/sentinello/commit/4f95c5ffa3ec1e7c8b4828cd6ec0eaf6995914ea))


### Refactor

* **core:** collapse four severity scales into one ordering ([26d124e](https://github.com/walkofcode/sentinello/commit/26d124e8491b06d5d35e996bdbddc061ba934679))


### Documentation

* **releases:** add the 2.6.0 what's-new entry ([285b842](https://github.com/walkofcode/sentinello/commit/285b8422222363e960bbfbfe7af1af57603b5cb6))

## [2.5.0](https://github.com/walkofcode/sentinello/compare/v2.4.3...v2.5.0) (2026-07-28)


### Features

* **mcp:** return the project advisory document over MCP ([8b9f81b](https://github.com/walkofcode/sentinello/commit/8b9f81b8881ca666ff94446c6ce3d8120b92f0e9))


### Bug Fixes

* **export:** exclude muted findings from the project advisory export ([da03215](https://github.com/walkofcode/sentinello/commit/da03215346b86c0e2c0a237aa1bc503089ced6c9))


### Documentation

* **releases:** add the 2.5.0 what's-new entry ([c10ffb6](https://github.com/walkofcode/sentinello/commit/c10ffb6c8bc0c224ec7bf53fbea695b16280d39e))

## [2.4.3](https://github.com/walkofcode/sentinello/compare/v2.4.2...v2.4.3) (2026-07-26)


### Features

* **export:** make the advisory prompt plan first and refuse a muted zero ([0ddecf7](https://github.com/walkofcode/sentinello/commit/0ddecf7cc78552082a36de1347b5cf9ea97d6f0b))


### Bug Fixes

* **ui:** portal popups so scroll containers stop clipping them ([bbc9fa6](https://github.com/walkofcode/sentinello/commit/bbc9fa6ff61eb96175f96e2e756beb0d7c27aaa4))


### Documentation

* **releases:** add 2.4.3 release notes ([e5d6a60](https://github.com/walkofcode/sentinello/commit/e5d6a60d13dc418ab8f86528b1db84857a1ec7b2))
* **releases:** date 2.4.3 to match the changelog ([d563a4b](https://github.com/walkofcode/sentinello/commit/d563a4b5f12d96a85427b5912034064baad19663))

## [2.4.2](https://github.com/walkofcode/sentinello/compare/v2.4.1...v2.4.2) (2026-07-25)


### Bug Fixes

* **projects:** give the scanned branch its own column ([98b0472](https://github.com/walkofcode/sentinello/commit/98b04726b9f4cc2fc6e1f9e4fd889f6334df8b91))


### Documentation

* **releases:** add 2.4.2 release notes ([ad8f068](https://github.com/walkofcode/sentinello/commit/ad8f068a07963f3a0d23604ef24b21c13e49b849))

## [2.4.1](https://github.com/walkofcode/sentinello/compare/v2.4.0...v2.4.1) (2026-07-25)


### Bug Fixes

* **worker:** deliver SIGTERM to the worker so it shuts down cleanly ([451d335](https://github.com/walkofcode/sentinello/commit/451d335db3ed34658e9f3a3ea9102ff6581144d4))


### Documentation

* **releases:** add 2.4.1 release notes ([27e0bda](https://github.com/walkofcode/sentinello/commit/27e0bda982ed53b5bb1fc395226022c19ad7ba99))

## [2.4.0](https://github.com/walkofcode/sentinello/compare/v2.3.0...v2.4.0) (2026-07-25)


### Features

* **export:** teach the advisory prompt about release age, lockfiles, and stale overrides ([835fd86](https://github.com/walkofcode/sentinello/commit/835fd867f3147acaf5a4bf55cca12873e95b799a))
* **projects:** per-row actions in the project list ([13f4040](https://github.com/walkofcode/sentinello/commit/13f4040efee0ff9743b2e240d3e4d619fd2562cb))
* **projects:** record and show the git branch that was scanned ([ecd62ff](https://github.com/walkofcode/sentinello/commit/ecd62ff042976af6d0aa4b62829b3dfa806e2a38))
* reframe Sentinello as a multi-language (polyglot) dependency scanner ([ba8f819](https://github.com/walkofcode/sentinello/commit/ba8f819c9381a2920e8d3e6801c37a7f3b6c86cd))


### Bug Fixes

* **deps:** force postcss &gt;=8.5.19 ([ebeefd5](https://github.com/walkofcode/sentinello/commit/ebeefd52b398c47f50110c17f016b09ce26a210c))
* **deps:** override @hono/node-server to 2.0.11 ([2d50f4d](https://github.com/walkofcode/sentinello/commit/2d50f4d8f05a24598d22f796bd5fec95215a5cd4))
* **deps:** override next&gt;sharp to 0.35.3 ([ba3609a](https://github.com/walkofcode/sentinello/commit/ba3609a39df6e37841d45779eca7139ff80b9b18))
* **deps:** refresh MCP SDK transitives (hono, fast-uri, body-parser) ([8c79298](https://github.com/walkofcode/sentinello/commit/8c792981f5518251acef80955cacab6307ee7c70))
* **deps:** upgrade axios to 1.18.1 and form-data to 4.0.6 ([2f15a5e](https://github.com/walkofcode/sentinello/commit/2f15a5ea670e52feaf21632494a280c01ed2ad64))
* **deps:** upgrade js-yaml to 4.3.0 ([29b13be](https://github.com/walkofcode/sentinello/commit/29b13be94b458ea986226f3ce07007f2808e0cb1))
* **deps:** upgrade next to 16.2.11 in both apps ([a32ef2d](https://github.com/walkofcode/sentinello/commit/a32ef2dbe7311e9aa443bb1b102f005113f95883))


### Performance

* **db:** index scans(project_id, finished_at) — dashboard was 3.3s, now 0.03s ([64005b5](https://github.com/walkofcode/sentinello/commit/64005b5a379d9b1dd65f7874c5d3db25fbe5a313))
* **web:** add route loading boundaries for projects and libraries ([b0ee68a](https://github.com/walkofcode/sentinello/commit/b0ee68a68d5ef3ad7f4f96f5be682f3d6fc68a5a))


### Documentation

* **docker:** clarify SENTINELLO_PORTAL_BASE_URL is the external URL ([1337589](https://github.com/walkofcode/sentinello/commit/1337589f76c4c3c7db84664b482a23ed4aab9949))
* **releases:** add 2.4.0 release notes ([bb003b1](https://github.com/walkofcode/sentinello/commit/bb003b1dd530b9fe28ce65b25b9ff4720cebe56f))

## [2.3.0](https://github.com/walkofcode/sentinello/compare/v2.2.0...v2.3.0) (2026-06-09)


### Features

* **mcp:** manage MCP entirely from Settings → MCP, drop env vars ([c7431b4](https://github.com/walkofcode/sentinello/commit/c7431b40d7911db575f4198be6e4de2961bc9c54))
* **settings:** show SENTINELLO_PORTAL_BASE_URL read-only when env-managed ([5369e45](https://github.com/walkofcode/sentinello/commit/5369e4537ac59fad31e92be382321baceaaa7b1d))


### Documentation

* **releases:** add 2.3.0 release notes ([f4ba1cc](https://github.com/walkofcode/sentinello/commit/f4ba1cc3ffcd8a4a4fadd53fb4157362f172ecaf))

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
