# Changelog

## [2.18.0](https://github.com/The-Vibe-Company/armada/compare/v2.17.0...v2.18.0) (2026-11-10)


### Features

* **ci:** gate release-only production on exact-commit staging smoke ([#828](https://github.com/The-Vibe-Company/armada/issues/828)) ([494dd08](https://github.com/The-Vibe-Company/armada/commit/494dd081bd72c1b68961e153f2c870fc53a0f541))
* **dashboard:** show what each sandbox cost ([#894](https://github.com/The-Vibe-Company/armada/issues/894)) ([fcdd162](https://github.com/The-Vibe-Company/armada/commit/fcdd162d7ae821ece04290b38e3a25d561437cd2))
* **orchestrators:** select a public Skillpack skill at create ([#839](https://github.com/The-Vibe-Company/armada/issues/839)) ([969bcb0](https://github.com/The-Vibe-Company/armada/commit/969bcb0d4341361ebd95ad7a88d712c09c6e3ba2))
* **sandbox:** install pinned Skillpack skills at launch ([#869](https://github.com/The-Vibe-Company/armada/issues/869)) ([eab5f64](https://github.com/The-Vibe-Company/armada/commit/eab5f64af09009fec617381abe6c30f2ace67110))


### Bug Fixes

* **api:** preserve message text across history page boundaries ([#820](https://github.com/The-Vibe-Company/armada/issues/820)) ([0229761](https://github.com/The-Vibe-Company/armada/commit/0229761f33a3ae6cc5ef4489ea994204156c75d2))
* **dashboard:** add a tool through a dialog and one services section ([#900](https://github.com/The-Vibe-Company/armada/issues/900)) ([c9c8970](https://github.com/The-Vibe-Company/armada/commit/c9c8970634e889f31445ea61688e9fd55e459a3c))
* **github:** preserve launch lifetime and repair running sandbox access ([#881](https://github.com/The-Vibe-Company/armada/issues/881)) ([4355878](https://github.com/The-Vibe-Company/armada/commit/4355878b46f8df8a19cdb55cdd8688c722b6ca62))
* **ios:** send a follow-up after the turn finished as a new message, not a steer ([#853](https://github.com/The-Vibe-Company/armada/issues/853)) ([2fce2ef](https://github.com/The-Vibe-Company/armada/commit/2fce2ef6bc993d0516e1642f3f0ca42f198b8270))
* **ios:** sort orchestrators and sandboxes by status, then newest first ([#850](https://github.com/The-Vibe-Company/armada/issues/850)) ([c51a807](https://github.com/The-Vibe-Company/armada/commit/c51a8072fc665b0673d9614d68cdba50cf53aaf4))
* **launch:** retry intermittent repository ownership refusal once ([#893](https://github.com/The-Vibe-Company/armada/issues/893)) ([35bfb18](https://github.com/The-Vibe-Company/armada/commit/35bfb180820716f5ea1c5c82342a0ece37feb396))
* **models:** report observed turn models honestly ([#891](https://github.com/The-Vibe-Company/armada/issues/891)) ([768ee87](https://github.com/The-Vibe-Company/armada/commit/768ee87cbde3a317dcc9618b474db042d2d860a0))
* **orchestrators:** refuse steer when no turn is running ([#848](https://github.com/The-Vibe-Company/armada/issues/848)) ([140589f](https://github.com/The-Vibe-Company/armada/commit/140589f51e5647a589c05b000bfca84ac20cb60a))
* **sandbox:** allow lifetime extensions through the public API ([#888](https://github.com/The-Vibe-Company/armada/issues/888)) ([0c2cb7f](https://github.com/The-Vibe-Company/armada/commit/0c2cb7f39b8f421a4bd28ee34f5c6d285fa691cd))
* **sandbox:** make stop preservation failures actionable ([#903](https://github.com/The-Vibe-Company/armada/issues/903)) ([946d568](https://github.com/The-Vibe-Company/armada/commit/946d5685768ba9f0377f4fa21ac8c318ec1d67ac))
* **skillpack:** diagnose private install failures and settle failed creates ([#899](https://github.com/The-Vibe-Company/armada/issues/899)) ([5189abe](https://github.com/The-Vibe-Company/armada/commit/5189abe0a09656d10ea8688c54a1413fdbba4a90))
* **usage:** record per-sandbox token usage from real harness streams ([#889](https://github.com/The-Vibe-Company/armada/issues/889)) ([4a6fb4c](https://github.com/The-Vibe-Company/armada/commit/4a6fb4cdba2ed239f441b6679915e9a6e3abacd9))


### Reverts

* **skills:** restore ship-pr-dev exactly before [#831](https://github.com/The-Vibe-Company/armada/issues/831) ([#845](https://github.com/The-Vibe-Company/armada/issues/845)) ([c686530](https://github.com/The-Vibe-Company/armada/commit/c68653051f8941acd78426d3d15eb1634827551f))

## [2.17.0](https://github.com/The-Vibe-Company/armada/compare/v2.16.0...v2.17.0) (2026-11-10)


### Features

* **api:** delete stopped standalone sandboxes ([#772](https://github.com/The-Vibe-Company/armada/issues/772)) ([b955974](https://github.com/The-Vibe-Company/armada/commit/b9559741b59b549d0e8a467f8f9e0002c04178d5))
* **api:** page conversation history from the end ([#814](https://github.com/The-Vibe-Company/armada/issues/814)) ([5966f90](https://github.com/The-Vibe-Company/armada/commit/5966f90c567702553b2a8349f5defb7c00690a7e))
* **api:** report runtime and token usage per sandbox ([#773](https://github.com/The-Vibe-Company/armada/issues/773)) ([3f1b592](https://github.com/The-Vibe-Company/armada/commit/3f1b592c42ca82fd4a139f20d8dc8e1b6f2abad0))
* **ci:** publish the iOS app to TestFlight automatically ([#807](https://github.com/The-Vibe-Company/armada/issues/807)) ([2eff502](https://github.com/The-Vibe-Company/armada/commit/2eff5024f2ccf0b868dd22ff3e08f3021a294b49))
* **dashboard:** a design pass that makes the dashboard feel like one product ([#758](https://github.com/The-Vibe-Company/armada/issues/758)) ([e8dbb31](https://github.com/The-Vibe-Company/armada/commit/e8dbb31dff581050f0e9dee29cd35ce0c94801f5))
* **dashboard:** design pass on the launch form, credentials, goldens and organization screens ([#783](https://github.com/The-Vibe-Company/armada/issues/783)) ([6c4df96](https://github.com/The-Vibe-Company/armada/commit/6c4df962f8aac85e6d88da2d2f1d80372979b796))
* **dashboard:** rebuild the Build section around what you can launch ([#810](https://github.com/The-Vibe-Company/armada/issues/810)) ([ee38546](https://github.com/The-Vibe-Company/armada/commit/ee385461007aefdd50cfd44c64a45ae835699b16))
* **dashboard:** rename Credentials to Harness and make it only about subscriptions ([#809](https://github.com/The-Vibe-Company/armada/issues/809)) ([75c6cb6](https://github.com/The-Vibe-Company/armada/commit/75c6cb6c5aa2e255805ffbe2f90c53d51783d013))
* **dashboard:** rework the fleet board so it only shows what needs a decision ([#811](https://github.com/The-Vibe-Company/armada/issues/811)) ([34854e3](https://github.com/The-Vibe-Company/armada/commit/34854e34688a96bc94070f91bc4e6c36dd01f630))
* **dashboard:** show the ready / blocked task outcome on the fleet board and sandbox list ([#775](https://github.com/The-Vibe-Company/armada/issues/775)) ([9d7d76e](https://github.com/The-Vibe-Company/armada/commit/9d7d76ea2ead21a9bb9e2114f6a46123a71ac0f0))
* **dashboard:** toasts for action outcomes ([#789](https://github.com/The-Vibe-Company/armada/issues/789)) ([087d670](https://github.com/The-Vibe-Company/armada/commit/087d6702d28eade33d4f463f97e938dad19ec475))
* **ios:** orchestrators on the phone: list, create, converse, stop, resume, recover ([#756](https://github.com/The-Vibe-Company/armada/issues/756)) ([335296f](https://github.com/The-Vibe-Company/armada/commit/335296f7158fdcb1ed349f81b55bd55d906dbc48))


### Bug Fixes

* **api:** distinguish credential refusal and launch outages ([#774](https://github.com/The-Vibe-Company/armada/issues/774)) ([aed5298](https://github.com/The-Vibe-Company/armada/commit/aed5298a8ac4f85e8d1669f042f9ce9d99a4fc1f))
* **ci:** match Railway staging deployment smoke environment ([#793](https://github.com/The-Vibe-Company/armada/issues/793)) ([8d6315c](https://github.com/The-Vibe-Company/armada/commit/8d6315cf87ef7d10cfec47d955809d0e204bad04)), closes [#790](https://github.com/The-Vibe-Company/armada/issues/790)
* **ci:** prevent skipped deployments from evicting staging smoke ([#800](https://github.com/The-Vibe-Company/armada/issues/800)) ([a16e435](https://github.com/The-Vibe-Company/armada/commit/a16e4352577ef451b310e3623fb9db26bf45dba0))
* **ci:** wait for smoke sandbox readiness and confirm cleanup ([#788](https://github.com/The-Vibe-Company/armada/issues/788)) ([44f91ed](https://github.com/The-Vibe-Company/armada/commit/44f91ed261f009ebd3597bd68d7143268eaf22e8))
* **cli:** allow slow lifecycle mutations and explain timeouts ([#795](https://github.com/The-Vibe-Company/armada/issues/795)) ([6987a60](https://github.com/The-Vibe-Company/armada/commit/6987a60e8001aa0da2f420d2d62284d20bb5aea6))
* **ios:** create an orchestrator from the phone with the real form ([#817](https://github.com/The-Vibe-Company/armada/issues/817)) ([d7818cb](https://github.com/The-Vibe-Company/armada/commit/d7818cb39ba36da3337e5d4f212c7c3d15d7a68a))
* **ios:** open a conversation in one read, history after, from memory on return ([#816](https://github.com/The-Vibe-Company/armada/issues/816)) ([3c735e9](https://github.com/The-Vibe-Company/armada/commit/3c735e9b126d804fb5b6e2c12ab12835ac13bfdb))
* **modal:** bound ordinary stop checkpoint recovery ([#784](https://github.com/The-Vibe-Company/armada/issues/784)) ([592721c](https://github.com/The-Vibe-Company/armada/commit/592721cc7bc634bef3ad8fefe053018207989d18))
* **orchestrators:** align Boat parent requests with ordinary sandboxes ([#780](https://github.com/The-Vibe-Company/armada/issues/780)) ([5f6caf0](https://github.com/The-Vibe-Company/armada/commit/5f6caf09a68f75620e11ba2f9b2ec58d4ea1ed3c))
* **orchestrators:** recover Boat Claude conversations after stop ([#786](https://github.com/The-Vibe-Company/armada/issues/786)) ([5df392c](https://github.com/The-Vibe-Company/armada/commit/5df392c1beed6e957be9f6451de77de1ecefdc19))
* **orchestrators:** repair Boat parent lifecycle in production ([#764](https://github.com/The-Vibe-Company/armada/issues/764)) ([6d558ab](https://github.com/The-Vibe-Company/armada/commit/6d558abc45dd730d0fdc19e3f30ef6ff70d06b40))
* **orchestrators:** scope privileged checkpoint writers by ownership ([#765](https://github.com/The-Vibe-Company/armada/issues/765)) ([1e04699](https://github.com/The-Vibe-Company/armada/commit/1e046990c0941587d1d2d9a9e47766274520fe64))
* **sandbox:** keep recoverable turn interruptions out of machine failures ([#804](https://github.com/The-Vibe-Company/armada/issues/804)) ([ffb9566](https://github.com/The-Vibe-Company/armada/commit/ffb956603dda9713f9dd4af9bd7965c823b6fd2a))
* **sandbox:** preserve work without python3 ([#797](https://github.com/The-Vibe-Company/armada/issues/797)) ([a6ac03c](https://github.com/The-Vibe-Company/armada/commit/a6ac03c2035238dabbaa1a2f3f8000017aff3e69))
* **sandbox:** recover quiescent Modal stops and close busy admission ([#777](https://github.com/The-Vibe-Company/armada/issues/777)) ([b692fd5](https://github.com/The-Vibe-Company/armada/commit/b692fd5197f8d3d029f12f0e8b02501589134650))
* **server:** classify structured diagnostic log severity ([#796](https://github.com/The-Vibe-Company/armada/issues/796)) ([07a8b2d](https://github.com/The-Vibe-Company/armada/commit/07a8b2df65ab02daaaaabdf5114dd907fd49a25e))

## [2.16.0](https://github.com/The-Vibe-Company/armada/compare/v2.15.0...v2.16.0) (2026-11-10)


### Features

* **api:** expose structured sandbox task outcomes ([#745](https://github.com/The-Vibe-Company/armada/issues/745)) ([7b26312](https://github.com/The-Vibe-Company/armada/commit/7b26312aa2479503eab99b49689a31019130fa69))
* **ci:** smoke deployed staging through the Armada API ([#744](https://github.com/The-Vibe-Company/armada/issues/744)) ([ddffbd5](https://github.com/The-Vibe-Company/armada/commit/ddffbd506ee534afce4ddb305f915cc025d64141))
* **dashboard:** a fleet board showing every running agent and what it needs ([#748](https://github.com/The-Vibe-Company/armada/issues/748)) ([d9c7258](https://github.com/The-Vibe-Company/armada/commit/d9c72583bbda60bf25dc39df4663dff81aab3baf))
* **ios:** launch a sandbox from the phone ([#753](https://github.com/The-Vibe-Company/armada/issues/753)) ([7d6c70e](https://github.com/The-Vibe-Company/armada/commit/7d6c70e7a4669ef7365d9c663a4e9f2c5e8ad63e))
* **orchestrator:** enable best-effort Boat pairs ([#754](https://github.com/The-Vibe-Company/armada/issues/754)) ([73fcf77](https://github.com/The-Vibe-Company/armada/commit/73fcf77072b5101b5979cfca2d1de9dea089fd16))
* **sandbox:** preserve unpushed work before managed stops ([#747](https://github.com/The-Vibe-Company/armada/issues/747)) ([56fc41b](https://github.com/The-Vibe-Company/armada/commit/56fc41ba05a8db5a2d15559513d555c431b8b235))


### Bug Fixes

* **api:** map unknown provider failures to 502 ([#740](https://github.com/The-Vibe-Company/armada/issues/740)) ([76f46dd](https://github.com/The-Vibe-Company/armada/commit/76f46ddfa88065880a0e545fcb6ebfd58bcd2574))
* **dashboard:** show the credential hint when a turn stops on an expired credential ([#738](https://github.com/The-Vibe-Company/armada/issues/738)) ([85ac509](https://github.com/The-Vibe-Company/armada/commit/85ac5091a9daff6eb29e146d5d1eeae3bdf682c4))
* **orchestrators:** classify checkpoint survivors and native SQL errors ([#733](https://github.com/The-Vibe-Company/armada/issues/733)) ([59cb872](https://github.com/The-Vibe-Company/armada/commit/59cb87299a4a823f4952cb679a6befe4f3ff2cca))
* **orchestrators:** quiesce Modal parents without privileged namespace inspection ([#755](https://github.com/The-Vibe-Company/armada/issues/755)) ([f21d3f1](https://github.com/The-Vibe-Company/armada/commit/f21d3f1f9b7630cead0982a9cf54e5f294cd1892))
* **sandbox:** preserve unpushed work on real Boat sandboxes ([#761](https://github.com/The-Vibe-Company/armada/issues/761)) ([74fea55](https://github.com/The-Vibe-Company/armada/commit/74fea550e0c1f9bfc257e1ad70d053fa41cf81b0))
* **sandbox:** reconcile interrupted launches ([#762](https://github.com/The-Vibe-Company/armada/issues/762)) ([04fd780](https://github.com/The-Vibe-Company/armada/commit/04fd7804439f6cceb48e5d527de0f7f2e8ac34d5))

## [2.15.0](https://github.com/The-Vibe-Company/armada/compare/v2.14.0...v2.15.0) (2026-11-10)


### Features

* **orchestrators:** activate the production Modal Codex runtime ([#722](https://github.com/The-Vibe-Company/armada/issues/722)) ([7615aff](https://github.com/The-Vibe-Company/armada/commit/7615aff7600dbcbd8d7f6e6b8ba93a65e2c42549))


### Bug Fixes

* **api:** forward all orchestrator owner routes through the public proxy ([#726](https://github.com/The-Vibe-Company/armada/issues/726)) ([40d5fd7](https://github.com/The-Vibe-Company/armada/commit/40d5fd797d085382ab679ec93fee234bd14e4870))
* **github:** repair managed runtime process failures ([#721](https://github.com/The-Vibe-Company/armada/issues/721)) ([791a377](https://github.com/The-Vibe-Company/armada/commit/791a37736c945794ba3d0f86cab97b2370c5bda2))
* **orchestrators:** diagnose Modal checkpoint and boot conflicts ([#731](https://github.com/The-Vibe-Company/armada/issues/731)) ([f0cf07b](https://github.com/The-Vibe-Company/armada/commit/f0cf07b3080450f7d36b7440257d08792bf74386))
* **orchestrators:** diagnose silent uncertain create operations ([#724](https://github.com/The-Vibe-Company/armada/issues/724)) ([22faaa7](https://github.com/The-Vibe-Company/armada/commit/22faaa703e7e8b3b30119f4302044e2671428cbf))
* **orchestrators:** recover allocated Modal boot failures ([#725](https://github.com/The-Vibe-Company/armada/issues/725)) ([e64d887](https://github.com/The-Vibe-Company/armada/commit/e64d8878206ba29f3bc53a528e0f19f3284e0bc2))
* **orchestrators:** repair Modal stop checkpoints and create recovery ([#729](https://github.com/The-Vibe-Company/armada/issues/729)) ([5274e48](https://github.com/The-Vibe-Company/armada/commit/5274e48b4bdf2f92c29a32201ddc89ff7e9b7ae8))
* **orchestrators:** settle admitted creates and recover pending parents ([#727](https://github.com/The-Vibe-Company/armada/issues/727)) ([073eab5](https://github.com/The-Vibe-Company/armada/commit/073eab5cf0dd386916db48a855d79729057fd077))

## [2.14.0](https://github.com/The-Vibe-Company/armada/compare/v2.13.0...v2.14.0) (2026-11-09)


### Features

* **auth:** support native subscription connections and renewal ([#677](https://github.com/The-Vibe-Company/armada/issues/677)) ([e2987f2](https://github.com/The-Vibe-Company/armada/commit/e2987f236ebc7e62eb4b1703ccf0643bcd2ec445))
* **chat:** recover legacy workspaces with an explicit account choice ([#666](https://github.com/The-Vibe-Company/armada/issues/666)) ([e5fc554](https://github.com/The-Vibe-Company/armada/commit/e5fc554fd778e021f6c84984e8cee8ac4837ec09))
* **cli:** align sandbox access and connection defaults ([#688](https://github.com/The-Vibe-Company/armada/issues/688)) ([f958b66](https://github.com/The-Vibe-Company/armada/commit/f958b664abc612c3b61bef2e2ac100c8a46b91ec))
* **cli:** expose machine sizing defaults and resource advice ([#686](https://github.com/The-Vibe-Company/armada/issues/686)) ([ecce38b](https://github.com/The-Vibe-Company/armada/commit/ecce38bdc4a3a692a569bf3ab721c5d189af72ea))
* **credentials:** add named model accounts, launch selection and usage cards ([#618](https://github.com/The-Vibe-Company/armada/issues/618)) ([9b3e302](https://github.com/The-Vibe-Company/armada/commit/9b3e30250b824f18fc98f258d4ed23f94f3364e6))
* **dashboard:** create and chat with persistent orchestrators ([#676](https://github.com/The-Vibe-Company/armada/issues/676)) ([cf0f1e1](https://github.com/The-Vibe-Company/armada/commit/cf0f1e14d1f9a2e582886d37cb7d47136fa290e0))
* **dashboard:** replace sandbox visibility choices with organization access ([#700](https://github.com/The-Vibe-Company/armada/issues/700)) ([ce3260d](https://github.com/The-Vibe-Company/armada/commit/ce3260d1bfca804a93545ad28d1e7dc83f9867f7))
* **dashboard:** simplify the sandbox launch experience ([#696](https://github.com/The-Vibe-Company/armada/issues/696)) ([a6d2ace](https://github.com/The-Vibe-Company/armada/commit/a6d2acec147007b90005e93d5cb9dc575f1e32fe))
* **ios:** add API-only ArmadaKit session and orchestrator client ([#694](https://github.com/The-Vibe-Company/armada/issues/694)) ([a3f125f](https://github.com/The-Vibe-Company/armada/commit/a3f125fb58776af31036085337847ab6a69cd20d))
* **ios:** migrate Companion native UI for Armada orchestrators ([#695](https://github.com/The-Vibe-Company/armada/issues/695)) ([fc8410c](https://github.com/The-Vibe-Company/armada/commit/fc8410c41f5412b198f18254926bab391e1e9752))
* **ios:** open a sandbox's conversation from the mobile app ([#713](https://github.com/The-Vibe-Company/armada/issues/713)) ([068bb93](https://github.com/The-Vibe-Company/armada/commit/068bb93e4264b89c762c705a5341cce94d4301c0))
* **ios:** prepare generated project and TestFlight packaging lane ([#698](https://github.com/The-Vibe-Company/armada/issues/698)) ([731e5eb](https://github.com/The-Vibe-Company/armada/commit/731e5ebc475773510e42b02aab1aae5a70418b65))
* **orchestrators:** add child admission and persistent lifecycle management ([#705](https://github.com/The-Vibe-Company/armada/issues/705)) ([0976883](https://github.com/The-Vibe-Company/armada/commit/0976883b70ee3ddedef5f965064bd75a248c5b6e))
* **resources:** persist scoped sandbox sizing evidence and advice ([#672](https://github.com/The-Vibe-Company/armada/issues/672)) ([e7b22fe](https://github.com/The-Vibe-Company/armada/commit/e7b22fe2fef423ecedc56c630c87e0dc8f02fdad))
* **runtime:** add persistent orchestrator runtime ([#704](https://github.com/The-Vibe-Company/armada/issues/704)) ([a7af4a7](https://github.com/The-Vibe-Company/armada/commit/a7af4a73ea2fda586778fe8994b991a6671f5ddf))


### Bug Fixes

* **auth:** make iOS and CLI email sign-in code-only ([#715](https://github.com/The-Vibe-Company/armada/issues/715)) ([df7f126](https://github.com/The-Vibe-Company/armada/commit/df7f12650c1170cf3b16be1e9b22fdae7918f5da))
* **github:** gate managed runtime behind default-off server setting ([#720](https://github.com/The-Vibe-Company/armada/issues/720)) ([a7d63e6](https://github.com/The-Vibe-Company/armada/commit/a7d63e64aa17c827ac2ee9d247458ffb66487df8))
* **github:** renew managed credentials in active sandboxes ([#703](https://github.com/The-Vibe-Company/armada/issues/703)) ([5ae3a07](https://github.com/The-Vibe-Company/armada/commit/5ae3a0723b3e8d7eb92b00d41b28b5126ff3a232))
* **mcp:** attach personal defaults to owner launches ([#684](https://github.com/The-Vibe-Company/armada/issues/684)) ([a59f120](https://github.com/The-Vibe-Company/armada/commit/a59f120ca5338137ef53e33b96039a339ac56fce))

## [2.13.0](https://github.com/The-Vibe-Company/armada/compare/v2.12.0...v2.13.0) (2026-11-09)


### Features

* **cli:** control persistent orchestrators ([#699](https://github.com/The-Vibe-Company/armada/issues/699)) ([8e71861](https://github.com/The-Vibe-Company/armada/commit/8e718618b0ab7372583a6d22f993a1c45080abed))
* **credentials:** add named model accounts and pinned launch bindings ([#612](https://github.com/The-Vibe-Company/armada/issues/612)) ([1eaaf07](https://github.com/The-Vibe-Company/armada/commit/1eaaf07d5fa9b6380587dec79e98453fc09a2ea0))
* **dashboard:** invite teammates and accept organization invitations ([#648](https://github.com/The-Vibe-Company/armada/issues/648)) ([0f3bb22](https://github.com/The-Vibe-Company/armada/commit/0f3bb2232e27ba662df680e1ec695f032aafef28))
* **dashboard:** select machine sizes with repository and golden defaults ([#667](https://github.com/The-Vibe-Company/armada/issues/667)) ([b4bd66f](https://github.com/The-Vibe-Company/armada/commit/b4bd66f286f69d949fbca879c2d40dd5b768b4c2))
* **usage:** expose private native credits and quota telemetry ([#643](https://github.com/The-Vibe-Company/armada/issues/643)) ([4f2ee45](https://github.com/The-Vibe-Company/armada/commit/4f2ee45e729b4b4ab41c0b731a887a89263754b3))


### Bug Fixes

* **auth:** include one-time code in sign-in email ([#701](https://github.com/The-Vibe-Company/armada/issues/701)) ([d0fd39d](https://github.com/The-Vibe-Company/armada/commit/d0fd39d9a277fc6af57a837503b8ca47b6892f35))
* **dashboard:** proxy authenticated machine sizing routes ([#679](https://github.com/The-Vibe-Company/armada/issues/679)) ([5c3b888](https://github.com/The-Vibe-Company/armada/commit/5c3b888590c5355b91a6bc53007c4a2cc28d9687))

## [2.12.0](https://github.com/The-Vibe-Company/armada/compare/v2.11.0...v2.12.0) (2026-11-09)


### Features

* **auth:** add private orchestrator authority foundation ([#673](https://github.com/The-Vibe-Company/armada/issues/673)) ([d748be6](https://github.com/The-Vibe-Company/armada/commit/d748be683c7fb478bc738cda8954332fe72dd97b))
* **cli:** manage organization invitations ([#669](https://github.com/The-Vibe-Company/armada/issues/669)) ([c1501ea](https://github.com/The-Vibe-Company/armada/commit/c1501ea6c60ccd575610b111637b28d787b6f383))
* **dashboard:** identify sandbox providers with compact logos ([#657](https://github.com/The-Vibe-Company/armada/issues/657)) ([6db315f](https://github.com/The-Vibe-Company/armada/commit/6db315f652dc4ccfc8c53aa12e975e6ac1bf5075))
* **dashboard:** show relative sandbox creation times in the viewer timezone ([#644](https://github.com/The-Vibe-Company/armada/issues/644)) ([78884de](https://github.com/The-Vibe-Company/armada/commit/78884de87066851b75e09cbda134606c0a8bc6d7))
* **golden:** retire superseded saved snapshots safely ([#670](https://github.com/The-Vibe-Company/armada/issues/670)) ([5cec116](https://github.com/The-Vibe-Company/armada/commit/5cec1167ebea8e38592fa938fe509cf5c03988a4))
* **orchestrators:** define durable coordinator contract and design ([#650](https://github.com/The-Vibe-Company/armada/issues/650)) ([d152e87](https://github.com/The-Vibe-Company/armada/commit/d152e87accb36b99086c5779f73dfee36a9dea0d))
* **org:** add explicit email invitations and durable delivery ([#649](https://github.com/The-Vibe-Company/armada/issues/649)) ([8010a72](https://github.com/The-Vibe-Company/armada/commit/8010a72bd9227b577b4babbcd4b1a00a99243676))
* **sizing:** add provider machine size policies and launch evidence ([#658](https://github.com/The-Vibe-Company/armada/issues/658)) ([ec3b89d](https://github.com/The-Vibe-Company/armada/commit/ec3b89db5a7cb819b2181c26a84a17e1e99e67c3))


### Bug Fixes

* **dashboard:** distinguish provider API outages from unsupported setup ([#660](https://github.com/The-Vibe-Company/armada/issues/660)) ([c9bf8a5](https://github.com/The-Vibe-Company/armada/commit/c9bf8a5a7add7d7a02ee829e901c90d7e70c2aae))
* **dashboard:** fit the sandbox conversation and its composer to the viewport ([#636](https://github.com/The-Vibe-Company/armada/issues/636)) ([648b8cf](https://github.com/The-Vibe-Company/armada/commit/648b8cfbbd0df1d527cacdb9e3098af934d2d650))
* **modal:** bound native event ingest batches by UTF-8 bytes ([#651](https://github.com/The-Vibe-Company/armada/issues/651)) ([19adc40](https://github.com/The-Vibe-Company/armada/commit/19adc40be502b1b145aa8f4e7c83c924cde90ea0))
* **modal:** finalize owned conformance apps after cleanup ([#671](https://github.com/The-Vibe-Company/armada/issues/671)) ([90b0deb](https://github.com/The-Vibe-Company/armada/commit/90b0debde2ea3e454fd655e5a02a418d65283a23))
* **modal:** preserve numeric durable event cursor order ([#675](https://github.com/The-Vibe-Company/armada/issues/675)) ([1fd430a](https://github.com/The-Vibe-Company/armada/commit/1fd430a500dcaccf95d9d27f0984918f0dab831e))

## [2.11.0](https://github.com/The-Vibe-Company/armada/compare/v2.10.0...v2.11.0) (2026-11-09)


### Features

* **cli:** install manager skills from public GitHub ([#639](https://github.com/The-Vibe-Company/armada/issues/639)) ([9f47264](https://github.com/The-Vibe-Company/armada/commit/9f47264e4c3a9a098906162815a2f1b4949030ba))
* **dashboard:** connect catalog services as named, default-able connections ([#614](https://github.com/The-Vibe-Company/armada/issues/614)) ([58e8a9f](https://github.com/The-Vibe-Company/armada/commit/58e8a9f67ff0917aa6761a16907082a3fa0a7751))
* **dashboard:** turn sandbox logs into a readable conversation ([#616](https://github.com/The-Vibe-Company/armada/issues/616)) ([8abdb4b](https://github.com/The-Vibe-Company/armada/commit/8abdb4b5e9966879710c16b83514bc3dff506aa6))
* **landing:** generate a stronger landing through the full AEOM workflow ([#623](https://github.com/The-Vibe-Company/armada/issues/623)) ([2cb279a](https://github.com/The-Vibe-Company/armada/commit/2cb279a04d1925735942785e381c3e1d2e45a9c3))
* **mcp:** add service catalog and per-instance launch defaults ([#609](https://github.com/The-Vibe-Company/armada/issues/609)) ([c00cb3b](https://github.com/The-Vibe-Company/armada/commit/c00cb3be2f1d919792ea6e92e699aa10dc9d69be))
* **mcp:** configure registered Slack OAuth catalog clients ([#619](https://github.com/The-Vibe-Company/armada/issues/619)) ([c085631](https://github.com/The-Vibe-Company/armada/commit/c085631fd18759138fc86115069bf7b9028b8909))
* **settings:** centralize sandbox provider connections and adapt launch controls ([#615](https://github.com/The-Vibe-Company/armada/issues/615)) ([a76def0](https://github.com/The-Vibe-Company/armada/commit/a76def096c7736352502125b24a9dfcfb62eb721))
* **skills:** add portable Armada manager skill ([#638](https://github.com/The-Vibe-Company/armada/issues/638)) ([a5612ab](https://github.com/The-Vibe-Company/armada/commit/a5612ab5e0654c9e80cafa6a9efe032f69c7f36c))


### Bug Fixes

* **api:** forward authenticated public control routes ([#625](https://github.com/The-Vibe-Company/armada/issues/625)) ([36ebf2e](https://github.com/The-Vibe-Company/armada/commit/36ebf2ed5044d881f86985f707ec1e45e643acb1))
* **dashboard:** show the stopped status in the conversation as soon as the page has it ([#630](https://github.com/The-Vibe-Company/armada/issues/630)) ([56cfafc](https://github.com/The-Vibe-Company/armada/commit/56cfafcd89a183bee1425436100c48349a029cfb))
* **events:** correlate native assistant messages and snapshots ([#608](https://github.com/The-Vibe-Company/armada/issues/608)) ([9018c95](https://github.com/The-Vibe-Company/armada/commit/9018c952228116d2d38e4c2309f1539c0b03f05d))
* **goldens:** report capacity from authoritative backend bindings ([#607](https://github.com/The-Vibe-Company/armada/issues/607)) ([2ab56d0](https://github.com/The-Vibe-Company/armada/commit/2ab56d0f44ffdcb901c0e62a2cf48ca9ff6f85fb))
* **landing:** continue the hero below it, on its night surface and one accent ([#634](https://github.com/The-Vibe-Company/armada/issues/634)) ([9d90d69](https://github.com/The-Vibe-Company/armada/commit/9d90d694c9c25287fd84e9564615af4486ae0ce4))
* **mcp:** serve client metadata behind TLS termination ([#626](https://github.com/The-Vibe-Company/armada/issues/626)) ([405d15a](https://github.com/The-Vibe-Company/armada/commit/405d15a95269b20cc222d042861608503149e4dc))
* **modal:** recover fenced interrupted golden builders ([#637](https://github.com/The-Vibe-Company/armada/issues/637)) ([d79cfed](https://github.com/The-Vibe-Company/armada/commit/d79cfed8d2acd9337a41633d58884795a59853a7))

## [2.10.0](https://github.com/The-Vibe-Company/armada/compare/v2.9.1...v2.10.0) (2026-11-09)


### Features

* **landing:** retell the story below the hero ([#597](https://github.com/The-Vibe-Company/armada/issues/597)) ([501ee88](https://github.com/The-Vibe-Company/armada/commit/501ee885965bb2461e35e619f62feac1e3392299))


### Bug Fixes

* **dashboard:** switch organizations on selection and add favicons ([#596](https://github.com/The-Vibe-Company/armada/issues/596)) ([0d71df9](https://github.com/The-Vibe-Company/armada/commit/0d71df94511e88a9ae045d1f15e9cf0a165624ce))
* **dashboard:** unify organization Boat credential management ([#594](https://github.com/The-Vibe-Company/armada/issues/594)) ([2e70e68](https://github.com/The-Vibe-Company/armada/commit/2e70e68cd44edee36842795bfc91ba461142f9ff))

## [2.9.1](https://github.com/The-Vibe-Company/armada/compare/v2.9.0...v2.9.1) (2026-11-09)


### Bug Fixes

* **auth:** make sandbox registration server-owned ([#591](https://github.com/The-Vibe-Company/armada/issues/591)) ([8525aba](https://github.com/The-Vibe-Company/armada/commit/8525aba33a114331281addeeb04d8da388a3ac75))
* **dashboard:** drop statement_timeout startup param for Supabase pooler in /api/stats ([#582](https://github.com/The-Vibe-Company/armada/issues/582)) ([e720caa](https://github.com/The-Vibe-Company/armada/commit/e720caac447c615fd2bea794f55b7fc8d983470a))
* **dashboard:** restore STATS_TOKEN-guarded GET /api/stats ([#577](https://github.com/The-Vibe-Company/armada/issues/577)) ([d94fce5](https://github.com/The-Vibe-Company/armada/commit/d94fce5edb9c2d4161feda914fbadea87d8d35bb))
* **github:** invalidate reconnect cache and fence profile publication ([#592](https://github.com/The-Vibe-Company/armada/issues/592)) ([e0ff949](https://github.com/The-Vibe-Company/armada/commit/e0ff9492bdbdfdf467a1a373b2d5d88ac85dc7eb))
* **modal:** keep stopped prompt status reads observational ([#590](https://github.com/The-Vibe-Company/armada/issues/590)) ([cc80cec](https://github.com/The-Vibe-Company/armada/commit/cc80cec6a304bffc6eefe513a57d556c20e21602))

## [2.9.0](https://github.com/The-Vibe-Company/armada/compare/v2.8.0...v2.9.0) (2026-11-09)


### Features

* **dashboard:** require provider setup and trim copy ([#580](https://github.com/The-Vibe-Company/armada/issues/580)) ([e57ee84](https://github.com/The-Vibe-Company/armada/commit/e57ee84cc874691fd1f62ed278e57e6714854b89))
* **onboarding:** connect organization sandbox providers ([#578](https://github.com/The-Vibe-Company/armada/issues/578)) ([0e25b31](https://github.com/The-Vibe-Company/armada/commit/0e25b314b42fd127aa87b151c30a156d6768402a))

## [2.8.0](https://github.com/The-Vibe-Company/armada/compare/v2.7.0...v2.8.0) (2026-11-09)


### Features

* **dashboard:** simplify navigation and sandbox management ([#570](https://github.com/The-Vibe-Company/armada/issues/570)) ([fecb5e4](https://github.com/The-Vibe-Company/armada/commit/fecb5e41d73a804809c7ed6ec184d58d197015ee))
* **landing:** restore the original public landing for Armada v2 ([#574](https://github.com/The-Vibe-Company/armada/issues/574)) ([d775ca5](https://github.com/The-Vibe-Company/armada/commit/d775ca505efa201880ebf1b63dcaa17ee6fed7f5))


### Bug Fixes

* **sandbox:** decode PostgreSQL lifecycle generations safely ([#573](https://github.com/The-Vibe-Company/armada/issues/573)) ([76b7fab](https://github.com/The-Vibe-Company/armada/commit/76b7fabae2a54cad27d35e60a4ea9a011b7bbf20))
* **sandbox:** reconcile provider state and enforce saved lifetimes ([#569](https://github.com/The-Vibe-Company/armada/issues/569)) ([55ed877](https://github.com/The-Vibe-Company/armada/commit/55ed877d21b381668d6db93f6e071d6f868147b2))

## [2.7.0](https://github.com/The-Vibe-Company/armada/compare/v2.6.0...v2.7.0) (2026-11-09)


### Features

* **golden:** retire goldens while preserving sandbox history ([#567](https://github.com/The-Vibe-Company/armada/issues/567)) ([1c9549b](https://github.com/The-Vibe-Company/armada/commit/1c9549b3581524cf7f8223ffec59b213a4f0af12))

## [2.6.0](https://github.com/The-Vibe-Company/armada/compare/v2.5.0...v2.6.0) (2026-11-09)


### Features

* **platform:** add Modal sandboxes, MCP connections and CLI parity ([#561](https://github.com/The-Vibe-Company/armada/issues/561)) ([3effe60](https://github.com/The-Vibe-Company/armada/commit/3effe601c52d044ab4a37bdbe11c87c219f0231a)), closes [#508](https://github.com/The-Vibe-Company/armada/issues/508) [#510](https://github.com/The-Vibe-Company/armada/issues/510) [#511](https://github.com/The-Vibe-Company/armada/issues/511) [#512](https://github.com/The-Vibe-Company/armada/issues/512) [#513](https://github.com/The-Vibe-Company/armada/issues/513) [#514](https://github.com/The-Vibe-Company/armada/issues/514) [#519](https://github.com/The-Vibe-Company/armada/issues/519) [#520](https://github.com/The-Vibe-Company/armada/issues/520) [#521](https://github.com/The-Vibe-Company/armada/issues/521) [#522](https://github.com/The-Vibe-Company/armada/issues/522) [#523](https://github.com/The-Vibe-Company/armada/issues/523) [#529](https://github.com/The-Vibe-Company/armada/issues/529) [#556](https://github.com/The-Vibe-Company/armada/issues/556) [#557](https://github.com/The-Vibe-Company/armada/issues/557)

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
