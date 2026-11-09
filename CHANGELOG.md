# Changelog

## [2.5.0](https://github.com/The-Vibe-Company/armada/compare/v2.4.0...v2.5.0) (2026-11-09)


### Features

* durable async golden build jobs ([#551](https://github.com/The-Vibe-Company/armada/issues/551)) ([1891460](https://github.com/The-Vibe-Company/armada/commit/18914609a1e3c6435915b3e2e3d86a178986bd31))
* **golden:** async build admission and status ([6005b7f](https://github.com/The-Vibe-Company/armada/commit/6005b7fde909416328615d729aa336541846a69f))


### Bug Fixes

* **cli:** let explicit API deadlines own the fetch budget ([712bc3e](https://github.com/The-Vibe-Company/armada/commit/712bc3ead775a1b715ce142882206069e75c9266))
* **golden:** authorize mutations before provider work ([678e2ee](https://github.com/The-Vibe-Company/armada/commit/678e2eefbd52761de57fb400b37338e434c0161d))
* **golden:** authorize mutations before provider work ([e0dbc21](https://github.com/The-Vibe-Company/armada/commit/e0dbc21167aa209d6d21e4223d94a5a9689685d9))
* **golden:** bind serialized config as text before jsonb parsing ([6d234bb](https://github.com/The-Vibe-Company/armada/commit/6d234bbcfde814aa4f2d3e9e721b0f17d5be62f4))
* **golden:** bind serialized config as text before jsonb parsing ([#558](https://github.com/The-Vibe-Company/armada/issues/558)) ([c9b3322](https://github.com/The-Vibe-Company/armada/commit/c9b3322e046227d95f119f3346a57cbaabd09fe7))
* **golden:** complete production baseline builds ([d25f499](https://github.com/The-Vibe-Company/armada/commit/d25f499186a717a4fd9d140b367d0c15dd78676b))
* **golden:** complete production baseline builds ([d319e5f](https://github.com/The-Vibe-Company/armada/commit/d319e5f174e7e48c958f8d5326dad0ffec643f27))
* **golden:** diagnose fenced publication failures without raw errors ([6cebfce](https://github.com/The-Vibe-Company/armada/commit/6cebfced8916cefe18b4d7c0c15afb2b8f5207ce))
* **golden:** honor Boat scan execution limits ([5548434](https://github.com/The-Vibe-Company/armada/commit/5548434646e14298645f37dd3bd6dab950f1f750))
* **golden:** honor Boat scan execution limits ([d12bdb7](https://github.com/The-Vibe-Company/armada/commit/d12bdb75640cba1de40f842828ddf8832150d5eb))
* **golden:** preserve verified provider snapshot references ([9ab0c1c](https://github.com/The-Vibe-Company/armada/commit/9ab0c1ca16b8a716f543710c2cc4c349a9989aaa))
* **golden:** publish Boat compatibility pointers atomically ([43875ad](https://github.com/The-Vibe-Company/armada/commit/43875adec16f52d1a4747c8b6f8d8a1048c0ce87))
* **golden:** publish Boat compatibility pointers atomically ([#555](https://github.com/The-Vibe-Company/armada/issues/555)) ([1b972f6](https://github.com/The-Vibe-Company/armada/commit/1b972f61c59fbf1b7ec70bf68a1b658e3a62a9bb))
* **golden:** remove disposable Prime image tooling before scan ([77dd4a8](https://github.com/The-Vibe-Company/armada/commit/77dd4a8cd439f8cbf686390ad5ebfee2e8509a1b))
* **golden:** remove disposable Prime image tooling before scan ([#554](https://github.com/The-Vibe-Company/armada/issues/554)) ([b6c972f](https://github.com/The-Vibe-Company/armada/commit/b6c972f66bcda7cdb5b9910eb9d91db5c691b406))
* **golden:** report capacity conflicts as 409 ([6a69088](https://github.com/The-Vibe-Company/armada/commit/6a690880f22251752a3293a92cc0da15736c0d68))
* **golden:** report capacity conflicts as 409 ([01c831e](https://github.com/The-Vibe-Company/armada/commit/01c831e161ed6aaacb5555f93f472e0bc811be72))
* **golden:** retain last-good snapshots during rebuild ([51d2bb6](https://github.com/The-Vibe-Company/armada/commit/51d2bb6f7f43485e89aeb6c7a8f74cac029b176d))
* **golden:** retain last-good snapshots during rebuild ([aa735b5](https://github.com/The-Vibe-Company/armada/commit/aa735b5ad741f09ec37397263100dc1de96c1ee4))
* **golden:** safely bind a canonical Boat golden ([d915fc1](https://github.com/The-Vibe-Company/armada/commit/d915fc13a3c64d6c2320b4b055336770892d0882))
* **golden:** safely bind a canonical Boat golden ([1fbcc28](https://github.com/The-Vibe-Company/armada/commit/1fbcc280e8ae50f78f127d23c6c5a70fc197ca98))
* **golden:** scrub credential residue and redact scan diagnostics ([c3d4d10](https://github.com/The-Vibe-Company/armada/commit/c3d4d1042bca8d6adab5df46efe39b0174e12522))
* **golden:** scrub credential residue and redact scan diagnostics ([#552](https://github.com/The-Vibe-Company/armada/issues/552)) ([a33fb6a](https://github.com/The-Vibe-Company/armada/commit/a33fb6a0cff1d6acfda39a295668cda7410d0f8c))
* **golden:** scrub disposable builder histories before scanning ([b3f9422](https://github.com/The-Vibe-Company/armada/commit/b3f942236e9568ae295edbd6ac9506f8ce6b08b7))
* **golden:** scrub disposable builder histories before scanning ([#553](https://github.com/The-Vibe-Company/armada/issues/553)) ([60ebd23](https://github.com/The-Vibe-Company/armada/commit/60ebd238da5fbeae0ceb6f0e4f41f1219fa55973))

## [2.4.0](https://github.com/The-Vibe-Company/armada/compare/v2.3.0...v2.4.0) (2026-11-08)


### Features

* **dashboard:** manage multi-repo golden and launch workdir ([40f5a6d](https://github.com/The-Vibe-Company/armada/commit/40f5a6db6ec3b3fbc84770d54c7b37758b2c863b))
* **dashboard:** manage multi-repo golden and launch workdir ([fc76b05](https://github.com/The-Vibe-Company/armada/commit/fc76b055851ee24ebd21a6cb9693dc588b811aef))
* **golden:** expose authenticated backend capabilities ([59abcab](https://github.com/The-Vibe-Company/armada/commit/59abcab5d9512eea519f8587003933331171afaf))
* **golden:** expose authenticated backend capabilities ([d725371](https://github.com/The-Vibe-Company/armada/commit/d725371c79f30b68ce6a8b8e852a2baed63cb9f9))


### Bug Fixes

* **dashboard:** read golden capacity from the control API, not the Boat adapter ([f5cbca3](https://github.com/The-Vibe-Company/armada/commit/f5cbca3acbfb7350ad88fe9a5bd39426dcf2827d))
* **goldens:** execute SSH stdin setup through bash ([d68402f](https://github.com/The-Vibe-Company/armada/commit/d68402f2745e8143e9876e76ee15ce3564dfb9f3))
* **launch:** enforce selected repo in native harness session ([3508106](https://github.com/The-Vibe-Company/armada/commit/350810668cbbd0de554ab860af4a03e8ce550053))
* **launch:** enforce selected repo in native harness session ([37e7015](https://github.com/The-Vibe-Company/armada/commit/37e701518fdd78b334b626adb28be3dd851b5190))

## [2.3.0](https://github.com/The-Vibe-Company/armada/compare/v2.2.0...v2.3.0) (2026-11-08)


### Features

* **core:** prepare selected repository cwd during launch ([ee060a1](https://github.com/The-Vibe-Company/armada/commit/ee060a1067a9cf3b738c652249f170afb14f8ccc))
* **launch:** expose selected golden repository across launch surfaces ([e6b48af](https://github.com/The-Vibe-Company/armada/commit/e6b48afdcaddba4d209baee469067c35e51cd36e))
* **launch:** start native agents in selected golden repository ([dee0078](https://github.com/The-Vibe-Company/armada/commit/dee00781c06adf742b182698fdc6375711c2e955))


### Bug Fixes

* **api:** forward CLI and MCP operations through Armada URL ([5e0e001](https://github.com/The-Vibe-Company/armada/commit/5e0e001b4316bf2f3ecc5600a2fcb6d75e6dbcc2))
* **api:** forward sandbox and MCP operations through dashboard origin ([403e38b](https://github.com/The-Vibe-Company/armada/commit/403e38b460337158fe8239c4eff8e8dd913fd9cb))

## [2.2.0](https://github.com/The-Vibe-Company/armada/compare/v2.1.0...v2.2.0) (2026-11-08)


### Features

* **sandboxes:** add provider identity and configurable launch models ([f641d78](https://github.com/The-Vibe-Company/armada/commit/f641d7829b3cb730ddf327cbbc751bd5e837e1a5))
* **sandboxes:** integrate provider identity and model selection with API-only CLI ([6ee1032](https://github.com/The-Vibe-Company/armada/commit/6ee1032210f7fd0ce36b4702f5f6df00522d8795))
* **sandboxes:** reconcile model and provider changes with current API ([216f0ac](https://github.com/The-Vibe-Company/armada/commit/216f0ac72421a6749bc4edef1638370290efc915))


### Bug Fixes

* **api:** allow bearer clients through dashboard middleware ([6573c8e](https://github.com/The-Vibe-Company/armada/commit/6573c8e208071c7318b7b2acfff8b475305de73b))
* **api:** allow bearer clients through dashboard middleware ([7fc6cfd](https://github.com/The-Vibe-Company/armada/commit/7fc6cfd23424e238071fc62182bce9b52f9ddc29))
* **cli:** decode launch API wire dates ([d54df7f](https://github.com/The-Vibe-Company/armada/commit/d54df7f2eafd88095073eeb70865f10c4551c48b))
* **cli:** decode launch API wire dates ([28e0a14](https://github.com/The-Vibe-Company/armada/commit/28e0a14ffcb02a89afb17172fd4b6a7c9f609bfa))
* **cli:** preserve launch wire decoding during model integration ([f40397c](https://github.com/The-Vibe-Company/armada/commit/f40397c10f72b7160d0d65b33523cc896a7ea2b8))
* **logs:** carry API cursor across follow requests ([60957ad](https://github.com/The-Vibe-Company/armada/commit/60957ad1160d1e1c57bd99d05492b60b68f5560f))
* **logs:** carry API cursor across follow requests ([06c1f51](https://github.com/The-Vibe-Company/armada/commit/06c1f515e3f4f04308de7f0d2c43ba96f8d4917d))
* **logs:** drain follow cursors safely ([c1dcc47](https://github.com/The-Vibe-Company/armada/commit/c1dcc47799f4d4066bb38a9686df8c39052d2c7f))
* **logs:** retain API cursor across empty batches ([9e61f41](https://github.com/The-Vibe-Company/armada/commit/9e61f41e5d553f98757a7cf8420e3cc23ec1e964))

## [2.1.0](https://github.com/The-Vibe-Company/armada/compare/v2.0.2...v2.1.0) (2026-11-08)


### Features

* **cli:** add API-backed golden update command ([114e4c4](https://github.com/The-Vibe-Company/armada/commit/114e4c4616d0ffc0980f27e95b39222cf4c85900))
* **cli:** add Armada browser login helper ([ab4dac2](https://github.com/The-Vibe-Company/armada/commit/ab4dac251a7ad736f3d451da9a1ca2767796eb70))
* **cli:** route email login through Armada API ([77f3819](https://github.com/The-Vibe-Company/armada/commit/77f3819e7d1a37061ef40e5be98b8daa2d881ca9))
* **cli:** route token commands through Armada API ([00ef1e3](https://github.com/The-Vibe-Company/armada/commit/00ef1e330dbf03d20b4d38b9bc4c65341bd885b4))
* **cli:** snapshot goldens through Armada API ([362c1a6](https://github.com/The-Vibe-Company/armada/commit/362c1a67b21817d3f7ef29752bb3f59094a0fa85))
* **cli:** use Armada hosted browser login ([b6e3368](https://github.com/The-Vibe-Company/armada/commit/b6e3368323ee0f12ea0490d6450d9d83bf3f51d9))
* **core:** update existing golden builds in place ([c794c76](https://github.com/The-Vibe-Company/armada/commit/c794c76a8043a087d294ebc5b7beb69ff64386af))
* **core:** validate existing golden build context ([2daa11b](https://github.com/The-Vibe-Company/armada/commit/2daa11b6eb5a13e7783e2801025c17d2217b2a38))
* **dashboard:** switch the active organization ([#517](https://github.com/The-Vibe-Company/armada/issues/517)) ([600b3eb](https://github.com/The-Vibe-Company/armada/commit/600b3eb06820eeeb0ab1e7770f6bc9590185c1cb))
* **server:** add golden snapshot API route ([f5ab27f](https://github.com/The-Vibe-Company/armada/commit/f5ab27f7a110ca7fd356ac4f08a2d78532b00799))
* **server:** add hosted browser authorization route ([fce1307](https://github.com/The-Vibe-Company/armada/commit/fce1307a5042506f77a87b4438b98e6d563eebcd))
* **server:** create scoped service tokens over control API ([eea783a](https://github.com/The-Vibe-Company/armada/commit/eea783a4178a37a484e2879f7aee0917ac802668))
* **server:** exchange browser login codes through control API ([9e5b4eb](https://github.com/The-Vibe-Company/armada/commit/9e5b4eb11eb47eb66e5c3b11d8ec9467012aab53))
* **server:** expose golden update control route ([db02f76](https://github.com/The-Vibe-Company/armada/commit/db02f761d5d5b28f39999bdce981f6a83c3abe18))
* **server:** list scoped service tokens over control API ([274ac59](https://github.com/The-Vibe-Company/armada/commit/274ac59d9b409ed19550a6f325f76d12a6d822bc))
* **server:** refresh native sessions through control API ([dd20ca5](https://github.com/The-Vibe-Company/armada/commit/dd20ca5b89a275400458fd8e3ce3816d9c2bd3b7))
* **server:** revoke scoped service tokens over control API ([aeefb6c](https://github.com/The-Vibe-Company/armada/commit/aeefb6c3d93d3963534ee47f129c77bc9a499046))
* **server:** start email login through control API ([16d5757](https://github.com/The-Vibe-Company/armada/commit/16d5757776c59ae605c19fd88568c96506974c4e))
* **server:** verify email login through control API ([935d07f](https://github.com/The-Vibe-Company/armada/commit/935d07ff886b2915145611c39cc7ce8be4efde31))


### Bug Fixes

* **cli:** refresh sessions through Armada API ([10736d6](https://github.com/The-Vibe-Company/armada/commit/10736d6c232a1c1b2ca09a5d6ab2bfe1aa2e7a3e))
* **cli:** reject invalid browser callbacks promptly ([4847d01](https://github.com/The-Vibe-Company/armada/commit/4847d012514a5100b1421b748d576b1de274de34))
* **cli:** ship API-only client and standalone server ([fd35cb9](https://github.com/The-Vibe-Company/armada/commit/fd35cb91cbee8117e62d3a5e598d07e15d71bc2d))
* **cli:** validate API-only auth login fixtures ([19dc9b0](https://github.com/The-Vibe-Company/armada/commit/19dc9b05ece4c361395e52a823b4527ec3584180))
* **core:** constrain golden clone credential helper ([cc25bc6](https://github.com/The-Vibe-Company/armada/commit/cc25bc664356ffb3f860222da6fa23a219108d16))
* **core:** persist provider golden snapshot identifiers ([089f826](https://github.com/The-Vibe-Company/armada/commit/089f82615f1078a62b63e258d81bd719bf870fa6))
* **dashboard:** align control proxy authorization ([a011153](https://github.com/The-Vibe-Company/armada/commit/a01115312e326a514310ffca64f707e4ffdd600f))
* **db:** invoke backend slot routines as caller ([5fb1f6b](https://github.com/The-Vibe-Company/armada/commit/5fb1f6b8b32df2811ad24b88be10b38a9291cae0))
* **server:** scope OAuth token API access ([bd853db](https://github.com/The-Vibe-Company/armada/commit/bd853db9d237220f9e5a1a9e24048809979ae215))

## [2.0.2](https://github.com/The-Vibe-Company/armada/compare/v2.0.1...v2.0.2) (2026-11-08)


### Bug Fixes

* **release:** wait for registry binaries before publishing CLI ([#506](https://github.com/The-Vibe-Company/armada/issues/506)) ([1e3e367](https://github.com/The-Vibe-Company/armada/commit/1e3e367f21eee4b8485ba714e391e509a115189a))

## [2.0.1](https://github.com/The-Vibe-Company/armada/compare/v2.0.0...v2.0.1) (2026-11-08)


### Bug Fixes

* **release:** handle release creation without a following PR ([#503](https://github.com/The-Vibe-Company/armada/issues/503)) ([ab825bc](https://github.com/The-Vibe-Company/armada/commit/ab825bcc6a0084145b6571db2b0399f0f8fc0d70))

## [2.0.0](https://github.com/The-Vibe-Company/armada/compare/v2.0.0-alpha.0...v2.0.0) (2026-11-08)


### Features

* **release:** automate v2 CLI publication with Release Please ([e879baf](https://github.com/The-Vibe-Company/armada/commit/e879baf5cce49a79a728f23917ccb32253bfdaf6))
