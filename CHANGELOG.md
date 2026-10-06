# Changelog

## [0.2.58](https://github.com/The-Vibe-Company/armada/compare/v0.2.57...v0.2.58) (2026-10-06)


### Features

* **deploy:** check only targets touched by a merge ([#269](https://github.com/The-Vibe-Company/armada/issues/269)) ([78e0816](https://github.com/The-Vibe-Company/armada/commit/78e0816e61706d3a4c9f4afc260e7515923a1ff0))


### Bug Fixes

* **test:** pin dashboard browser to Playwright (THE-1185) ([#266](https://github.com/The-Vibe-Company/armada/issues/266)) ([d14ffe2](https://github.com/The-Vibe-Company/armada/commit/d14ffe2152e6921c3768758050ec0b96db7988dd))

## [0.2.57](https://github.com/The-Vibe-Company/armada/compare/v0.2.56...v0.2.57) (2026-10-06)


### Features

* **cli:** check worker Git access after claim ([#255](https://github.com/The-Vibe-Company/armada/issues/255)) ([051b211](https://github.com/The-Vibe-Company/armada/commit/051b211af5010e77f7d41d6459e220487629cc1d))
* **cli:** deliver answers and notes to Conductor workers ([#218](https://github.com/The-Vibe-Company/armada/issues/218)) ([b133480](https://github.com/The-Vibe-Company/armada/commit/b1334802cf4bdcc60cd28e5970065ca98fe3cb5f))
* **cli:** drain queued pull requests one at a time ([#256](https://github.com/The-Vibe-Company/armada/issues/256)) ([ac7b4fb](https://github.com/The-Vibe-Company/armada/commit/ac7b4fb4370fdfbbbe506c06185266f065f540e6))
* **cli:** notify only workers affected by a merge ([#229](https://github.com/The-Vibe-Company/armada/issues/229)) ([30ea818](https://github.com/The-Vibe-Company/armada/commit/30ea8181d844c6444a7f2f8b9976fe63d2117ae6))
* **cli:** relaunch a ticket's worker in one command ([#227](https://github.com/The-Vibe-Company/armada/issues/227)) ([c92ce4b](https://github.com/The-Vibe-Company/armada/commit/c92ce4bba0d02637e69b87e7cc3b557c9d2d66d8))
* **cli:** require live acceptance checks before hand-back ([#240](https://github.com/The-Vibe-Company/armada/issues/240)) ([8a1e3ad](https://github.com/The-Vibe-Company/armada/commit/8a1e3ad3a97f308a8402121f917a73caec0c5900))
* **core:** close finished specs after ticket closure ([#251](https://github.com/The-Vibe-Company/armada/issues/251)) ([582aaf2](https://github.com/The-Vibe-Company/armada/commit/582aaf2cca99c354192b42dc676ae5c0effb5824))
* **core:** notify coordinators when merges unblock work ([#244](https://github.com/The-Vibe-Company/armada/issues/244)) ([422e4d8](https://github.com/The-Vibe-Company/armada/commit/422e4d8c0eee9893bc269fd587f8471acd38f8fc))
* **core:** pause merges when main turns red ([#265](https://github.com/The-Vibe-Company/armada/issues/265)) ([a0db234](https://github.com/The-Vibe-Company/armada/commit/a0db234d6025c03334a0d274f5b54d8945f32c83))
* **dashboard:** decide validations from the keyboard ([#253](https://github.com/The-Vibe-Company/armada/issues/253)) ([a2457ee](https://github.com/The-Vibe-Company/armada/commit/a2457eeea2c21f04504cfe8adb48acebe19ace96))
* **dashboard:** show paused merges and deploy state ([#248](https://github.com/The-Vibe-Company/armada/issues/248)) ([9cd474b](https://github.com/The-Vibe-Company/armada/commit/9cd474b0443cc75ef77f1acc7d414f28176e0435))
* **dashboard:** show the merge queue and wake the coordinator when it is stuck ([#263](https://github.com/The-Vibe-Company/armada/issues/263)) ([cc2e567](https://github.com/The-Vibe-Company/armada/commit/cc2e56780cd8749eb8ef2b18fdf922e1878b0e60))
* **doctor:** check unattended commit signing ([#247](https://github.com/The-Vibe-Company/armada/issues/247)) ([dd012c8](https://github.com/The-Vibe-Company/armada/commit/dd012c807ff2d777c45d0d53b6377502b83a16ef))
* **jobs:** warn when long jobs go silent or end ([#246](https://github.com/The-Vibe-Company/armada/issues/246)) ([c0a4bd2](https://github.com/The-Vibe-Company/armada/commit/c0a4bd23ee73d1d213c3f5bfa926e96653857000))
* **merge:** keep tickets open between pull requests ([#242](https://github.com/The-Vibe-Company/armada/issues/242)) ([0596e69](https://github.com/The-Vibe-Company/armada/commit/0596e69b085840ef680e5345a9a1ca3a02d9c8a6))
* **secrets:** request missing worker secrets by owner link ([#249](https://github.com/The-Vibe-Company/armada/issues/249)) ([8ce4fb4](https://github.com/The-Vibe-Company/armada/commit/8ce4fb4629c39057689b417c62449be584d69ba1))
* **setup:** help projects adopt optional Armada features ([#257](https://github.com/The-Vibe-Company/armada/issues/257)) ([ba464b1](https://github.com/The-Vibe-Company/armada/commit/ba464b15d8165e8d44680b29e6315e2831dcf109))


### Bug Fixes

* **ci:** declare dashboard Chrome startup flake (THE-1185) ([#267](https://github.com/The-Vibe-Company/armada/issues/267)) ([90a13b7](https://github.com/The-Vibe-Company/armada/commit/90a13b7a900df2be0e32815f399905038ae460ea))
* **cli:** capture Conductor responses without pipe truncation ([#261](https://github.com/The-Vibe-Company/armada/issues/261)) ([4235354](https://github.com/The-Vibe-Company/armada/commit/4235354cb185509a02207a3225f962de98ceca97))
* **core:** keep spec closure failures out of Linear pending ([#254](https://github.com/The-Vibe-Company/armada/issues/254)) ([ba99dce](https://github.com/The-Vibe-Company/armada/commit/ba99dce736039e88de94b482ad96b318c2f8e1d4))
* **core:** raise silence alarms only for active worker claims ([#245](https://github.com/The-Vibe-Company/armada/issues/245)) ([f0dad5c](https://github.com/The-Vibe-Company/armada/commit/f0dad5c27f8ef1889451b17d5d0cf1a405a2750a))
* **jobs:** keep worker results out of the coordinator inbox ([#260](https://github.com/The-Vibe-Company/armada/issues/260)) ([4f2ebeb](https://github.com/The-Vibe-Company/armada/commit/4f2ebeb1b11bebb9db1d7d9791e90519fd1b7fe4))
* **tests:** apply audited consolidations and repair keeper proofs (THE-1146) ([#262](https://github.com/The-Vibe-Company/armada/issues/262)) ([fa87d96](https://github.com/The-Vibe-Company/armada/commit/fa87d968caf7bc839a829ba33a2769e660b57c48))
* **workers:** proceed through shared-file overlaps without asking ([#234](https://github.com/The-Vibe-Company/armada/issues/234)) ([ae859a5](https://github.com/The-Vibe-Company/armada/commit/ae859a5a9231909f84682db6c3784657715ea98b))

## [0.2.56](https://github.com/The-Vibe-Company/armada/compare/v0.2.55...v0.2.56) (2026-10-06)


### Features

* **ci:** explain failed checks and runner problems ([#208](https://github.com/The-Vibe-Company/armada/issues/208)) ([0ab9035](https://github.com/The-Vibe-Company/armada/commit/0ab90352346e6267e7ebcfdac1cd0580c3165a7c))
* **ci:** release Armada on a weekday train ([#199](https://github.com/The-Vibe-Company/armada/issues/199)) ([d9d4372](https://github.com/The-Vibe-Company/armada/commit/d9d43728d0fede34ca87491e2458d2263e46d8bc))
* **ci:** rerun tracked flaky failures once per workflow ([#230](https://github.com/The-Vibe-Company/armada/issues/230)) ([daf007f](https://github.com/The-Vibe-Company/armada/commit/daf007fe63350fc6dba9d55d01379349efaaf2fc))
* **cli:** add specs without renaming every other spec ([#206](https://github.com/The-Vibe-Company/armada/issues/206)) ([6f544bb](https://github.com/The-Vibe-Company/armada/commit/6f544bbaa3793f65729ccdbe27698de2e0ce6674))
* **cli:** announce releases without stopping ordinary watches ([#231](https://github.com/The-Vibe-Company/armada/issues/231)) ([07b419b](https://github.com/The-Vibe-Company/armada/commit/07b419b9723b2addb682c88079c9707a6531e0ca))
* **cli:** archive workers after confirmed merges ([#214](https://github.com/The-Vibe-Company/armada/issues/214)) ([69c173f](https://github.com/The-Vibe-Company/armada/commit/69c173f73121aea4bbe602fc774401a07bcda351))
* **cli:** check repository identity in armada doctor ([#196](https://github.com/The-Vibe-Company/armada/issues/196)) ([9e77a9f](https://github.com/The-Vibe-Company/armada/commit/9e77a9f875c031739f85d270192dbc9dc0bd3d7e))
* **cli:** check ticket readability before launch ([#238](https://github.com/The-Vibe-Company/armada/issues/238)) ([f5ff024](https://github.com/The-Vibe-Company/armada/commit/f5ff0247312ef651d27490351649a48ea240a91e))
* **cli:** deliver Armada instructions from the installed version ([#220](https://github.com/The-Vibe-Company/armada/issues/220)) ([f331c62](https://github.com/The-Vibe-Company/armada/commit/f331c6232c77f0bd7db9411e1a653868de4ab0ac))
* **cli:** follow fleet events as a resumable stream ([#221](https://github.com/The-Vibe-Company/armada/issues/221)) ([7c649cc](https://github.com/The-Vibe-Company/armada/commit/7c649ccf80d9142766067c980cba6b3549ed0d14))
* **cli:** launch Conductor workers with one Armada command ([#215](https://github.com/The-Vibe-Company/armada/issues/215)) ([b461baa](https://github.com/The-Vibe-Company/armada/commit/b461baafcf8699c63f9e0c786ccdb4b9c4c71d86))
* **cli:** launch tickets when all blockers close ([#226](https://github.com/The-Vibe-Company/armada/issues/226)) ([5a3a7f9](https://github.com/The-Vibe-Company/armada/commit/5a3a7f96a08f75549650237875086c19f6aca6f0))
* **cli:** list tickets unblocked by a merge ([#198](https://github.com/The-Vibe-Company/armada/issues/198)) ([6fb8402](https://github.com/The-Vibe-Company/armada/commit/6fb8402fa7f9c580712024070fe27f7b1c5be157))
* **cli:** pre-approve plans at launch ([#200](https://github.com/The-Vibe-Company/armada/issues/200)) ([5f634f2](https://github.com/The-Vibe-Company/armada/commit/5f634f2b823c3d51b58089b286f3ea60f34ec031))
* **cli:** reserve shared names and numbers for a ticket ([#216](https://github.com/The-Vibe-Company/armada/issues/216)) ([e63072e](https://github.com/The-Vibe-Company/armada/commit/e63072e19432e4e7a5d9a9f1df5fea02c16320e3))
* **cli:** reuse one Armada setup pull request per project ([#209](https://github.com/The-Vibe-Company/armada/issues/209)) ([2470725](https://github.com/The-Vibe-Company/armada/commit/24707254ff264945ae7a505d2c0ca5fb7d3f29d8))
* **cli:** run coordinator commands from any folder ([#205](https://github.com/The-Vibe-Company/armada/issues/205)) ([17aff17](https://github.com/The-Vibe-Company/armada/commit/17aff17b5732a06d6ef45d348dada9b71836e3e5))
* **cli:** scope named coordinators to their own work ([#243](https://github.com/The-Vibe-Company/armada/issues/243)) ([a5823d8](https://github.com/The-Vibe-Company/armada/commit/a5823d8d204053cacd7e3d1942a6b43eac6c77bf))
* **cli:** see what workers are doing with armada peek ([#217](https://github.com/The-Vibe-Company/armada/issues/217)) ([8a8246d](https://github.com/The-Vibe-Company/armada/commit/8a8246ded1f933e854d4739a3941239428dc43aa))
* **cli:** warn workers when planned paths overlap files in flight ([#223](https://github.com/The-Vibe-Company/armada/issues/223)) ([ccc3133](https://github.com/The-Vibe-Company/armada/commit/ccc313338338b86487a017a91c310d47aa09fa56))
* **dashboard:** send owner alerts to a chat webhook ([#212](https://github.com/The-Vibe-Company/armada/issues/212)) ([47b62cf](https://github.com/The-Vibe-Company/armada/commit/47b62cfaa5c0e11675481554a319569566861da7))
* **dashboard:** send scheduled owner fleet digests ([#225](https://github.com/The-Vibe-Company/armada/issues/225)) ([c42c298](https://github.com/The-Vibe-Company/armada/commit/c42c29830c8df814f2d67d891b911b7b37270ad1))
* **dashboard:** show a ticket's long jobs on its session page and the overview ([#235](https://github.com/The-Vibe-Company/armada/issues/235)) ([141e2d7](https://github.com/The-Vibe-Company/armada/commit/141e2d73ca4a00f966face4e925659f2b511aeee))
* **dashboard:** show which coordinator owns each session ([#241](https://github.com/The-Vibe-Company/armada/issues/241)) ([783cc8d](https://github.com/The-Vibe-Company/armada/commit/783cc8dd27f78489fb75a143edebfefd69cdfbb6))
* **deploy:** check merged deploys and pause on failure ([#237](https://github.com/The-Vibe-Company/armada/issues/237)) ([4fb1977](https://github.com/The-Vibe-Company/armada/commit/4fb197721bc05993e07acd935c9697b40741daf4))
* **doctor:** check GitHub branch rules for merge compatibility ([#236](https://github.com/The-Vibe-Company/armada/issues/236)) ([00e6f15](https://github.com/The-Vibe-Company/armada/commit/00e6f156f17c61412181ddfd528549978bc706d4))
* **fleet:** check Conductor sessions before silence alarms ([#213](https://github.com/The-Vibe-Company/armada/issues/213)) ([df8f084](https://github.com/The-Vibe-Company/armada/commit/df8f08463e27281053be5d23bfb832d13f592d15))
* **fleet:** name coordinators and preserve launch ownership ([#228](https://github.com/The-Vibe-Company/armada/issues/228)) ([0dfebf3](https://github.com/The-Vibe-Company/armada/commit/0dfebf34fb6dd73a76906cdbc1bed47cffb30cd8))
* **fleet:** show when main is red and which merge broke it ([#204](https://github.com/The-Vibe-Company/armada/issues/204)) ([11ee2fa](https://github.com/The-Vibe-Company/armada/commit/11ee2fa3fdbf9c3591bfe5a61882bf05bc6c96bf))
* **jobs:** track long jobs on project runners ([#219](https://github.com/The-Vibe-Company/armada/issues/219)) ([4322b3a](https://github.com/The-Vibe-Company/armada/commit/4322b3ae6e2a018004eba1dfbc7d6864d323241e))
* **merge:** keep a durable merge queue across sessions ([#222](https://github.com/The-Vibe-Company/armada/issues/222)) ([e659746](https://github.com/The-Vibe-Company/armada/commit/e65974607c6f48e9a1d8f2c532a8c2819c12a4a0))
* **merge:** pause project merges with reasoned holds ([#207](https://github.com/The-Vibe-Company/armada/issues/207)) ([acd71e7](https://github.com/The-Vibe-Company/armada/commit/acd71e79be78be71c7dc1fcf6df36f163976f748))
* **runtime:** unify Conductor and herdr worker adapters ([#202](https://github.com/The-Vibe-Company/armada/issues/202)) ([db6dbb9](https://github.com/The-Vibe-Company/armada/commit/db6dbb935cf445f763ee134e97ba14ee94c897ff))
* **secrets:** mask worker output and messages ([#239](https://github.com/The-Vibe-Company/armada/issues/239)) ([fceaf43](https://github.com/The-Vibe-Company/armada/commit/fceaf433c07348cf58635b5c3a7d6a7fd27eef94))
* **validations:** ask short owner questions with sampled evidence ([#224](https://github.com/The-Vibe-Company/armada/issues/224)) ([843c866](https://github.com/The-Vibe-Company/armada/commit/843c866c9bb86201c2b80eba154d5a8296520637))
* **workers:** persist launched worker runtime sessions ([#211](https://github.com/The-Vibe-Company/armada/issues/211)) ([2d68929](https://github.com/The-Vibe-Company/armada/commit/2d6892992346dc13994fdb6d880e21ae8dc845a1))


### Bug Fixes

* **cli:** quiet repeated Armada keys fallback warnings ([#203](https://github.com/The-Vibe-Company/armada/issues/203)) ([7ac768a](https://github.com/The-Vibe-Company/armada/commit/7ac768a891dd1e3d5f0c4965281df700e8af8446))
* **cli:** refuse hand-backs with unresolved review threads ([#194](https://github.com/The-Vibe-Company/armada/issues/194)) ([f4a1a76](https://github.com/The-Vibe-Company/armada/commit/f4a1a76e02c5de35a6a811c535bb1744a7a2963d))
* **core:** create configured plan labels during init ([#233](https://github.com/The-Vibe-Company/armada/issues/233)) ([374bf6a](https://github.com/The-Vibe-Company/armada/commit/374bf6a867149f0927d2154161aa88fcaa673670))
* **core:** finish confirmed merges during Linear outages ([#232](https://github.com/The-Vibe-Company/armada/issues/232)) ([f2f08c8](https://github.com/The-Vibe-Company/armada/commit/f2f08c881286bc1e8cf02f36f85f60cb2d0d6f95))
* **core:** retry temporary Linear, GitHub and Armada failures ([#210](https://github.com/The-Vibe-Company/armada/issues/210)) ([527a4ee](https://github.com/The-Vibe-Company/armada/commit/527a4ee317b38df10e504c5b8ee2e41ba8fd907e))
* **worker:** preserve replacement claims and sessions on release ([#201](https://github.com/The-Vibe-Company/armada/issues/201)) ([81a8145](https://github.com/The-Vibe-Company/armada/commit/81a8145f762f79a50b8fa883a66c49e6558ce563))

## [0.2.55](https://github.com/The-Vibe-Company/armada/compare/v0.2.54...v0.2.55) (2026-10-05)


### Bug Fixes

* **dashboard:** drop unused saved views table ([#190](https://github.com/The-Vibe-Company/armada/issues/190)) ([b7569bd](https://github.com/The-Vibe-Company/armada/commit/b7569bd15b239c6a72c61a8e0c95828eae58f9ac))

## [0.2.54](https://github.com/The-Vibe-Company/armada/compare/v0.2.53...v0.2.54) (2026-10-04)


### Features

* **dashboard:** rebuild the other pages on the sober v7 design ([#188](https://github.com/The-Vibe-Company/armada/issues/188)) ([2450f9b](https://github.com/The-Vibe-Company/armada/commit/2450f9b350742f9b65d005f544b0eddad20226a9))

## [0.2.53](https://github.com/The-Vibe-Company/armada/compare/v0.2.52...v0.2.53) (2026-10-04)


### Features

* **dashboard:** rebuild the shell and overview on the sober v7 design ([#186](https://github.com/The-Vibe-Company/armada/issues/186)) ([5cedf6e](https://github.com/The-Vibe-Company/armada/commit/5cedf6eeeb2c0f8cc803f964b633de2df3796540))

## [0.2.52](https://github.com/The-Vibe-Company/armada/compare/v0.2.51...v0.2.52) (2026-10-03)


### Features

* **dashboard:** show the board as Plan, Implementing, Code Review, CI, Merged ([#182](https://github.com/The-Vibe-Company/armada/issues/182)) ([466bd42](https://github.com/The-Vibe-Company/armada/commit/466bd42a88ff3e113630ab33efe2545989c2cc8f))

## [0.2.51](https://github.com/The-Vibe-Company/armada/compare/v0.2.50...v0.2.51) (2026-10-03)


### Bug Fixes

* **cli:** avoid stale HTTP connections and retry safe reads ([#181](https://github.com/The-Vibe-Company/armada/issues/181)) ([757d17d](https://github.com/The-Vibe-Company/armada/commit/757d17dfb723d7774f31225233dd8008637880a5))

## [0.2.50](https://github.com/The-Vibe-Company/armada/compare/v0.2.49...v0.2.50) (2026-10-03)


### Features

* **fleet:** distinguish code review from CI while shipping ([#176](https://github.com/The-Vibe-Company/armada/issues/176)) ([1249b4c](https://github.com/The-Vibe-Company/armada/commit/1249b4c6b8007b6b4bc46f4da959e830fcced7ce))

## [0.2.49](https://github.com/The-Vibe-Company/armada/compare/v0.2.48...v0.2.49) (2026-10-03)


### Features

* **merge:** leave ticket open with a no-ticket reason ([#177](https://github.com/The-Vibe-Company/armada/issues/177)) ([a3d8ff7](https://github.com/The-Vibe-Company/armada/commit/a3d8ff76b615bd9fedcfed079b79abec22d226f0))

## [0.2.48](https://github.com/The-Vibe-Company/armada/compare/v0.2.47...v0.2.48) (2026-10-03)


### Bug Fixes

* **cli:** restore herdr worker names lost during startup ([#173](https://github.com/The-Vibe-Company/armada/issues/173)) ([89d50e8](https://github.com/The-Vibe-Company/armada/commit/89d50e844f9dbdba4bc25ef9e20fcf3eebec9c85))

## [0.2.47](https://github.com/The-Vibe-Company/armada/compare/v0.2.46...v0.2.47) (2026-10-03)


### Features

* **cli:** preview a local launch without creating anything ([#169](https://github.com/The-Vibe-Company/armada/issues/169)) ([c6313be](https://github.com/The-Vibe-Company/armada/commit/c6313bec129549a4db8d4798e60b67c2e29c6924))

## [0.2.46](https://github.com/The-Vibe-Company/armada/compare/v0.2.45...v0.2.46) (2026-10-03)


### Features

* **cli:** set up local harnesses and explain first-run questions ([#160](https://github.com/The-Vibe-Company/armada/issues/160)) ([a32c262](https://github.com/The-Vibe-Company/armada/commit/a32c262df2db197f613c2948609f30206dce5a05))

## [0.2.45](https://github.com/The-Vibe-Company/armada/compare/v0.2.44...v0.2.45) (2026-10-03)


### Bug Fixes

* **core:** renew worker liveness after waiting turns ([#161](https://github.com/The-Vibe-Company/armada/issues/161)) ([9ced0b7](https://github.com/The-Vibe-Company/armada/commit/9ced0b7d36d55b5ed5b123258a961532eb604d8b))

## [0.2.44](https://github.com/The-Vibe-Company/armada/compare/v0.2.43...v0.2.44) (2026-10-03)


### Bug Fixes

* **cli:** recognize OpenCode model and provider footer names ([#165](https://github.com/The-Vibe-Company/armada/issues/165)) ([048492d](https://github.com/The-Vibe-Company/armada/commit/048492d0ea484b9b6d910f8a720fb5b48ed93a77))

## [0.2.43](https://github.com/The-Vibe-Company/armada/compare/v0.2.42...v0.2.43) (2026-10-03)


### Bug Fixes

* **cli:** verify local profile models in doctor ([#156](https://github.com/The-Vibe-Company/armada/issues/156)) ([82518f4](https://github.com/The-Vibe-Company/armada/commit/82518f463304babbbe76288b44fb4c8949f78ab9))

## [0.2.42](https://github.com/The-Vibe-Company/armada/compare/v0.2.41...v0.2.42) (2026-10-03)


### Bug Fixes

* **cli:** preserve OpenCode and DeepSeek worker models ([#159](https://github.com/The-Vibe-Company/armada/issues/159)) ([0c352ab](https://github.com/The-Vibe-Company/armada/commit/0c352abec10dea83396ebb5a4520dcc92d9472e0))

## [0.2.41](https://github.com/The-Vibe-Company/armada/compare/v0.2.40...v0.2.41) (2026-10-03)


### Bug Fixes

* **core:** keep parked tickets off the frontier ([#155](https://github.com/The-Vibe-Company/armada/issues/155)) ([744aa2b](https://github.com/The-Vibe-Company/armada/commit/744aa2b4d06023e3cadf0df2f4e8d136e4e6ee4d))

## [0.2.40](https://github.com/The-Vibe-Company/armada/compare/v0.2.39...v0.2.40) (2026-10-03)


### Features

* **dashboard:** show each coordinator's sessions as a kanban board ([#154](https://github.com/The-Vibe-Company/armada/issues/154)) ([ec5cd19](https://github.com/The-Vibe-Company/armada/commit/ec5cd1917fd9bbd26a1f6d2ae538a762aa0c179b))


### Bug Fixes

* **dashboard:** allow attachments on fresh program tickets ([#147](https://github.com/The-Vibe-Company/armada/issues/147)) ([a9accb0](https://github.com/The-Vibe-Company/armada/commit/a9accb0c997cad49af2259ea91314d4f71208b41))

## [0.2.39](https://github.com/The-Vibe-Company/armada/compare/v0.2.38...v0.2.39) (2026-10-03)


### Bug Fixes

* **core:** exclude closed tickets from watch flight counts ([#146](https://github.com/The-Vibe-Company/armada/issues/146)) ([7773678](https://github.com/The-Vibe-Company/armada/commit/7773678f5f6f54cf0c655e101197e53449c093b5))

## [0.2.38](https://github.com/The-Vibe-Company/armada/compare/v0.2.37...v0.2.38) (2026-10-03)


### Features

* **cli:** read, answer and safely stop herdr workers ([#143](https://github.com/The-Vibe-Company/armada/issues/143)) ([c811e71](https://github.com/The-Vibe-Company/armada/commit/c811e716f1d3c4c9ce0ac39e8122236583139e8a))

## [0.2.37](https://github.com/The-Vibe-Company/armada/compare/v0.2.36...v0.2.37) (2026-10-03)


### Features

* **cli:** run DeepSeek workers through OpenCode and herdr ([#142](https://github.com/The-Vibe-Company/armada/issues/142)) ([eed501b](https://github.com/The-Vibe-Company/armada/commit/eed501be4b27346c1a4046f5f89d6c252143169a))

## [0.2.36](https://github.com/The-Vibe-Company/armada/compare/v0.2.35...v0.2.36) (2026-10-03)


### Features

* **cli:** launch local workers through herdr ([#140](https://github.com/The-Vibe-Company/armada/issues/140)) ([dc46b9c](https://github.com/The-Vibe-Company/armada/commit/dc46b9cc42994b31abfafcc169291df97c8fecaf))

## [0.2.35](https://github.com/The-Vibe-Company/armada/compare/v0.2.34...v0.2.35) (2026-10-03)


### Features

* **cli:** offer local runtime prerequisite installs ([#138](https://github.com/The-Vibe-Company/armada/issues/138)) ([5a09f2a](https://github.com/The-Vibe-Company/armada/commit/5a09f2ac96a11289651ecc582aab3edb38fb4295))

## [0.2.34](https://github.com/The-Vibe-Company/armada/compare/v0.2.33...v0.2.34) (2026-10-03)


### Features

* **dashboard:** replay the grouped overview in the landing's live demo ([#136](https://github.com/The-Vibe-Company/armada/issues/136)) ([f85d65e](https://github.com/The-Vibe-Company/armada/commit/f85d65eb55228306a3a95934b6e31e9a2c602beb))

## [0.2.33](https://github.com/The-Vibe-Company/armada/compare/v0.2.32...v0.2.33) (2026-10-02)


### Bug Fixes

* **cli:** stop only the current project watch ([#133](https://github.com/The-Vibe-Company/armada/issues/133)) ([c9b594a](https://github.com/The-Vibe-Company/armada/commit/c9b594a280fd6b5121c71d2783373c9577e8db2a))

## [0.2.32](https://github.com/The-Vibe-Company/armada/compare/v0.2.31...v0.2.32) (2026-10-02)


### Features

* **cli:** bundle shipping skills for every managed project ([#131](https://github.com/The-Vibe-Company/armada/issues/131)) ([f645ae6](https://github.com/The-Vibe-Company/armada/commit/f645ae6b036b41502109353bcc640d2f8e14e824))

## [0.2.31](https://github.com/The-Vibe-Company/armada/compare/v0.2.30...v0.2.31) (2026-10-02)


### Features

* **dashboard:** group the overview by coordinator and put what to validate first ([#130](https://github.com/The-Vibe-Company/armada/issues/130)) ([86e5b78](https://github.com/The-Vibe-Company/armada/commit/86e5b78993891eb27150f9697904916972dca62c))

## [0.2.30](https://github.com/The-Vibe-Company/armada/compare/v0.2.29...v0.2.30) (2026-10-02)


### Features

* **dashboard:** build the Night watch look across the dashboard ([#128](https://github.com/The-Vibe-Company/armada/issues/128)) ([8466d22](https://github.com/The-Vibe-Company/armada/commit/8466d22f6066eb5cf173e25acdafcfd6c4b95d2f))

## [0.2.29](https://github.com/The-Vibe-Company/armada/compare/v0.2.28...v0.2.29) (2026-10-02)


### Bug Fixes

* **core:** clear stale hand-backs after pull requests merge ([#126](https://github.com/The-Vibe-Company/armada/issues/126)) ([aba8ff8](https://github.com/The-Vibe-Company/armada/commit/aba8ff8aa83badaf29457d4e4d1a111c3b917497))

## [0.2.28](https://github.com/The-Vibe-Company/armada/compare/v0.2.27...v0.2.28) (2026-10-01)


### Features

* **dashboard:** keep the dashboard fast with budgets checked on every PR ([#119](https://github.com/The-Vibe-Company/armada/issues/119)) ([f46eea4](https://github.com/The-Vibe-Company/armada/commit/f46eea457f3b0faa6f47b86e6b87bc12487b68b3))

## [0.2.27](https://github.com/The-Vibe-Company/armada/compare/v0.2.26...v0.2.27) (2026-10-01)


### Features

* **dashboard:** find any ticket, PR or agent with ⌘K, filter lists in the URL and save views ([#122](https://github.com/The-Vibe-Company/armada/issues/122)) ([a9a2d2b](https://github.com/The-Vibe-Company/armada/commit/a9a2d2bfa70e426ca433ffff90f8f823ccd2c914))
* **dashboard:** show what happened since the owner last looked ([#123](https://github.com/The-Vibe-Company/armada/issues/123)) ([26f528d](https://github.com/The-Vibe-Company/armada/commit/26f528dbd24f5b921f727eeaea9e4fc94abc0764))

## [0.2.26](https://github.com/The-Vibe-Company/armada/compare/v0.2.25...v0.2.26) (2026-10-01)


### Features

* **dashboard:** make every page usable with a keyboard and a screen reader ([#118](https://github.com/The-Vibe-Company/armada/issues/118)) ([f01dcb1](https://github.com/The-Vibe-Company/armada/commit/f01dcb11ea7216ad4d1c3dfdfd9dcc19231583f9))

## [0.2.25](https://github.com/The-Vibe-Company/armada/compare/v0.2.24...v0.2.25) (2026-10-01)


### Features

* **dashboard:** show how fast the fleet ships and where tickets wait on /insights ([#115](https://github.com/The-Vibe-Company/armada/issues/115)) ([9ff52cb](https://github.com/The-Vibe-Company/armada/commit/9ff52cbf51551a323893b98dc820fca93d85c4cc))

## [0.2.24](https://github.com/The-Vibe-Company/armada/compare/v0.2.23...v0.2.24) (2026-10-01)


### Bug Fixes

* **api:** announce CLI releases only after npm serves their tarballs ([#113](https://github.com/The-Vibe-Company/armada/issues/113)) ([61d5b8d](https://github.com/The-Vibe-Company/armada/commit/61d5b8d9d6f3ae39a06d9c57e764f727937df4ba))

## [0.2.23](https://github.com/The-Vibe-Company/armada/compare/v0.2.22...v0.2.23) (2026-10-01)


### Features

* **dashboard:** preload only the Latin cut of Geist and Geist Mono ([#109](https://github.com/The-Vibe-Company/armada/issues/109)) ([377f7ae](https://github.com/The-Vibe-Company/armada/commit/377f7ae6d585b38cb821f9218dc29905c6d6fd63))

## [0.2.22](https://github.com/The-Vibe-Company/armada/compare/v0.2.21...v0.2.22) (2026-10-01)


### Features

* ask the owner to validate only what they want, on one Validations page ([#108](https://github.com/The-Vibe-Company/armada/issues/108)) ([802ceb9](https://github.com/The-Vibe-Company/armada/commit/802ceb924ba5c6a7ba1a0e13ce728dff9033e3d0))

## [0.2.21](https://github.com/The-Vibe-Company/armada/compare/v0.2.20...v0.2.21) (2026-10-01)


### Features

* **dashboard:** a living landing page for signed-out visitors ([#104](https://github.com/The-Vibe-Company/armada/issues/104)) ([79d6c37](https://github.com/The-Vibe-Company/armada/commit/79d6c37c97d72c244ef091b5ad7fde1cbdf4235f))

## [0.2.20](https://github.com/The-Vibe-Company/armada/compare/v0.2.19...v0.2.20) (2026-10-01)


### Features

* **cli:** keep workers alive with background heartbeats ([#105](https://github.com/The-Vibe-Company/armada/issues/105)) ([02e103f](https://github.com/The-Vibe-Company/armada/commit/02e103f9d59e65d71eed87500d6bdc90c4ae47b7))

## [0.2.19](https://github.com/The-Vibe-Company/armada/compare/v0.2.18...v0.2.19) (2026-10-01)


### Features

* **attachments:** let agents privately attach screenshots and links ([#103](https://github.com/The-Vibe-Company/armada/issues/103)) ([d03b5cc](https://github.com/The-Vibe-Company/armada/commit/d03b5cce8750758c22e4736f3f3cd25733c94b86))


### Bug Fixes

* **cli:** mint worker launches only when printing prompts ([#101](https://github.com/The-Vibe-Company/armada/issues/101)) ([fa0bdfc](https://github.com/The-Vibe-Company/armada/commit/fa0bdfcdef511fdd34d4430beb2f71dfa8003c7c))

## [0.2.18](https://github.com/The-Vibe-Company/armada/compare/v0.2.17...v0.2.18) (2026-10-01)


### Features

* **dashboard:** a clear overview and a live fleet that scrolls back 24 h ([#98](https://github.com/The-Vibe-Company/armada/issues/98)) ([01afa00](https://github.com/The-Vibe-Company/armada/commit/01afa00a301cafc6d468df8fb39e9755b45f16bd))

## [0.2.17](https://github.com/The-Vibe-Company/armada/compare/v0.2.16...v0.2.17) (2026-10-01)


### Features

* **cli:** choose worker profiles from plain-language rules ([#96](https://github.com/The-Vibe-Company/armada/issues/96)) ([4eacd91](https://github.com/The-Vibe-Company/armada/commit/4eacd91985917448beb073e8aa3b66095fad8a4c))

## [0.2.16](https://github.com/The-Vibe-Company/armada/compare/v0.2.15...v0.2.16) (2026-10-01)


### Features

* **dashboard:** show the Armada mark as the browser's tab icon ([#94](https://github.com/The-Vibe-Company/armada/issues/94)) ([dc2e74a](https://github.com/The-Vibe-Company/armada/commit/dc2e74a6333a9f15d54f894d44f54d0929aa3a48))

## [0.2.15](https://github.com/The-Vibe-Company/armada/compare/v0.2.14...v0.2.15) (2026-10-01)


### Features

* **dashboard:** restyle the organization and sign-in pages in the v4 look ([#85](https://github.com/The-Vibe-Company/armada/issues/85)) ([c0eaf58](https://github.com/The-Vibe-Company/armada/commit/c0eaf589abeab70a3f001a786fffc8240c9c0dbf))
* **dashboard:** show every agent and each agent's page ([#86](https://github.com/The-Vibe-Company/armada/issues/86)) ([c6298b1](https://github.com/The-Vibe-Company/armada/commit/c6298b182a49291807992658a81404a906d056aa))

## [0.2.14](https://github.com/The-Vibe-Company/armada/compare/v0.2.13...v0.2.14) (2026-10-01)


### Features

* **dashboard:** show the fleet's last hours on a live timeline ([#88](https://github.com/The-Vibe-Company/armada/issues/88)) ([1e6da14](https://github.com/The-Vibe-Company/armada/commit/1e6da14542be854269e8616e0abbd190208842f7))

## [0.2.13](https://github.com/The-Vibe-Company/armada/compare/v0.2.12...v0.2.13) (2026-10-01)


### Features

* **dashboard:** show every project and each project's page ([#83](https://github.com/The-Vibe-Company/armada/issues/83)) ([ba22466](https://github.com/The-Vibe-Company/armada/commit/ba2246660cba748f0b0e35b7a51686c92f380da3))

## [0.2.12](https://github.com/The-Vibe-Company/armada/compare/v0.2.11...v0.2.12) (2026-10-01)


### Features

* **dashboard:** build every page from the Agents page's header, toolbar, sections and rows ([#81](https://github.com/The-Vibe-Company/armada/issues/81)) ([19fc1e9](https://github.com/The-Vibe-Company/armada/commit/19fc1e9be3ad564862891177632bc7bd59b491b8))

## [0.2.11](https://github.com/The-Vibe-Company/armada/compare/v0.2.10...v0.2.11) (2026-10-01)


### Features

* **core:** record the v4 dashboard's fleet facts and requests ([#78](https://github.com/The-Vibe-Company/armada/issues/78)) ([21235b7](https://github.com/The-Vibe-Company/armada/commit/21235b7e1a605760ccab66a0042f770d7362bbb0))

## [0.2.10](https://github.com/The-Vibe-Company/armada/compare/v0.2.9...v0.2.10) (2026-10-01)


### Features

* **cli:** flag a launched worker that never starts, and pin a version npm serves in armada brief ([#76](https://github.com/The-Vibe-Company/armada/issues/76)) ([b644d1d](https://github.com/The-Vibe-Company/armada/commit/b644d1db1559b909b95f66684c464e7aae860b6c))

## [0.2.9](https://github.com/The-Vibe-Company/armada/compare/v0.2.8...v0.2.9) (2026-10-01)


### Features

* **cli:** tell coordinators when a new Armada version is out ([#74](https://github.com/The-Vibe-Company/armada/issues/74)) ([4b65767](https://github.com/The-Vibe-Company/armada/commit/4b657679e3f4f6108d8524853563316884722f7e))

## [0.2.8](https://github.com/The-Vibe-Company/armada/compare/v0.2.7...v0.2.8) (2026-10-01)


### Features

* keep keys and secrets per project, fetched by workers with armada run ([#72](https://github.com/The-Vibe-Company/armada/issues/72)) ([d916cf3](https://github.com/The-Vibe-Company/armada/commit/d916cf3024a69756aba4568766911d54fda330f1))

## [0.2.7](https://github.com/The-Vibe-Company/armada/compare/v0.2.6...v0.2.7) (2026-10-01)


### Features

* **dashboard:** lay out the v4 shell with sidebar, pages, search, keyboard and design tokens ([#71](https://github.com/The-Vibe-Company/armada/issues/71)) ([aa5a32f](https://github.com/The-Vibe-Company/armada/commit/aa5a32f4e242874d3a44621512dae8c6ab35690d))

## [0.2.6](https://github.com/The-Vibe-Company/armada/compare/v0.2.5...v0.2.6) (2026-10-01)


### Bug Fixes

* **cli:** tell an outdated CLI to upgrade, hide the launch token in briefs, find Conductor's bundled CLI ([#65](https://github.com/The-Vibe-Company/armada/issues/65)) ([53344de](https://github.com/The-Vibe-Company/armada/commit/53344de608e994b788282d8e95266fa95121b6bf))

## [0.2.5](https://github.com/The-Vibe-Company/armada/compare/v0.2.4...v0.2.5) (2026-10-01)


### Features

* **cli:** launch workers as local Claude Code subagents ([#62](https://github.com/The-Vibe-Company/armada/issues/62)) ([5228e0c](https://github.com/The-Vibe-Company/armada/commit/5228e0c0872103b94d1c3f0fc2bfb299bca37a96))
* **cli:** merge green pull requests while main keeps moving with armada merge --wait and --no-ticket ([#69](https://github.com/The-Vibe-Company/armada/issues/69)) ([0739516](https://github.com/The-Vibe-Company/armada/commit/07395167d0ec5e4cf90a6cc039c3796a5319323b))

## [0.2.4](https://github.com/The-Vibe-Company/armada/compare/v0.2.3...v0.2.4) (2026-10-01)


### Features

* **cli:** put project conventions and the plan rule in every brief ([#63](https://github.com/The-Vibe-Company/armada/issues/63)) ([5c356fa](https://github.com/The-Vibe-Company/armada/commit/5c356fab4681f837b307c0aee3e1e90afe41027c))

## [0.2.3](https://github.com/The-Vibe-Company/armada/compare/v0.2.2...v0.2.3) (2026-10-01)


### Features

* **dashboard:** make the dashboard instant and cheap to run ([#59](https://github.com/The-Vibe-Company/armada/issues/59)) ([cb71f78](https://github.com/The-Vibe-Company/armada/commit/cb71f78b66b1a533f3f26824b2ef53a9b5dae213))

## [0.2.2](https://github.com/The-Vibe-Company/armada/compare/v0.2.1...v0.2.2) (2026-10-01)


### Features

* **cli:** never miss a worker's hand-back with armada watch and a Claude Code stop hook ([#60](https://github.com/The-Vibe-Company/armada/issues/60)) ([eb78519](https://github.com/The-Vibe-Company/armada/commit/eb785195a9d9057bc3dc29ee4f91cc9ef77fc0d4))

## [0.2.1](https://github.com/The-Vibe-Company/armada/compare/v0.2.0...v0.2.1) (2026-10-01)


### Features

* **dashboard:** link the GitHub App to the organization in one click ([#57](https://github.com/The-Vibe-Company/armada/issues/57)) ([391f058](https://github.com/The-Vibe-Company/armada/commit/391f0586cfafc79bf0002af8925c794f6bc1bf1f))

## [0.2.0](https://github.com/The-Vibe-Company/armada/compare/v0.1.22...v0.2.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **cli:** reach the fleet's live data only through the Armada API ([#55](https://github.com/The-Vibe-Company/armada/issues/55))

### Features

* **cli:** reach the fleet's live data only through the Armada API ([#55](https://github.com/The-Vibe-Company/armada/issues/55)) ([69a60ab](https://github.com/The-Vibe-Company/armada/commit/69a60ab5954986be29355ea2564fd50dc0def2f7))

## [0.1.22](https://github.com/The-Vibe-Company/armada/compare/v0.1.21...v0.1.22) (2026-10-01)


### Features

* **dashboard:** read GitHub through an Armada GitHub App ([#53](https://github.com/The-Vibe-Company/armada/issues/53)) ([35bf64f](https://github.com/The-Vibe-Company/armada/commit/35bf64ffd969b56d972093f1ed6c618f0d49f32d))

## [0.1.21](https://github.com/The-Vibe-Company/armada/compare/v0.1.20...v0.1.21) (2026-10-01)


### Features

* **dashboard:** run the Armada app on one Neon database in Frankfurt ([#51](https://github.com/The-Vibe-Company/armada/issues/51)) ([0239fbb](https://github.com/The-Vibe-Company/armada/commit/0239fbba803209226c44461d388559c2a8fe97cb))

## [0.1.20](https://github.com/The-Vibe-Company/armada/compare/v0.1.19...v0.1.20) (2026-10-01)


### Bug Fixes

* **neon:** end .mcp.json with a newline ([#49](https://github.com/The-Vibe-Company/armada/issues/49)) ([6f88fb4](https://github.com/The-Vibe-Company/armada/commit/6f88fb4774eb15214c092fc84b48002ab6163836))

## [0.1.19](https://github.com/The-Vibe-Company/armada/compare/v0.1.18...v0.1.19) (2026-09-30)


### Features

* **cli:** launch workers with no keys in their environment ([#45](https://github.com/The-Vibe-Company/armada/issues/45)) ([36e7266](https://github.com/The-Vibe-Company/armada/commit/36e72665c477f11a904b28217730f020d4b87484))

## [0.1.18](https://github.com/The-Vibe-Company/armada/compare/v0.1.17...v0.1.18) (2026-09-30)


### Features

* **cli:** let a worker sign in with a one-time launch token ([#43](https://github.com/The-Vibe-Company/armada/issues/43)) ([99a15e2](https://github.com/The-Vibe-Company/armada/commit/99a15e23c9c300a1b8246bbed85d40a4696192a0))

## [0.1.17](https://github.com/The-Vibe-Company/armada/compare/v0.1.16...v0.1.17) (2026-09-30)


### Bug Fixes

* **core:** deliver waiting plans to the coordinator inbox ([#41](https://github.com/The-Vibe-Company/armada/issues/41)) ([59f73c0](https://github.com/The-Vibe-Company/armada/commit/59f73c03557829fd49d2a3c4749356843d8629ab))

## [0.1.16](https://github.com/The-Vibe-Company/armada/compare/v0.1.15...v0.1.16) (2026-09-30)


### Features

* **dashboard:** keep the organization's keys in Armada ([#39](https://github.com/The-Vibe-Company/armada/issues/39)) ([6095280](https://github.com/The-Vibe-Company/armada/commit/6095280eb326b22eea515724da0ada7ab9c9903c))

## [0.1.15](https://github.com/The-Vibe-Company/armada/compare/v0.1.14...v0.1.15) (2026-09-30)


### Bug Fixes

* **core:** exclude coordinator silence and clear merged ready labels ([#32](https://github.com/The-Vibe-Company/armada/issues/32)) ([d946046](https://github.com/The-Vibe-Company/armada/commit/d946046ce2fdf58b6d6c4de8e67f1f6f711961ea))

## [0.1.14](https://github.com/The-Vibe-Company/armada/compare/v0.1.13...v0.1.14) (2026-09-30)


### Features

* **cli:** sign in to Armada from the terminal with armada login ([#33](https://github.com/The-Vibe-Company/armada/issues/33)) ([6951ace](https://github.com/The-Vibe-Company/armada/commit/6951ace5cd7f30ee51e41303dc1ac6c389adcfe6))
* **skills:** teach a cold coordinator how to take over a run ([#31](https://github.com/The-Vibe-Company/armada/issues/31)) ([563656a](https://github.com/The-Vibe-Company/armada/commit/563656ad794201654d19b39d6b943da2dca6d803))

## [0.1.13](https://github.com/The-Vibe-Company/armada/compare/v0.1.12...v0.1.13) (2026-09-30)


### Bug Fixes

* **cli:** finish large piped output before exiting ([#34](https://github.com/The-Vibe-Company/armada/issues/34)) ([d4f4187](https://github.com/The-Vibe-Company/armada/commit/d4f4187d87f74d6d32d6402dbae5f3c09b09d0d3))

## [0.1.12](https://github.com/The-Vibe-Company/armada/compare/v0.1.11...v0.1.12) (2026-09-30)


### Features

* **dashboard:** sign in with an account and an organization ([#29](https://github.com/The-Vibe-Company/armada/issues/29)) ([7ce90a1](https://github.com/The-Vibe-Company/armada/commit/7ce90a12916354031e0d55dc2cc4b194c5e55f34))

## [0.1.11](https://github.com/The-Vibe-Company/armada/compare/v0.1.10...v0.1.11) (2026-09-30)


### Bug Fixes

* **cli:** read piped report messages reliably ([#27](https://github.com/The-Vibe-Company/armada/issues/27)) ([24606ab](https://github.com/The-Vibe-Company/armada/commit/24606abee973769d22b870d3c1b21ffb11a95272))

## [0.1.10](https://github.com/The-Vibe-Company/armada/compare/v0.1.9...v0.1.10) (2026-09-30)


### Features

* **dashboard:** answer questions and request launches from the fleet view ([#22](https://github.com/The-Vibe-Company/armada/issues/22)) ([508eaea](https://github.com/The-Vibe-Company/armada/commit/508eaea88bb2523f99e4221880c81aac62b6cc2a))

## [0.1.9](https://github.com/The-Vibe-Company/armada/compare/v0.1.8...v0.1.9) (2026-09-30)


### Features

* **dashboard:** require a password before showing the fleet ([#23](https://github.com/The-Vibe-Company/armada/issues/23)) ([1447bd8](https://github.com/The-Vibe-Company/armada/commit/1447bd8b9bbb4a9adeabf0f95c532fe4b83e2019))


### Bug Fixes

* **cli:** name the next step whenever armada cannot continue ([#21](https://github.com/The-Vibe-Company/armada/issues/21)) ([e69633c](https://github.com/The-Vibe-Company/armada/commit/e69633c9bf7b85d1313f8e6584ac8a9e165822ac))

## [0.1.8](https://github.com/The-Vibe-Company/armada/compare/v0.1.7...v0.1.8) (2026-09-30)


### Features

* **cli:** route each ticket to a model profile by its labels ([#17](https://github.com/The-Vibe-Company/armada/issues/17)) ([e5ab8c7](https://github.com/The-Vibe-Company/armada/commit/e5ab8c70c251e30662cf79591260db8bc9c5f43b))

## [0.1.7](https://github.com/The-Vibe-Company/armada/compare/v0.1.6...v0.1.7) (2026-09-30)


### Features

* **cli:** let workers ask the coordinator through armada ([#15](https://github.com/The-Vibe-Company/armada/issues/15)) ([4637926](https://github.com/The-Vibe-Company/armada/commit/46379261ceb8acb8a993903b26005dbd0994de08))

## [0.1.6](https://github.com/The-Vibe-Company/armada/compare/v0.1.5...v0.1.6) (2026-09-30)


### Features

* **dashboard:** watch the fleet of every project live ([#13](https://github.com/The-Vibe-Company/armada/issues/13)) ([c53e732](https://github.com/The-Vibe-Company/armada/commit/c53e73244a611d5eb662c5eca3e6228a0d4cde44))

## [0.1.5](https://github.com/The-Vibe-Company/armada/compare/v0.1.4...v0.1.5) (2026-09-30)


### Bug Fixes

* **core:** read every relation of large programs ([#14](https://github.com/The-Vibe-Company/armada/issues/14)) ([b457cd2](https://github.com/The-Vibe-Company/armada/commit/b457cd209687a0b78b814f4d659de89765860c27))

## [0.1.4](https://github.com/The-Vibe-Company/armada/compare/v0.1.3...v0.1.4) (2026-09-30)


### Features

* **cli:** prepare worker briefs and the Conductor Cloud runtime guide ([#11](https://github.com/The-Vibe-Company/armada/issues/11)) ([aba1e6f](https://github.com/The-Vibe-Company/armada/commit/aba1e6f3b846847c2182d478a6af3f78204e5abb))

## [0.1.3](https://github.com/The-Vibe-Company/armada/compare/v0.1.2...v0.1.3) (2026-09-30)


### Features

* **cli:** merge a handed-back pull request safely with armada merge ([#9](https://github.com/The-Vibe-Company/armada/issues/9)) ([e9b8594](https://github.com/The-Vibe-Company/armada/commit/e9b85949b3d446cdf9e3917f7ee2e0bda6e6f2e0))

## [0.1.2](https://github.com/The-Vibe-Company/armada/compare/v0.1.1...v0.1.2) (2026-09-30)


### Features

* **cli:** check a repository and open its Armada setup pull request ([#6](https://github.com/The-Vibe-Company/armada/issues/6)) ([c179a24](https://github.com/The-Vibe-Company/armada/commit/c179a2462dfe74eb8a23b0f392fbf3b53dd4a8e6))

## [0.1.1](https://github.com/The-Vibe-Company/armada/compare/v0.1.0...v0.1.1) (2026-09-30)


### Features

* **cli:** claim tickets and report progress through armada ([#5](https://github.com/The-Vibe-Company/armada/issues/5)) ([cb94081](https://github.com/The-Vibe-Company/armada/commit/cb940818cfca59cd999331df544f56b685e86abe))

## 0.1.0 (2026-09-30)


### Features

* **cli:** show the fleet state with armada status ([#1](https://github.com/The-Vibe-Company/armada/issues/1)) ([a6b5c9f](https://github.com/The-Vibe-Company/armada/commit/a6b5c9fe9f810b2d5a827a300444b660c70fa0fe))
* **core:** store Armada keys once per machine ([#2](https://github.com/The-Vibe-Company/armada/issues/2)) ([6922151](https://github.com/The-Vibe-Company/armada/commit/692215158ce18c365ba12e6cc496a11e8f18f749))
