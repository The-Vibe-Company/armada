# Changelog

## [2.24.0](https://github.com/The-Vibe-Company/armada/compare/v2.23.0...v2.24.0) (2026-11-12)


### Features

* **dashboard:** organize navigation into Run Library and Account ([#1155](https://github.com/The-Vibe-Company/armada/issues/1155)) ([f817ea1](https://github.com/The-Vibe-Company/armada/commit/f817ea108ac7496fd4bcd37c14ed67a71d93168c))
* **routines:** schedule calendar cron in IANA time zones ([#1159](https://github.com/The-Vibe-Company/armada/issues/1159)) ([5247edb](https://github.com/The-Vibe-Company/armada/commit/5247edb7c64f7ccacd8de1d328cae1f3e01bf99b))


### Bug Fixes

* **boat:** explain plan start limits and supplied reset timing ([#1156](https://github.com/The-Vibe-Company/armada/issues/1156)) ([96ae1c3](https://github.com/The-Vibe-Company/armada/commit/96ae1c32dcc22b7de991912be46764075981a221))
* **build:** repair build batch fixture on main ([#1158](https://github.com/The-Vibe-Company/armada/issues/1158)) ([309c735](https://github.com/The-Vibe-Company/armada/commit/309c7358cbeea079fde0f32764803b63e9bc67b5))

## [2.23.0](https://github.com/The-Vibe-Company/armada/compare/v2.22.0...v2.23.0) (2026-11-12)


### Features

* **cli:** manage routines and add bounded staging validation ([#1027](https://github.com/The-Vibe-Company/armada/issues/1027)) ([0324b7b](https://github.com/The-Vibe-Company/armada/commit/0324b7bc2d2b690a8c863b39142f1ac5cd817903))
* **dashboard:** expose scoped Armada launch access ([#1115](https://github.com/The-Vibe-Company/armada/issues/1115)) ([b800b6a](https://github.com/The-Vibe-Company/armada/commit/b800b6a81869dbcd3700580019734e3150719842))
* **dashboard:** pick launch skills and inspect installation receipts ([#1124](https://github.com/The-Vibe-Company/armada/issues/1124)) ([8384152](https://github.com/The-Vibe-Company/armada/commit/83841520dd7f1106bc6fb9e8083dc391ca92dfec))
* **dashboard:** select exact skills in template revisions ([#1146](https://github.com/The-Vibe-Company/armada/issues/1146)) ([67e684d](https://github.com/The-Vibe-Company/armada/commit/67e684d7f13293b50a6633178da25230f3142f00))
* **skills:** add scoped default pins and launch opt-out ([#1015](https://github.com/The-Vibe-Company/armada/issues/1015)) ([69fc768](https://github.com/The-Vibe-Company/armada/commit/69fc768633131dc6c57aafeee1f39f8104653293))
* **skills:** browse available Skillpack pins through the API ([#1043](https://github.com/The-Vibe-Company/armada/issues/1043)) ([0faec3c](https://github.com/The-Vibe-Company/armada/commit/0faec3c82ab57ca7e2153329fbe56428a6722eb2))
* **templates:** deliver bound secrets with CLI and dashboard support ([#1041](https://github.com/The-Vibe-Company/armada/issues/1041)) ([1048566](https://github.com/The-Vibe-Company/armada/commit/1048566817405986901827587e1a9a3f66e9aba6))


### Bug Fixes

* **api:** preserve unscoped Modal steer lifecycle refusals ([#1138](https://github.com/The-Vibe-Company/armada/issues/1138)) ([7beea54](https://github.com/The-Vibe-Company/armada/commit/7beea5489685ab1f33a6fc3f79e9db8ee2123a26))
* **auth:** require explicit MCP OAuth consent ([#1088](https://github.com/The-Vibe-Company/armada/issues/1088)) ([9de6d98](https://github.com/The-Vibe-Company/armada/commit/9de6d9882b4350f1287207924570521d3b59b502))
* **boat:** preserve allocation refusals and safe diagnostics ([#1149](https://github.com/The-Vibe-Company/armada/issues/1149)) ([bb0d3ef](https://github.com/The-Vibe-Company/armada/commit/bb0d3efdfce5ac07a3d9ab83ebd93d18a2a3327a))
* **boat:** refuse quiescence on unknown conversation activity ([#1130](https://github.com/The-Vibe-Company/armada/issues/1130)) ([c164ab9](https://github.com/The-Vibe-Company/armada/commit/c164ab9c5a9e432eaaf5da5a5ae4d47f31fb0053))
* **boat:** reject observations for a different sandbox ([#1121](https://github.com/The-Vibe-Company/armada/issues/1121)) ([abada36](https://github.com/The-Vibe-Company/armada/commit/abada362987c9bfcbf5533ef15577f39b383fa77))
* **boat:** tolerate invalid optional stop timestamps ([#1135](https://github.com/The-Vibe-Company/armada/issues/1135)) ([35a6b3d](https://github.com/The-Vibe-Company/armada/commit/35a6b3d1f13adbd1c7d70dff8e38cba6071137a2))
* **boat:** verify ambiguous lifetime extension acknowledgements ([#1132](https://github.com/The-Vibe-Company/armada/issues/1132)) ([fa408f1](https://github.com/The-Vibe-Company/armada/commit/fa408f13d1e1b5e230b3a8768a48c626077e51c9))
* **ci:** guard migration version uniqueness and ordering ([#1039](https://github.com/The-Vibe-Company/armada/issues/1039)) ([be3cb81](https://github.com/The-Vibe-Company/armada/commit/be3cb813f001a6dec69b18addbfdc9035c49312a))
* **cli:** recognize safe short help for variables and secrets ([#1147](https://github.com/The-Vibe-Company/armada/issues/1147)) ([5128869](https://github.com/The-Vibe-Company/armada/commit/51288696e042fda6e591ee7cf8a46c6547d46fcd))
* **dashboard:** align cost details and audit page consistency ([#1129](https://github.com/The-Vibe-Company/armada/issues/1129)) ([f89e651](https://github.com/The-Vibe-Company/armada/commit/f89e651ab8546eb43cdac3d48a7929c5c1c72b64))
* **dashboard:** bound control requests without flattening contracts ([#1064](https://github.com/The-Vibe-Company/armada/issues/1064)) ([9911e6e](https://github.com/The-Vibe-Company/armada/commit/9911e6e2e82ef0b0750f231505f61bcd8ac89e31))
* **dashboard:** confirm destructive Settings actions ([#1044](https://github.com/The-Vibe-Company/armada/issues/1044)) ([7a18c31](https://github.com/The-Vibe-Company/armada/commit/7a18c31293ba8687b713e363c533a4597d5468bb))
* **dashboard:** link templates to their launch ingredients ([#1143](https://github.com/The-Vibe-Company/armada/issues/1143)) ([6c2d167](https://github.com/The-Vibe-Company/armada/commit/6c2d167fca4a07b673aac0c000c893e851a720c3))
* **dashboard:** recover failed chat reads and stop after access loss ([#1102](https://github.com/The-Vibe-Company/armada/issues/1102)) ([7e33825](https://github.com/The-Vibe-Company/armada/commit/7e338257f9bb94453700ed691729676c7ee8e283))
* **dashboard:** report landing clipboard failures ([#1126](https://github.com/The-Vibe-Company/armada/issues/1126)) ([368423d](https://github.com/The-Vibe-Company/armada/commit/368423dcb1d5d1db3fd5bc48982f25e67116639f))
* **dashboard:** show how navigation building blocks fit together ([#1040](https://github.com/The-Vibe-Company/armada/issues/1040)) ([0c92ba8](https://github.com/The-Vibe-Company/armada/commit/0c92ba86048b25f86ef5110d2cd354e3265e149d))
* **dashboard:** simplify account forms and focus sign-in errors ([#1122](https://github.com/The-Vibe-Company/armada/issues/1122)) ([10d8824](https://github.com/The-Vibe-Company/armada/commit/10d8824276b80675e5cd7661f89326eed722b34e))
* **dashboard:** standardize command palette controls ([#1119](https://github.com/The-Vibe-Company/armada/issues/1119)) ([5d59daa](https://github.com/The-Vibe-Company/armada/commit/5d59daad3734407f2571a256cdc1d97bcd5054e5))
* **db:** give the routines migration its own version ([#1029](https://github.com/The-Vibe-Company/armada/issues/1029)) ([9bee25c](https://github.com/The-Vibe-Company/armada/commit/9bee25cd66c5ef09dab3e71c6688317b5eb4137a))
* **docs:** deliver reviewed Armada recovery guidance ([#1098](https://github.com/The-Vibe-Company/armada/issues/1098)) ([710daa0](https://github.com/The-Vibe-Company/armada/commit/710daa026a53234d83e9759260f86b65b27843a6))
* **github:** distinguish validation outages from corrupt credentials ([#1139](https://github.com/The-Vibe-Company/armada/issues/1139)) ([04ed1b3](https://github.com/The-Vibe-Company/armada/commit/04ed1b3d41af4f117d165a07c30ca8c9fe858890))
* **github:** recover a published token after refresh contention ([#1061](https://github.com/The-Vibe-Company/armada/issues/1061)) ([2bc99f1](https://github.com/The-Vibe-Company/armada/commit/2bc99f1bda37be1f6309d7047fdd71a2ffd3b737))
* **ios:** ignore stale conversation reads on slow networks ([#1120](https://github.com/The-Vibe-Company/armada/issues/1120)) ([a008cb5](https://github.com/The-Vibe-Company/armada/commit/a008cb5eedd9842f17127f5426fb3e51d5117689))
* **ios:** improve large-text readability and link contrast ([#1131](https://github.com/The-Vibe-Company/armada/issues/1131)) ([ecef848](https://github.com/The-Vibe-Company/armada/commit/ecef8481e476c791f08ccac17a1412a257d0093b))
* **ios:** reuse rendered conversations between opens ([#1077](https://github.com/The-Vibe-Company/armada/issues/1077)) ([2d63d7e](https://github.com/The-Vibe-Company/armada/commit/2d63d7e1b1a956b04271d13ee81b0b1c72a5bcfd))
* **mcp:** preserve scoped golden build warnings ([#1074](https://github.com/The-Vibe-Company/armada/issues/1074)) ([973f300](https://github.com/The-Vibe-Company/armada/commit/973f3007dd0a808ff5ce1834d7fab86cf2c2a304))
* **sandbox:** align Modal scope for Armada access parents ([#1151](https://github.com/The-Vibe-Company/armada/issues/1151)) ([5c82ad3](https://github.com/The-Vibe-Company/armada/commit/5c82ad33b420f3b63b3cf8894df0f0df1932a110))
* **security:** enforce bounded server ingress ([#1093](https://github.com/The-Vibe-Company/armada/issues/1093)) ([860a48e](https://github.com/The-Vibe-Company/armada/commit/860a48e72a9abf86cef34df557bd542faa9488fe))
* **server:** bound control bodies and classify token failures ([#1085](https://github.com/The-Vibe-Company/armada/issues/1085)) ([a592e6f](https://github.com/The-Vibe-Company/armada/commit/a592e6fa370b6120eb004a5348a56da94a98e55b))
* **server:** bound fresh Supabase identity verification ([#1091](https://github.com/The-Vibe-Company/armada/issues/1091)) ([29d601a](https://github.com/The-Vibe-Company/armada/commit/29d601abf05bcf32acba68923502492238e779f6))
* **server:** bound outstanding provider lifecycle observations ([#1117](https://github.com/The-Vibe-Company/armada/issues/1117)) ([6848f68](https://github.com/The-Vibe-Company/armada/commit/6848f68d09b42dd27e8e030f1fc1b791a6723108))
* **server:** fence late observations after lease expiry ([#1118](https://github.com/The-Vibe-Company/armada/issues/1118)) ([257afc4](https://github.com/The-Vibe-Company/armada/commit/257afc472666da44ff72a09f9bf2093c42ddfa0e))
* **server:** gate boot and readiness on required schema version ([#1142](https://github.com/The-Vibe-Company/armada/issues/1142)) ([f0ce88f](https://github.com/The-Vibe-Company/armada/commit/f0ce88f234e46330fcc70ba98d19acee85a1b7e1))
* **server:** preserve safe launch error details over MCP-to-HTTP ([#1080](https://github.com/The-Vibe-Company/armada/issues/1080)) ([ae25d2c](https://github.com/The-Vibe-Company/armada/commit/ae25d2c577a008c3232b6424ff1d74fa60fbbd3a))
* **server:** report removed-owner cleanup blockage ([#1090](https://github.com/The-Vibe-Company/armada/issues/1090)) ([7bfff29](https://github.com/The-Vibe-Company/armada/commit/7bfff290b3d180022e1710ab488d3835e29f75b1))
* **staging:** diagnose scoped access launch refusals ([#1136](https://github.com/The-Vibe-Company/armada/issues/1136)) ([b8e6a9f](https://github.com/The-Vibe-Company/armada/commit/b8e6a9f83aa97adc8a3a29813a794e70639022b1))
* **tests:** distinguish portable and native runtime artifacts ([#1150](https://github.com/The-Vibe-Company/armada/issues/1150)) ([920a597](https://github.com/The-Vibe-Company/armada/commit/920a5976915b44e9cc18dc7d581d6eaff00d8286))
* **usage:** match Boat Codex input framing and explain missing counters ([#1016](https://github.com/The-Vibe-Company/armada/issues/1016)) ([58e8aa0](https://github.com/The-Vibe-Company/armada/commit/58e8aa076bf5b1474cf749743443c6f7d41ec080))


### Performance Improvements

* **api:** separate dispatch scaffolding from handler timing ([#1144](https://github.com/The-Vibe-Company/armada/issues/1144)) ([a39123c](https://github.com/The-Vibe-Company/armada/commit/a39123c3672bba171d15eef8b98eb1260a3d02f4))
* **ios:** reduce repeated copying in streamed history projection ([#1134](https://github.com/The-Vibe-Company/armada/issues/1134)) ([630f5e7](https://github.com/The-Vibe-Company/armada/commit/630f5e73ce1410aac4d44574fe5a2794886d00e0))
* **modal:** avoid duplicate pre-preparation runner health probe ([#1046](https://github.com/The-Vibe-Company/armada/issues/1046)) ([a8d9961](https://github.com/The-Vibe-Company/armada/commit/a8d996186f3d1dabbfd82e510e4d79dd19f9623d))

## [2.22.0](https://github.com/The-Vibe-Company/armada/compare/v2.21.0...v2.22.0) (2026-11-11)


### Features

* **routines:** schedule owner-scoped template launches ([#1014](https://github.com/The-Vibe-Company/armada/issues/1014)) ([0cea355](https://github.com/The-Vibe-Company/armada/commit/0cea355ab3b73d81b9e6d82f7bf6af20ec3cc636))


### Bug Fixes

* **dashboard:** keep Sandbox toolbar sort paired at every width ([#1018](https://github.com/The-Vibe-Company/armada/issues/1018)) ([72a16ce](https://github.com/The-Vibe-Company/armada/commit/72a16ce152c58627203c85b86452dfc4463703bf))
* **ios:** preserve server explanations in sandbox and auth failures ([#1021](https://github.com/The-Vibe-Company/armada/issues/1021)) ([3a6166d](https://github.com/The-Vibe-Company/armada/commit/3a6166dcb931d2b392bd3454815c03931b6d6148))
* **models:** refuse unhonoured Claude Fable selection on Boat ([#866](https://github.com/The-Vibe-Company/armada/issues/866)) ([f469e46](https://github.com/The-Vibe-Company/armada/commit/f469e462b3bb89c80474138bd32aadceb9bd782d))
* **test:** isolate Git credential tests from managed host credentials ([#1024](https://github.com/The-Vibe-Company/armada/issues/1024)) ([fc6b3ed](https://github.com/The-Vibe-Company/armada/commit/fc6b3ed652b761ea6fdfbe647e5ddaa960f7b866))

## [2.21.0](https://github.com/The-Vibe-Company/armada/compare/v2.20.0...v2.21.0) (2026-11-11)


### Features

* **cli:** recommend public skills without network checks ([#988](https://github.com/The-Vibe-Company/armada/issues/988)) ([c910fcb](https://github.com/The-Vibe-Company/armada/commit/c910fcb6bf8ff96f683d1cd119b97b684a84c11d))
* **routines:** add paused routine configuration API ([#1011](https://github.com/The-Vibe-Company/armada/issues/1011)) ([4a0a330](https://github.com/The-Vibe-Company/armada/commit/4a0a33096bee87b9cd74412dc8191997f76a2d43))
* **sandbox:** accept private Skillpack launch pins ([#999](https://github.com/The-Vibe-Company/armada/issues/999)) ([c655b89](https://github.com/The-Vibe-Company/armada/commit/c655b894fd095fad7a94b9eae917d90d69843e79))
* **sandbox:** opt into scoped Armada access ([#1002](https://github.com/The-Vibe-Company/armada/issues/1002)) ([63c3a94](https://github.com/The-Vibe-Company/armada/commit/63c3a943176f45a503231804f6e2ef1eba5c8d0f))
* **skill:** document the Armada sandbox CLI with drift checks ([#1003](https://github.com/The-Vibe-Company/armada/issues/1003)) ([b0893fb](https://github.com/The-Vibe-Company/armada/commit/b0893fb2fced1327f399999bd98f26cf46661317))
* **skillpack:** expose connection readiness and propose one-click consent ([#1012](https://github.com/The-Vibe-Company/armada/issues/1012)) ([8278b6e](https://github.com/The-Vibe-Company/armada/commit/8278b6e0c8a27f09b608f3f53c0c98521f78c91f))
* **templates:** retain skill installation evidence ([#1009](https://github.com/The-Vibe-Company/armada/issues/1009)) ([51cdf91](https://github.com/The-Vibe-Company/armada/commit/51cdf91cc022b4b30b78b0cf48a6c78f66d79f18))


### Bug Fixes

* **ci:** pre-bake Dashboard e2e system dependencies ([#998](https://github.com/The-Vibe-Company/armada/issues/998)) ([8fbaca8](https://github.com/The-Vibe-Company/armada/commit/8fbaca8cfefc0c18e7e2525541121c726742f04f))
* **cli:** drain log backlogs without polling delays ([#981](https://github.com/The-Vibe-Company/armada/issues/981)) ([5cde1ae](https://github.com/The-Vibe-Company/armada/commit/5cde1ae4f38c02e56186ae79eb4ed60189486530))
* **cli:** explain sandbox failures with safe recovery guidance ([#996](https://github.com/The-Vibe-Company/armada/issues/996)) ([8582f05](https://github.com/The-Vibe-Company/armada/commit/8582f058b7f4cead3a3c7e97c1e6ca054b78a92f))
* **dashboard:** rebuild Sandboxes filters and responsive design ([#1010](https://github.com/The-Vibe-Company/armada/issues/1010)) ([a7c8a71](https://github.com/The-Vibe-Company/armada/commit/a7c8a711eb9de429e6b75316aa70cad5fbfed302))
* **dashboard:** standardize Build controls and detail layout ([#1004](https://github.com/The-Vibe-Company/armada/issues/1004)) ([fd5028c](https://github.com/The-Vibe-Company/armada/commit/fd5028c4f33834b45ef6f2468e2a05bae43b97ec))
* **deploy:** allow Railway time to drain admitted work ([#990](https://github.com/The-Vibe-Company/armada/issues/990)) ([3871c72](https://github.com/The-Vibe-Company/armada/commit/3871c72cb6480244d22073e386823479fc156089))
* **ios:** explain sandbox launch credential failures ([#974](https://github.com/The-Vibe-Company/armada/issues/974)) ([64c7fd0](https://github.com/The-Vibe-Company/armada/commit/64c7fd0e6c36744b921a61b680531e521f033c45))
* **ios:** preserve unconfirmed sandbox sends across relaunch ([#992](https://github.com/The-Vibe-Company/armada/issues/992)) ([9a5d060](https://github.com/The-Vibe-Company/armada/commit/9a5d060d0e07266be2d184909d531a967ab64d92))
* **runtime:** detect unstartable Boat harnesses and explain startup failures ([#967](https://github.com/The-Vibe-Company/armada/issues/967)) ([1d6fd31](https://github.com/The-Vibe-Company/armada/commit/1d6fd31164c5512c447abb132ac4932e842f758a))
* **sandbox:** converge Boat stops without replaying lifecycle work ([#995](https://github.com/The-Vibe-Company/armada/issues/995)) ([cffe544](https://github.com/The-Vibe-Company/armada/commit/cffe54441b2b7eed66586a83e34849ec812e1519))
* **server:** drain admitted requests on process termination ([#975](https://github.com/The-Vibe-Company/armada/issues/975)) ([b234d3e](https://github.com/The-Vibe-Company/armada/commit/b234d3effc900b5b618db7ec95d35fc5294ed44c))
* **server:** report database unavailability in runtime readiness ([#991](https://github.com/The-Vibe-Company/armada/issues/991)) ([6bb9416](https://github.com/The-Vibe-Company/armada/commit/6bb9416d5feb9f91aa6c3b4f1bacf03e50c1ed4e))
* **templates:** preserve launch receipts across publication failures ([#1000](https://github.com/The-Vibe-Company/armada/issues/1000)) ([03b287d](https://github.com/The-Vibe-Company/armada/commit/03b287d593fa943eea9693eb2a6968283beac25c))
* **usage:** restore session token display and cache-write costs ([#927](https://github.com/The-Vibe-Company/armada/issues/927)) ([07ff101](https://github.com/The-Vibe-Company/armada/commit/07ff1015a7680c1db31a30068ef730ddf33a3f66))


### Performance Improvements

* **dashboard:** avoid quadratic legacy chat chunk accumulation ([#982](https://github.com/The-Vibe-Company/armada/issues/982)) ([45583b8](https://github.com/The-Vibe-Company/armada/commit/45583b812e66342ca307569c75adc78f1fae7208))
* remove redundant provider work from sandbox reads ([#1013](https://github.com/The-Vibe-Company/armada/issues/1013)) ([22a901f](https://github.com/The-Vibe-Company/armada/commit/22a901f8eed66d770e26936dd0334b0f77bf778d))

## [2.20.0](https://github.com/The-Vibe-Company/armada/compare/v2.19.0...v2.20.0) (2026-11-11)


### Features

* **cli:** create, publish and launch templates ([#950](https://github.com/The-Vibe-Company/armada/issues/950)) ([61e9379](https://github.com/The-Vibe-Company/armada/commit/61e93793ef5fffd8e8f0542f693ada6e897ad88d))
* **cli:** manage variables and write-only secrets ([#937](https://github.com/The-Vibe-Company/armada/issues/937)) ([05e6366](https://github.com/The-Vibe-Company/armada/commit/05e63660c540edb6b0478d0389c67dbb763428c7))
* **dashboard:** add and replace the Skillpack key in Build &gt; Skills ([#961](https://github.com/The-Vibe-Company/armada/issues/961)) ([6b2cffa](https://github.com/The-Vibe-Company/armada/commit/6b2cffa3d358cd60748a97219164d4204ddc4fbd))
* **dashboard:** Build &gt; Templates page and launch from a template ([#951](https://github.com/The-Vibe-Company/armada/issues/951)) ([5ab0acd](https://github.com/The-Vibe-Company/armada/commit/5ab0acd872e24f92be9561266d51c38713a198e3))
* **dashboard:** Build &gt; Variables page for variables and write-only secrets ([#939](https://github.com/The-Vibe-Company/armada/issues/939)) ([b81d398](https://github.com/The-Vibe-Company/armada/commit/b81d3988e6c73981775d7cd15af30d74b2a6146f))
* **golden:** install the inert Armada helper with a verified receipt ([#928](https://github.com/The-Vibe-Company/armada/issues/928)) ([d3439cb](https://github.com/The-Vibe-Company/armada/commit/d3439cb29752c323cd4f92ceee6fca70bba31264))
* **secrets:** gate secret-tainted sandbox preservation and reuse ([#958](https://github.com/The-Vibe-Company/armada/issues/958)) ([fca5f6b](https://github.com/The-Vibe-Company/armada/commit/fca5f6b199c9a891409ed6f29c59d5da9d9b794b))
* **skillpack:** accept any valid Skillpack key ([#965](https://github.com/The-Vibe-Company/armada/issues/965)) ([251df48](https://github.com/The-Vibe-Company/armada/commit/251df487da7fcd4959fc3025a14a0355c13409ce))
* **templates:** add launch preset revisions and shared API ([#938](https://github.com/The-Vibe-Company/armada/issues/938)) ([e9737b1](https://github.com/The-Vibe-Company/armada/commit/e9737b116d6a327241fa53a82452aa9512df04ca))


### Bug Fixes

* **cli:** include variable values in explicit JSON reads ([#945](https://github.com/The-Vibe-Company/armada/issues/945)) ([44b6d64](https://github.com/The-Vibe-Company/armada/commit/44b6d64e021436c19e9060ea8c02a1258bb4639f))
* **deploy:** recover from database admission pressure at boot ([#924](https://github.com/The-Vibe-Company/armada/issues/924)) ([0da44a3](https://github.com/The-Vibe-Company/armada/commit/0da44a3e1547a5778c0b1ec88587f416da4ab6fb))
* **github:** diagnose early shared token rotation ([#953](https://github.com/The-Vibe-Company/armada/issues/953)) ([320d61b](https://github.com/The-Vibe-Company/armada/commit/320d61bec04617535b857e68088c7ff974b628ff))
* **github:** repair legacy Boat token hydration ([#925](https://github.com/The-Vibe-Company/armada/issues/925)) ([94f41a8](https://github.com/The-Vibe-Company/armada/commit/94f41a82d893fef3ae457272819604ac4c862c8f))
* **golden:** correct Boat snapshot names and report safe refusals ([#932](https://github.com/The-Vibe-Company/armada/issues/932)) ([2a56383](https://github.com/The-Vibe-Company/armada/commit/2a5638363a7fddfa79056c5b4c0c1b2752c1366f))
* **ios:** decode 2.19 orchestrator receipts and explain create failures ([#943](https://github.com/The-Vibe-Company/armada/issues/943)) ([67cb7dd](https://github.com/The-Vibe-Company/armada/commit/67cb7dd44e596815f7f93b7f12ee08c530a2b18b))
* **ios:** never fail to decode when the server adds a state, reason or kind ([#963](https://github.com/The-Vibe-Company/armada/issues/963)) ([f62b645](https://github.com/The-Vibe-Company/armada/commit/f62b645601729d3f397b2c2d8e03f67f27c90b39))
* **orchestrators:** preserve busy account refusal before allocation ([#959](https://github.com/The-Vibe-Company/armada/issues/959)) ([faa8d04](https://github.com/The-Vibe-Company/armada/commit/faa8d049be26167700b54e56c07130c80ba34339))
* **orchestrator:** wait for requested skills before reporting ready ([#946](https://github.com/The-Vibe-Company/armada/issues/946)) ([dd44317](https://github.com/The-Vibe-Company/armada/commit/dd44317d9feae557b23497ca40e6d5185cc14b2b))
* **sandbox:** trace work-preservation attempts and stop ordering ([#929](https://github.com/The-Vibe-Company/armada/issues/929)) ([378cbd0](https://github.com/The-Vibe-Company/armada/commit/378cbd04f1df454f6324c03d30bb00a1b1a8a8e7))
* **templates:** report unavailable model accounts at launch ([#960](https://github.com/The-Vibe-Company/armada/issues/960)) ([3477e1c](https://github.com/The-Vibe-Company/armada/commit/3477e1cf7003a53befe9a69f47126756df5d200a))
* **vault:** answer a readable conflict when a revoked name is reused ([#940](https://github.com/The-Vibe-Company/armada/issues/940)) ([b6144c3](https://github.com/The-Vibe-Company/armada/commit/b6144c386ba1a9cc0485f2aee6db78063484f415))

## [2.19.0](https://github.com/The-Vibe-Company/armada/compare/v2.18.0...v2.19.0) (2026-11-11)


### Features

* **orchestrators:** manage coordinator MCP connections ([#806](https://github.com/The-Vibe-Company/armada/issues/806)) ([68cc809](https://github.com/The-Vibe-Company/armada/commit/68cc80917af35599863c1d82f3372acf6e1bb25a))
* **vault:** add readable variables and write-only application secrets ([#921](https://github.com/The-Vibe-Company/armada/issues/921)) ([4ce8a6b](https://github.com/The-Vibe-Company/armada/commit/4ce8a6b9b0535f92c8950b9e5689e427a3714721))


### Bug Fixes

* **boat:** retry preservation exec while compute becomes ready ([#915](https://github.com/The-Vibe-Company/armada/issues/915)) ([545b6d2](https://github.com/The-Vibe-Company/armada/commit/545b6d25ac48f0a5c0e6d317d3e91523daa29feb))
* **dashboard:** create an environment in a dialog, not a side panel ([#901](https://github.com/The-Vibe-Company/armada/issues/901)) ([dcd0749](https://github.com/The-Vibe-Company/armada/commit/dcd07495b033f335ee99ddfddadf546738402122))
* **github:** forward credential refresh through dashboard proxy ([#911](https://github.com/The-Vibe-Company/armada/issues/911)) ([1bfd0df](https://github.com/The-Vibe-Company/armada/commit/1bfd0dfba5b96af9f3bf1b06255c0a20e2aba28e))
* **golden:** surface Boat payment refusals without phantom recovery ([#919](https://github.com/The-Vibe-Company/armada/issues/919)) ([420f3bd](https://github.com/The-Vibe-Company/armada/commit/420f3bd67dba529afbe5a94afa26502b5d78e141))
* **launch:** delay and log ownership retry outcomes ([#913](https://github.com/The-Vibe-Company/armada/issues/913)) ([276a2f0](https://github.com/The-Vibe-Company/armada/commit/276a2f0caf6c51d1c4b155e1629cf4a8d02ba14b))
* **skillpack:** authorize the private install key on Modal without root login ([#930](https://github.com/The-Vibe-Company/armada/issues/930)) ([cccdaa4](https://github.com/The-Vibe-Company/armada/commit/cccdaa461d47c9dcb0515d94d4c6ff4e6596f6ef))
* **skillpack:** diagnose Modal private SSH transport and settle failed creates ([#916](https://github.com/The-Vibe-Company/armada/issues/916)) ([a2fc32e](https://github.com/The-Vibe-Company/armada/commit/a2fc32ea99c8e425bc286d2bf9b3ef6d54b95e0d))

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
