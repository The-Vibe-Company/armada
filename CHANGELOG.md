# Changelog

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
