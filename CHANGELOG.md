# Changelog

## [2.32.0](https://github.com/The-Vibe-Company/armada/compare/v2.31.0...v2.32.0) (2026-11-14)


### Features

* **boat:** deliver frozen runtime readable variables ([#1760](https://github.com/The-Vibe-Company/armada/issues/1760)) ([06e9f4e](https://github.com/The-Vibe-Company/armada/commit/06e9f4e56da5285be8d79a29b03ef221e079cdc0))
* **cli:** isolate named login profiles and server selection ([#1750](https://github.com/The-Vibe-Company/armada/issues/1750)) ([e98aded](https://github.com/The-Vibe-Company/armada/commit/e98adedd0d22147d96530306a45e40892bd483d1))
* **golden:** find active rebuilds without an admission receipt ([#1747](https://github.com/The-Vibe-Company/armada/issues/1747)) ([3d7e02a](https://github.com/The-Vibe-Company/armada/commit/3d7e02aeadb54f7cb6af241d69ffa9f9cfee03b9))
* **golden:** support explicit per-repository shallow history ([#1761](https://github.com/The-Vibe-Company/armada/issues/1761)) ([030c66a](https://github.com/The-Vibe-Company/armada/commit/030c66a94aa1f994969b1f753e5ad1d66d34487c))
* **modal:** support promptless launch and durable first send ([#1753](https://github.com/The-Vibe-Company/armada/issues/1753)) ([0d4e1f7](https://github.com/The-Vibe-Company/armada/commit/0d4e1f79791b6b755269285d4f01fcbd230106a9))
* **modal:** support promptless pinned template launches ([#1758](https://github.com/The-Vibe-Company/armada/issues/1758)) ([2fe2e81](https://github.com/The-Vibe-Company/armada/commit/2fe2e8161fc4de9202e2b76815f5f6cff13d0690))
* **smoke:** observe natural idle pause and ordinary-send wake ([#1715](https://github.com/The-Vibe-Company/armada/issues/1715)) ([b161259](https://github.com/The-Vibe-Company/armada/commit/b1612592d484eda6a66a96be6c68f6912896f6f0))
* **smoke:** print per-feature account and cost details ([#1702](https://github.com/The-Vibe-Company/armada/issues/1702)) ([5bffe25](https://github.com/The-Vibe-Company/armada/commit/5bffe2591d7fd00a46680d357548ddea895e7532))
* **smoke:** prove configured template revision launches ([#1724](https://github.com/The-Vibe-Company/armada/issues/1724)) ([d9e022b](https://github.com/The-Vibe-Company/armada/commit/d9e022b7a67e28945409b14f512cfe3c3c2e5493))
* **smoke:** prove launch from provider golden snapshots ([#1720](https://github.com/The-Vibe-Company/armada/issues/1720)) ([646f02c](https://github.com/The-Vibe-Company/armada/commit/646f02c50d5b6ed08395f8112880b26f9e82eadd))
* **smoke:** prove scheduled routine initial execution ([#1752](https://github.com/The-Vibe-Company/armada/issues/1752)) ([39fcf5c](https://github.com/The-Vibe-Company/armada/commit/39fcf5caf638cd677ff9103c881f1a32d3aa1a3e))


### Bug Fixes

* **cli:** explain org-scoped token UUID retries ([#1736](https://github.com/The-Vibe-Company/armada/issues/1736)) ([4e5dc41](https://github.com/The-Vibe-Company/armada/commit/4e5dc41e34305c94b0f19f9649b05fab5ece8123))
* **cli:** make status recorded by default with live opt-in ([#1738](https://github.com/The-Vibe-Company/armada/issues/1738)) ([d1867ff](https://github.com/The-Vibe-Company/armada/commit/d1867ff12dbfe26972fd8569db8161d4f859860d))
* **cli:** prompt for credentials without terminal echo ([#1730](https://github.com/The-Vibe-Company/armada/issues/1730)) ([6ca5eb8](https://github.com/The-Vibe-Company/armada/commit/6ca5eb8937c1a44b828378497477ce3b9b5ba613))
* **cli:** require consent for golden config replacement ([#1740](https://github.com/The-Vibe-Company/armada/issues/1740)) ([6c20368](https://github.com/The-Vibe-Company/armada/commit/6c20368e7b803ad4f819126eb293b8e274a1b136))
* **cli:** resolve golden removal names without guessing ([#1759](https://github.com/The-Vibe-Company/armada/issues/1759)) ([b6eaa54](https://github.com/The-Vibe-Company/armada/commit/b6eaa54b1dc68d59c735c957d1c1390c50acd4f1))
* **core:** preserve golden operation admission cause ([#1717](https://github.com/The-Vibe-Company/armada/issues/1717)) ([08e822f](https://github.com/The-Vibe-Company/armada/commit/08e822f2550bd9f3a72cd81986c8793c6a399801))
* **dashboard:** clarify snapshot recovery states ([#1746](https://github.com/The-Vibe-Company/armada/issues/1746)) ([2f589e0](https://github.com/The-Vibe-Company/armada/commit/2f589e07e40bd63711ce9c75b090194d2487d55e))
* **github:** distinguish caller connection from runtime delivery failures ([#1749](https://github.com/The-Vibe-Company/armada/issues/1749)) ([e29072c](https://github.com/The-Vibe-Company/armada/commit/e29072c2315f571412fa52555f190c9fc9522387))
* **golden:** report safe secret scan locations and history evidence ([#1757](https://github.com/The-Vibe-Company/armada/issues/1757)) ([da06b25](https://github.com/The-Vibe-Company/armada/commit/da06b25dda4f47e573c454dc1461ef19430e9e72))
* **lifecycle:** isolate stalled provider recovery capacity ([#1764](https://github.com/The-Vibe-Company/armada/issues/1764)) ([9a9a892](https://github.com/The-Vibe-Company/armada/commit/9a9a892c7790d552941852135244d432816300ef))
* **lint:** eliminate baseline warning and info noise ([#1763](https://github.com/The-Vibe-Company/armada/issues/1763)) ([afd6ee2](https://github.com/The-Vibe-Company/armada/commit/afd6ee21c285ce34d894ec05bdb87d021c0823f0))
* **mcp:** add durable ordinary launch idempotency receipts ([#1748](https://github.com/The-Vibe-Company/armada/issues/1748)) ([f01e58c](https://github.com/The-Vibe-Company/armada/commit/f01e58c0b15b4272db16e2df32d688fb0ce0aa79))
* **runtime:** batch event archive queries under sandbox fence ([#1762](https://github.com/The-Vibe-Company/armada/issues/1762)) ([22476c4](https://github.com/The-Vibe-Company/armada/commit/22476c43aa6ba0e13f368816e8414065e8724881))
* **runtime:** bound command bodies before buffering ([#1756](https://github.com/The-Vibe-Company/armada/issues/1756)) ([388b4e5](https://github.com/The-Vibe-Company/armada/commit/388b4e56fbf96901afb18d00b9e7fd565d82417d))
* **runtime:** retain managed GitHub tools in login shells ([#1754](https://github.com/The-Vibe-Company/armada/issues/1754)) ([c19f1ea](https://github.com/The-Vibe-Company/armada/commit/c19f1ea3483f1499c176fa0683703f35d6f92881))

## [2.31.0](https://github.com/The-Vibe-Company/armada/compare/v2.30.0...v2.31.0) (2026-11-14)


### Features

* **golden:** append repositories safely and explain CLI refusals ([#1705](https://github.com/The-Vibe-Company/armada/issues/1705)) ([f30c7bb](https://github.com/The-Vibe-Company/armada/commit/f30c7bbdfc2e7d0b958a6b11b0eed08471ec8db0))
* **smoke:** prove configured harness parity with real turns ([#1712](https://github.com/The-Vibe-Company/armada/issues/1712)) ([f681c90](https://github.com/The-Vibe-Company/armada/commit/f681c905a709484d426ae8e14519b4f57802b737))
* **smoke:** prove steer and interrupt turn outcomes ([#1714](https://github.com/The-Vibe-Company/armada/issues/1714)) ([dc2b343](https://github.com/The-Vibe-Company/armada/commit/dc2b343bbff6f9f97b1fe26ad6c6788faaa6bf97))


### Bug Fixes

* **cli:** diagnose and preserve native Codex device login ([#1708](https://github.com/The-Vibe-Company/armada/issues/1708)) ([0306a6f](https://github.com/The-Vibe-Company/armada/commit/0306a6f3bc9e9fb597dbc18f4d71785dee84473d))
* **core:** expire unstarted queued golden builds safely ([#1701](https://github.com/The-Vibe-Company/armada/issues/1701)) ([76500cb](https://github.com/The-Vibe-Company/armada/commit/76500cb3e7c763ad2ab2909badea163632e10578))
* **golden:** accept Git authentication challenges and preserve clone reasons ([#1706](https://github.com/The-Vibe-Company/armada/issues/1706)) ([214d9f2](https://github.com/The-Vibe-Company/armada/commit/214d9f2323e9537f064e72914ce20c6738af0c68))
* **golden:** release expired pre-builder authorization reservations ([#1709](https://github.com/The-Vibe-Company/armada/issues/1709)) ([78ca13d](https://github.com/The-Vibe-Company/armada/commit/78ca13d392122a7f6928f1bc19467cf6817914c8))
* **golden:** scope checkout credentials per GitHub installation ([#1713](https://github.com/The-Vibe-Company/armada/issues/1713)) ([9276e7f](https://github.com/The-Vibe-Company/armada/commit/9276e7f388a49370b4e012e993620f4ede32c8f9))
* **usage:** classify subscription costs in parity receipts ([#1710](https://github.com/The-Vibe-Company/armada/issues/1710)) ([10018e9](https://github.com/The-Vibe-Company/armada/commit/10018e9b65e1835df4627d29efa7e9d0fb8e7c07))

## [2.30.0](https://github.com/The-Vibe-Company/armada/compare/v2.29.0...v2.30.0) (2026-11-14)


### Features

* **accounts:** show billing identity and safely switch retained runtimes ([#1635](https://github.com/The-Vibe-Company/armada/issues/1635)) ([a3510cc](https://github.com/The-Vibe-Company/armada/commit/a3510ccd8647c837c1ecc6f065a5786402097857))
* **cli:** connect accounts with shared provider presets ([#1622](https://github.com/The-Vibe-Company/armada/issues/1622)) ([b5bbce5](https://github.com/The-Vibe-Company/armada/commit/b5bbce5245653bbc6a21f3004c0f0e5c4302e365))
* **cli:** show GitHub connection and repository scope in doctor ([#1658](https://github.com/The-Vibe-Company/armada/issues/1658)) ([4a6f70d](https://github.com/The-Vibe-Company/armada/commit/4a6f70db70e60ed40094ae95948f49a65f6a9e88))
* **docker:** accept queued prompts during sandbox startup ([#1682](https://github.com/The-Vibe-Company/armada/issues/1682)) ([a9b72e5](https://github.com/The-Vibe-Company/armada/commit/a9b72e5d9dec1a2e55b57b5d3326c00990dcc26d))
* **golden:** cancel owned queued builds from CLI and dashboard ([#1703](https://github.com/The-Vibe-Company/armada/issues/1703)) ([700866b](https://github.com/The-Vibe-Company/armada/commit/700866b388e3dac78020d34f73a2c608f6a8d535))
* **lifecycle:** pause idle native sandboxes safely ([#1605](https://github.com/The-Vibe-Company/armada/issues/1605)) ([fb18933](https://github.com/The-Vibe-Company/armada/commit/fb18933bafb45864aef5022f7ab02b70696e84f6))
* **modal:** admit Claude through the common runtime ([#1665](https://github.com/The-Vibe-Company/armada/issues/1665)) ([2d3c260](https://github.com/The-Vibe-Company/armada/commit/2d3c260a68fdc827386505e1e2737f4d5ab2d64d))
* **modal:** admit OpenCode through the common runtime ([#1670](https://github.com/The-Vibe-Company/armada/issues/1670)) ([b06a3c8](https://github.com/The-Vibe-Company/armada/commit/b06a3c869f7e7cd57fd491d160b319047588a1f0))
* **modal:** prepare workspaces through enrolled runtime commands ([#1669](https://github.com/The-Vibe-Company/armada/issues/1669)) ([f3b5ee5](https://github.com/The-Vibe-Company/armada/commit/f3b5ee561cfd4fcd4d8c6b842274a143f1a9c6cf))
* **modal:** route enrolled runtime control operations ([#1663](https://github.com/The-Vibe-Company/armada/issues/1663)) ([bd8933b](https://github.com/The-Vibe-Company/armada/commit/bd8933b22d086f94af99bc8bf87931fba50e7e41))
* **modal:** share runtime subscription account ownership ([#1667](https://github.com/The-Vibe-Company/armada/issues/1667)) ([870b0c9](https://github.com/The-Vibe-Company/armada/commit/870b0c90d1296d66f2bf7ddb172d3da8b3227a9b))
* **opencode:** support native Anthropic Messages accounts ([#1614](https://github.com/The-Vibe-Company/armada/issues/1614)) ([cd0136f](https://github.com/The-Vibe-Company/armada/commit/cd0136f3f97e615a3bb63e452cb56f28546ccb47))
* **opencode:** support native Azure v1 accounts ([#1616](https://github.com/The-Vibe-Company/armada/issues/1616)) ([63077ca](https://github.com/The-Vibe-Company/armada/commit/63077caf9ade63289fbfcdce215c68b15f1b996c))
* **opencode:** support native OpenAI Responses accounts ([#1625](https://github.com/The-Vibe-Company/armada/issues/1625)) ([c0f8d26](https://github.com/The-Vibe-Company/armada/commit/c0f8d26b851914d81fa86f3fecda1bd70bfdcf81))
* **runtime:** support idle Boat launch and first send ([#1621](https://github.com/The-Vibe-Company/armada/issues/1621)) ([30260f9](https://github.com/The-Vibe-Company/armada/commit/30260f900090319fdf680e90737a6bc4f771d5a8))
* **server:** expose the applied idle-pause delay ([#1607](https://github.com/The-Vibe-Company/armada/issues/1607)) ([2aa814c](https://github.com/The-Vibe-Company/armada/commit/2aa814c5347f7d9e5ae66510ef6757806f3e823f))
* **smoke:** opt in to coordinator production Boat parity ([#1609](https://github.com/The-Vibe-Company/armada/issues/1609)) ([8354755](https://github.com/The-Vibe-Company/armada/commit/83547559ef8bdcef0680e541d495da6590c78529))
* **smoke:** probe GitHub clone and push authorization parity ([#1617](https://github.com/The-Vibe-Company/armada/issues/1617)) ([6bf16f7](https://github.com/The-Vibe-Company/armada/commit/6bf16f7b93bdb7f96c517c3af7b436cf2fe60c4e))


### Bug Fixes

* **accounts:** validate Azure deployments before saving ([#1700](https://github.com/The-Vibe-Company/armada/issues/1700)) ([9048a54](https://github.com/The-Vibe-Company/armada/commit/9048a5433bd3060ca3f87e652615e0bdf6527259))
* **boat:** retain mutable events across forward log cursors ([#1629](https://github.com/The-Vibe-Company/armada/issues/1629)) ([3573090](https://github.com/The-Vibe-Company/armada/commit/357309087623dc9b8f814254400d70438379c54f))
* **clients:** preserve send identity across runtime wake ([#1584](https://github.com/The-Vibe-Company/armada/issues/1584)) ([a190bea](https://github.com/The-Vibe-Company/armada/commit/a190beac6fe8ac6308195affc1142856a50ba849))
* **cli:** flag host daemon version skew in doctor ([#1661](https://github.com/The-Vibe-Company/armada/issues/1661)) ([ae78dc4](https://github.com/The-Vibe-Company/armada/commit/ae78dc421a41ed803d028f9c7eed832bd1810672))
* **core:** distinguish Boat golden rebuild admission blockers ([#1696](https://github.com/The-Vibe-Company/armada/issues/1696)) ([3fa897f](https://github.com/The-Vibe-Company/armada/commit/3fa897fa7111a2a12c8737dd5b3b4cadaf392980))
* **dashboard:** clarify Models fallback states ([#1642](https://github.com/The-Vibe-Company/armada/issues/1642)) ([9f3a2f3](https://github.com/The-Vibe-Company/armada/commit/9f3a2f3f38bef78a65e4cdf46115ba45aac088da))
* **dashboard:** clarify provider choices and hide setup ghosts ([#1699](https://github.com/The-Vibe-Company/armada/issues/1699)) ([c3c0727](https://github.com/The-Vibe-Company/armada/commit/c3c0727f931b100310377bf73606de1953ea2c48))
* **dashboard:** clarify Skills setup and read recovery ([#1659](https://github.com/The-Vibe-Company/armada/issues/1659)) ([843c0b6](https://github.com/The-Vibe-Company/armada/commit/843c0b6a1554395e2bf38c51f3b21ffc4e689b3f))
* **dashboard:** clarify Templates fallback and recovery states ([#1680](https://github.com/The-Vibe-Company/armada/issues/1680)) ([32240d5](https://github.com/The-Vibe-Company/armada/commit/32240d5b1b4b2e28ca42566f2b8bbc1ea34974e0))
* **dashboard:** clarify Tools read and recovery states ([#1644](https://github.com/The-Vibe-Company/armada/issues/1644)) ([9257fa0](https://github.com/The-Vibe-Company/armada/commit/9257fa0db278688772e7cf0ef03d2e6d6417d829))
* **dashboard:** clarify Variables recovery and delivery limits ([#1649](https://github.com/The-Vibe-Company/armada/issues/1649)) ([dcb7993](https://github.com/The-Vibe-Company/armada/commit/dcb7993af6e302514076e3b1aa6d3aab441950ec))
* **dashboard:** explain sandbox pause and pinned account kind ([#1697](https://github.com/The-Vibe-Company/armada/issues/1697)) ([ab2b33a](https://github.com/The-Vibe-Company/armada/commit/ab2b33aff4c76dab89787c00d84505a8044e2230))
* **dashboard:** give opaque sandbox IDs readable list names ([#1636](https://github.com/The-Vibe-Company/armada/issues/1636)) ([33c58b5](https://github.com/The-Vibe-Company/armada/commit/33c58b50abaa13866adc560a101eb0270f318adb))
* **dashboard:** guide Routines recovery and template setup ([#1686](https://github.com/The-Vibe-Company/armada/issues/1686)) ([f3fa3fd](https://github.com/The-Vibe-Company/armada/commit/f3fa3fd16a7d122446273df361cb3bbf88d1699d))
* **dashboard:** name Docker hosts in the sandbox list ([#1631](https://github.com/The-Vibe-Company/armada/issues/1631)) ([6562212](https://github.com/The-Vibe-Company/armada/commit/6562212b4b0b65948588fb9d37516e3af9dc206a))
* **dashboard:** share the launch surface across providers ([#1641](https://github.com/The-Vibe-Company/armada/issues/1641)) ([fdf64ae](https://github.com/The-Vibe-Company/armada/commit/fdf64ae8b5ebfade4fcaab3dbaf81f5b103864b2))
* **dashboard:** shorten model-account provider selection ([#1624](https://github.com/The-Vibe-Company/armada/issues/1624)) ([ae95a77](https://github.com/The-Vibe-Company/armada/commit/ae95a7714ec6113a89a5f207199f99f6dba4aa5a))
* **dashboard:** show cloud accounts and machines together ([#1619](https://github.com/The-Vibe-Company/armada/issues/1619)) ([8421f7a](https://github.com/The-Vibe-Company/armada/commit/8421f7ab18ba9964df60629844977a3881ae204e))
* **deploy:** require Railway tokens and coalesce pending staging ([#1623](https://github.com/The-Vibe-Company/armada/issues/1623)) ([1184ddf](https://github.com/The-Vibe-Company/armada/commit/1184ddfd360aa7c7d99a8ab57294bd61608e8614))
* **devx:** wait for paused sandbox wake when sending ([#1666](https://github.com/The-Vibe-Company/armada/issues/1666)) ([0349455](https://github.com/The-Vibe-Company/armada/commit/034945520054418a8cb43c87cdcaa92981948e1b))
* **docker:** admit sends after accepted launch and prioritize stop ([#1668](https://github.com/The-Vibe-Company/armada/issues/1668)) ([27a315e](https://github.com/The-Vibe-Company/armada/commit/27a315e83908163b6260d991b4c8621a74496f81))
* **docker:** distinguish GitHub runtime delivery failures ([#1650](https://github.com/The-Vibe-Company/armada/issues/1650)) ([2ee2056](https://github.com/The-Vibe-Company/armada/commit/2ee20562d96c430ba2e493e243920c31e11a2461))
* **docker:** repair repository snapshot builds and report failures ([#1638](https://github.com/The-Vibe-Company/armada/issues/1638)) ([c6462cb](https://github.com/The-Vibe-Company/armada/commit/c6462cb56831fda3b500859bc678d70d9e0cdb98))
* **docker:** return accepted launches before repository preparation ([#1645](https://github.com/The-Vibe-Company/armada/issues/1645)) ([39e6925](https://github.com/The-Vibe-Company/armada/commit/39e6925bf34b65ff83206926694395fe9b55bd4f))
* **docker:** return launch conversations in queued send receipts ([#1690](https://github.com/The-Vibe-Company/armada/issues/1690)) ([a5da7b4](https://github.com/The-Vibe-Company/armada/commit/a5da7b4535a92ec1242f4e67d42aa1d9d2f1a9b5))
* **docker:** use a buildx-compatible snapshot secret source ([#1651](https://github.com/The-Vibe-Company/armada/issues/1651)) ([ff381ce](https://github.com/The-Vibe-Company/armada/commit/ff381cefee2dfddcd9d6534d19ccae7a75cff1ce))
* **docker:** use a GitHub-capable source deployment image ([#1657](https://github.com/The-Vibe-Company/armada/issues/1657)) ([2dd4f08](https://github.com/The-Vibe-Company/armada/commit/2dd4f0869335bf6522a88d184434588069f3a3d7))
* **docker:** use the owner default model account when omitted ([#1640](https://github.com/The-Vibe-Company/armada/issues/1640)) ([0c625ca](https://github.com/The-Vibe-Company/armada/commit/0c625ca5cda60fea48221233341d57b8bda5fff9))
* **opencode:** publish terminal answer snapshots and verify usage projection ([#1646](https://github.com/The-Vibe-Company/armada/issues/1646)) ([15afda9](https://github.com/The-Vibe-Company/armada/commit/15afda9029c204b72d6b33fa133c0a04d637a13d))
* **release:** check environment configuration before publication ([#1637](https://github.com/The-Vibe-Company/armada/issues/1637)) ([ab17966](https://github.com/The-Vibe-Company/armada/commit/ab17966168b86f98bee4b90ca746960c4d9c25a9))
* **smoke:** explain accounts matrix configuration failures ([#1678](https://github.com/The-Vibe-Company/armada/issues/1678)) ([edbb2d4](https://github.com/The-Vibe-Company/armada/commit/edbb2d4354b92abe154ac60aeca00b27f61af226))
* **smoke:** keep accounts without deployments in the matrix ([#1685](https://github.com/The-Vibe-Company/armada/issues/1685)) ([3a567e6](https://github.com/The-Vibe-Company/armada/commit/3a567e608ce4e38483a57e45b272453fe342ede1))
* **smoke:** measure turn polling and reconcile settled deletion ([#1611](https://github.com/The-Vibe-Company/armada/issues/1611)) ([0197015](https://github.com/The-Vibe-Company/armada/commit/01970155b8a270bfc323d2bb322b09c3cec8c68f))
* **smoke:** reconcile fenced scoped turns and pending cleanup ([#1648](https://github.com/The-Vibe-Company/armada/issues/1648)) ([fee1b4a](https://github.com/The-Vibe-Company/armada/commit/fee1b4a43e403e713d5f39d0532b77113172e2c9))
* **smoke:** report blocked Docker recall and usage probes ([#1689](https://github.com/The-Vibe-Company/armada/issues/1689)) ([5a5e6bf](https://github.com/The-Vibe-Company/armada/commit/5a5e6bf0991532712844e4fb2b829d2e57797a04))

## [2.29.0](https://github.com/The-Vibe-Company/armada/compare/v2.28.0...v2.29.0) (2026-11-13)


### Features

* **devx:** guide first launches and streamline contributor checks ([#1587](https://github.com/The-Vibe-Company/armada/issues/1587)) ([89ee61f](https://github.com/The-Vibe-Company/armada/commit/89ee61ff8cd0f82e64e133812a4f0504702ae7ce))
* **docker:** checkpoint idle workers and wake on send ([#1576](https://github.com/The-Vibe-Company/armada/issues/1576)) ([b9cd97c](https://github.com/The-Vibe-Company/armada/commit/b9cd97c72b3c385d9581e5a84798f625cf34f944))
* **docker:** launch only the release-pinned Armada environment ([#1536](https://github.com/The-Vibe-Company/armada/issues/1536)) ([e528e7f](https://github.com/The-Vibe-Company/armada/commit/e528e7f8728b4cdad3ece55075219d465b365bdb))
* **docker:** launch repository workspaces and authorized host snapshots ([#1497](https://github.com/The-Vibe-Company/armada/issues/1497)) ([41f1d33](https://github.com/The-Vibe-Company/armada/commit/41f1d33204795909b3f9fe1d02b28aa1d9963283))
* **docker:** offer snapshot rebuilds on newer Armada versions ([#1574](https://github.com/The-Vibe-Company/armada/issues/1574)) ([728daa5](https://github.com/The-Vibe-Company/armada/commit/728daa5ffb662b3c72fcd17d8ef4e78d04fe8508))
* **runtime:** checkpoint and pause idle sandboxes ([#1563](https://github.com/The-Vibe-Company/armada/issues/1563)) ([1deada5](https://github.com/The-Vibe-Company/armada/commit/1deada5e873ed8f9dd89ae3fac5f9dcf58d949be))
* **runtime:** wake checkpointed sandboxes on send ([#1564](https://github.com/The-Vibe-Company/armada/issues/1564)) ([dd9d9d8](https://github.com/The-Vibe-Company/armada/commit/dd9d9d87d739535890fb4cf6fde39fdc592a95d7))
* **sandboxes:** show checkpointed idle stops as paused ([#1565](https://github.com/The-Vibe-Company/armada/issues/1565)) ([3909f4c](https://github.com/The-Vibe-Company/armada/commit/3909f4ce4caccd7dee9ea941114619550d5ffa1a))
* **smoke:** add account matrix observations to provider parity ([#1583](https://github.com/The-Vibe-Company/armada/issues/1583)) ([4aad551](https://github.com/The-Vibe-Company/armada/commit/4aad55124af6ef42443de052c6e61cbcf9d1b24d))
* **smoke:** verify usage and exact cost across resume ([#1545](https://github.com/The-Vibe-Company/armada/issues/1545)) ([cda97e0](https://github.com/The-Vibe-Company/armada/commit/cda97e0d3bec4d6432daa49ba8e6ff3fbf1f3d5f))


### Bug Fixes

* **dashboard:** guide model checks with named sandbox choices ([#1602](https://github.com/The-Vibe-Company/armada/issues/1602)) ([3a22273](https://github.com/The-Vibe-Company/armada/commit/3a222730b9c66a0093784bb62658c6afb890844f))
* **dashboard:** put sandbox conversations before machine details ([#1586](https://github.com/The-Vibe-Company/armada/issues/1586)) ([ccf0c6e](https://github.com/The-Vibe-Company/armada/commit/ccf0c6e93485a05d2cf8b01a2b35abb72e0146be))
* **dashboard:** read a Docker sandbox page in plain names ([#1540](https://github.com/The-Vibe-Company/armada/issues/1540)) ([ccf0c21](https://github.com/The-Vibe-Company/armada/commit/ccf0c21b458bce710abde96e16a248587f9a20bc))
* **dashboard:** separate unfinished host setup from machines ([#1589](https://github.com/The-Vibe-Company/armada/issues/1589)) ([8104a56](https://github.com/The-Vibe-Company/armada/commit/8104a566f06824e00b6c2ab8999e1bdac9db316c))
* **dashboard:** show safe readable composer failures ([#1598](https://github.com/The-Vibe-Company/armada/issues/1598)) ([6e83c22](https://github.com/The-Vibe-Company/armada/commit/6e83c225be30036fe743ce1a30965fa3efaf3d60))
* **dashboard:** surface model choices in the launch form ([#1595](https://github.com/The-Vibe-Company/armada/issues/1595)) ([d459af1](https://github.com/The-Vibe-Company/armada/commit/d459af1c2a68668573d3039098723229076b6b16))
* **deploy:** restore staging dashboard without Railway token ([#1567](https://github.com/The-Vibe-Company/armada/issues/1567)) ([0dba08f](https://github.com/The-Vibe-Company/armada/commit/0dba08f3d87116bf709a6843db142afcf53b4632))
* **deploy:** retain previous deployment during promotion overlap ([#1572](https://github.com/The-Vibe-Company/armada/issues/1572)) ([fb74081](https://github.com/The-Vibe-Company/armada/commit/fb74081af820ca11912c688dd2ca1ecb19058f5c))
* **docker:** preserve source-deploy launch and host compatibility ([#1566](https://github.com/The-Vibe-Company/armada/issues/1566)) ([4f62bf7](https://github.com/The-Vibe-Company/armada/commit/4f62bf7a97df4dd72502da51b164e2a68f728559))
* **host:** reconcile reused registrations and upgrade safely ([#1543](https://github.com/The-Vibe-Company/armada/issues/1543)) ([06ee2e3](https://github.com/The-Vibe-Company/armada/commit/06ee2e3ede67ed6663b830e75a07a6f89b3fbdd5))
* **runtime:** prepare Boat GitHub access before resumed inference ([#1590](https://github.com/The-Vibe-Company/armada/issues/1590)) ([1f8b4f8](https://github.com/The-Vibe-Company/armada/commit/1f8b4f8a227b948eb039d03f2fc978f0a9519efd))
* **smoke:** exclude Boat from staging acceptance ([#1601](https://github.com/The-Vibe-Company/armada/issues/1601)) ([571a003](https://github.com/The-Vibe-Company/armada/commit/571a003da868ad46adee79f8b28c992f40b48b19))

## [2.28.0](https://github.com/The-Vibe-Company/armada/compare/v2.27.0...v2.28.0) (2026-11-13)


### Features

* **cli:** complete email login through a bound browser link ([#1514](https://github.com/The-Vibe-Company/armada/issues/1514)) ([0df979d](https://github.com/The-Vibe-Company/armada/commit/0df979d20922271034c3fd7082e662570df0ce9d))
* **cli:** install the local Docker host through Armada ([#1534](https://github.com/The-Vibe-Company/armada/issues/1534)) ([4b93ff1](https://github.com/The-Vibe-Company/armada/commit/4b93ff15eb4bdea74b72d0fcfdc9ab0c94206c51))
* **dashboard:** add a Docker host with one copyable command ([#1481](https://github.com/The-Vibe-Company/armada/issues/1481)) ([6cb556d](https://github.com/The-Vibe-Company/armada/commit/6cb556de772bcf2927472d0381c32b9e5b044557))
* **dashboard:** add a model connection by choosing a provider ([#1493](https://github.com/The-Vibe-Company/armada/issues/1493)) ([ceaa5dd](https://github.com/The-Vibe-Company/armada/commit/ceaa5dd286f35f5167ef47d9e40b369eb9c73ed6))
* **dashboard:** add a Providers section with a Cloud page ([#1484](https://github.com/The-Vibe-Company/armada/issues/1484)) ([c149883](https://github.com/The-Vibe-Company/armada/commit/c1498831fa4f22f5bc451c59d8b700c3516334b2))
* **dashboard:** launch on a Docker host with any agent and no image to choose ([#1520](https://github.com/The-Vibe-Company/armada/issues/1520)) ([8e67f8e](https://github.com/The-Vibe-Company/armada/commit/8e67f8eeaa590a025d9ed80def93141f35b23880))
* **dashboard:** one clear step to paste a subscription ([#1510](https://github.com/The-Vibe-Company/armada/issues/1510)) ([c8348f8](https://github.com/The-Vibe-Company/armada/commit/c8348f8f7682296f19065bf5fcc182cd35002fe6))
* **dashboard:** open a Docker sandbox like any other ([#1431](https://github.com/The-Vibe-Company/armada/issues/1431)) ([a786bec](https://github.com/The-Vibe-Company/armada/commit/a786becaefb01cefe4439dfb821deefc5183ec95))
* **dashboard:** pick a connection's models at launch ([#1499](https://github.com/The-Vibe-Company/armada/issues/1499)) ([a31e028](https://github.com/The-Vibe-Company/armada/commit/a31e0286c446a4175ec1787cb18ce4f252d3c6df))
* **dashboard:** rename Environments to Snapshots and explain the Skills page ([#1488](https://github.com/The-Vibe-Company/armada/issues/1488)) ([e57effc](https://github.com/The-Vibe-Company/armada/commit/e57effc88b547877ea47e1991d970df7fa7ac7c9))
* **dashboard:** reorder the sidebar and drop search and organizations ([#1478](https://github.com/The-Vibe-Company/armada/issues/1478)) ([5da6c89](https://github.com/The-Vibe-Company/armada/commit/5da6c8900c81e4504f96b8c57e7e186545ee00b5))
* **dashboard:** show a connection's models and prefill its check ([#1506](https://github.com/The-Vibe-Company/armada/issues/1506)) ([f446883](https://github.com/The-Vibe-Company/armada/commit/f446883b24331ff41522adc17f309b2c93550eb5))
* **docker-host:** add one-click install contract and host CLI controls ([#1475](https://github.com/The-Vibe-Company/armada/issues/1475)) ([d8c807a](https://github.com/The-Vibe-Company/armada/commit/d8c807a6e738dca3b6199991521cf7e6fc6bf353))
* **docker-host:** add verified user-service install, status and uninstall ([#1461](https://github.com/The-Vibe-Company/armada/issues/1461)) ([32c4b23](https://github.com/The-Vibe-Company/armada/commit/32c4b237532acd4d926461a5f22483b908348a24))
* **docker:** clone authorized repositories before the first prompt ([#1494](https://github.com/The-Vibe-Company/armada/issues/1494)) ([9a88800](https://github.com/The-Vibe-Company/armada/commit/9a888009752d6047abe27453dd0d0edf0b83b024))
* **docker:** deliver MCP connections and verified skills ([#1491](https://github.com/The-Vibe-Company/armada/issues/1491)) ([9040f24](https://github.com/The-Vibe-Company/armada/commit/9040f248a5feb576f5346c53c6da797444e12937))
* **docker:** enable normal plain-image sandbox launch ([#1429](https://github.com/The-Vibe-Company/armada/issues/1429)) ([ec1f36b](https://github.com/The-Vibe-Company/armada/commit/ec1f36b6950c8ebf79f71f561f7b5b8f574b7705))
* **docker:** enable runtime steer interrupt and exec ([#1480](https://github.com/The-Vibe-Company/armada/issues/1480)) ([ba8ab40](https://github.com/The-Vibe-Company/armada/commit/ba8ab409872349b558c2243061156ef8dd57b711))
* **docker:** fetch a missing image on the host and explain a failed fetch ([#1525](https://github.com/The-Vibe-Company/armada/issues/1525)) ([c148e4e](https://github.com/The-Vibe-Company/armada/commit/c148e4e6d1d650e33646032216f05a8705dd087e))
* **docker:** launch host-approved immutable local image IDs ([#1523](https://github.com/The-Vibe-Company/armada/issues/1523)) ([1f0ffe0](https://github.com/The-Vibe-Company/armada/commit/1f0ffe0beec99786a2597bf59a9c08d82135de93))
* **docker:** launch on a host with Armada's default image ([#1511](https://github.com/The-Vibe-Company/armada/issues/1511)) ([482ae3e](https://github.com/The-Vibe-Company/armada/commit/482ae3e36ee08bc56e3f5dc2585536c21b31aa91))
* **docker:** launch templates and routines on owned hosts ([#1509](https://github.com/The-Vibe-Company/armada/issues/1509)) ([e285146](https://github.com/The-Vibe-Company/armada/commit/e285146877e9cb693318a5a76f7423a50f103d4c))
* **docker:** publish the official sandbox image with releases ([#1531](https://github.com/The-Vibe-Company/armada/issues/1531)) ([178685a](https://github.com/The-Vibe-Company/armada/commit/178685a56e66be75576e9a292799925367be08bd))
* **docker:** support harnesses and retained session costs ([#1456](https://github.com/The-Vibe-Company/armada/issues/1456)) ([e12d346](https://github.com/The-Vibe-Company/armada/commit/e12d3466fc21fc637ebadb3e185c688a86c0d80e))
* **docker:** support normal follow-up and same-host resume ([#1442](https://github.com/The-Vibe-Company/armada/issues/1442)) ([4a9d5c7](https://github.com/The-Vibe-Company/armada/commit/4a9d5c7a8fa3eae13394c624b988cd085f99782e))
* **host:** bootstrap the pinned CLI with a standalone fallback ([#1538](https://github.com/The-Vibe-Company/armada/issues/1538)) ([c4f5bee](https://github.com/The-Vibe-Company/armada/commit/c4f5beeed3786a28b5cc22c0f008968ee7ca3fab))
* **hosts:** expose normal Docker sandbox controls ([#1416](https://github.com/The-Vibe-Company/armada/issues/1416)) ([72f2459](https://github.com/The-Vibe-Company/armada/commit/72f2459daac7ee16fed71dda983ef7c52a28f3a4))
* **modal:** continue active Codex runtime conversations ([#1448](https://github.com/The-Vibe-Company/armada/issues/1448)) ([d5091a9](https://github.com/The-Vibe-Company/armada/commit/d5091a9a7ea67d9d54a21e4dd5bf1413b59351b5))
* **modal:** deliver frozen readable variables through enrolment ([#1512](https://github.com/The-Vibe-Company/armada/issues/1512)) ([05f4eee](https://github.com/The-Vibe-Company/armada/commit/05f4eee8ef4645237d8daaf59bdff45709be4906))
* **modal:** deliver GitHub through the shared runtime broker ([#1462](https://github.com/The-Vibe-Company/armada/issues/1462)) ([32c6e46](https://github.com/The-Vibe-Company/armada/commit/32c6e461d6a8c090e48c353c8eb47e79a3614f77))
* **modal:** deliver remote MCP through common runtime epochs ([#1486](https://github.com/The-Vibe-Company/armada/issues/1486)) ([d0d1684](https://github.com/The-Vibe-Company/armada/commit/d0d1684b20752cb197ed2338d1318855521bb52b))
* **modal:** install skill defaults through the shared runtime ([#1490](https://github.com/The-Vibe-Company/armada/issues/1490)) ([9ff76ec](https://github.com/The-Vibe-Company/armada/commit/9ff76ec8887579e166d954aca1c98febeba9408c))
* **modal:** launch Codex through common dial-out transport ([#1438](https://github.com/The-Vibe-Company/armada/issues/1438)) ([3716a59](https://github.com/The-Vibe-Company/armada/commit/3716a59ce7544b3e8472cdc8237da3ef05a2d589))
* **modal:** preserve runtime disk and session across resume ([#1455](https://github.com/The-Vibe-Company/armada/issues/1455)) ([884ad48](https://github.com/The-Vibe-Company/armada/commit/884ad485d25ff354a599635953c4c2633d9fdca9))
* **runtime:** enable Boat interrupt, steer and exec ([#1472](https://github.com/The-Vibe-Company/armada/issues/1472)) ([cb440f8](https://github.com/The-Vibe-Company/armada/commit/cb440f8881f3424eac7658b144bbf795da9c3445))
* **runtime:** install default skills before Boat inference ([#1417](https://github.com/The-Vibe-Company/armada/issues/1417)) ([e283797](https://github.com/The-Vibe-Company/armada/commit/e2837974caf3d3af1b95a042f32efe132876030e))
* **runtime:** prepare MCP through standard launch and turn flows ([#1407](https://github.com/The-Vibe-Company/armada/issues/1407)) ([25ec4d8](https://github.com/The-Vibe-Company/armada/commit/25ec4d8e671035f80566aa18804dc8b801409d2e))
* **runtime:** refresh repositories and run launch init privately ([#1502](https://github.com/The-Vibe-Company/armada/issues/1502)) ([d2e98f6](https://github.com/The-Vibe-Company/armada/commit/d2e98f67e597e950c44232caa011930dcbb6823f))
* **runtime:** run Claude through the Boat runtime lifecycle ([#1428](https://github.com/The-Vibe-Company/armada/issues/1428)) ([8dce072](https://github.com/The-Vibe-Company/armada/commit/8dce07279dfe9898353ec096cf752a72fa695555))
* **smoke:** report lifecycle parity across three providers ([#1476](https://github.com/The-Vibe-Company/armada/issues/1476)) ([d543308](https://github.com/The-Vibe-Company/armada/commit/d543308c5e2c278d9c970b2cb60c16facb299b7e))


### Bug Fixes

* **cli:** guide sign-in and retry unauthenticated commands ([#1505](https://github.com/The-Vibe-Company/armada/issues/1505)) ([fb2fc62](https://github.com/The-Vibe-Company/armada/commit/fb2fc6249303bc30045f4865244988e3cee36f82))
* **cli:** serialize rotating session refresh across processes ([#1516](https://github.com/The-Vibe-Company/armada/issues/1516)) ([f88b6aa](https://github.com/The-Vibe-Company/armada/commit/f88b6aafe669e24183ad79211f9cdb6ced28b1ad))
* **dashboard:** send follow-up messages to a Docker sandbox ([#1529](https://github.com/The-Vibe-Company/armada/issues/1529)) ([a2542ad](https://github.com/The-Vibe-Company/armada/commit/a2542adb17799be195e62dc6738719a67bd89e3b))
* **host:** recover installer reruns and explain connection waiting ([#1521](https://github.com/The-Vibe-Company/armada/issues/1521)) ([b1f9a56](https://github.com/The-Vibe-Company/armada/commit/b1f9a56121c36c6fcace26f9ea95779dd78a390e))
* **runtime:** keep subscription migration out of enrolled Boat guests ([#1426](https://github.com/The-Vibe-Company/armada/issues/1426)) ([91f43f8](https://github.com/The-Vibe-Company/armada/commit/91f43f8b43c4bd6f29e3e9c8056ea3d675f20585))
* **runtime:** keep the native SSH GitHub broker within its bundle budget ([#1412](https://github.com/The-Vibe-Company/armada/issues/1412)) ([e7356c0](https://github.com/The-Vibe-Company/armada/commit/e7356c000f024407d0623896e6a0e63216cae36f))
* **runtime:** preserve admitted costs in usage uploads ([#1418](https://github.com/The-Vibe-Company/armada/issues/1418)) ([254bd61](https://github.com/The-Vibe-Company/armada/commit/254bd611ee5b6abc0ebfca555bf22c5d4250c806))
* **runtime:** publish only requestable server image artifacts ([#1469](https://github.com/The-Vibe-Company/armada/issues/1469)) ([167e1b7](https://github.com/The-Vibe-Company/armada/commit/167e1b751782911a002d8cf746118491b2bcc2fe))
* **server:** fence steer admission against background observations ([#1451](https://github.com/The-Vibe-Company/armada/issues/1451)) ([197a758](https://github.com/The-Vibe-Company/armada/commit/197a758d628a89a3e3d94e167787cc1403421c51))
* **smoke:** batch runtime MCP and skills in three prompts ([#1433](https://github.com/The-Vibe-Company/armada/issues/1433)) ([1709cb1](https://github.com/The-Vibe-Company/armada/commit/1709cb1771ab67e6ceab6408ca87eaf97229d0b6))
* **smoke:** expose parity failures and reconcile provider lifecycle ([#1535](https://github.com/The-Vibe-Company/armada/issues/1535)) ([ab6583a](https://github.com/The-Vibe-Company/armada/commit/ab6583a411ff77ce5e457bc4d4fe8b42ba74592e))
* **smoke:** read dashboard data without a password account ([#1468](https://github.com/The-Vibe-Company/armada/issues/1468)) ([e6c4e41](https://github.com/The-Vibe-Company/armada/commit/e6c4e41733c2227ea658904f4efd2eb6362294fb))
* **smoke:** reconcile asynchronous deletes and report safe failures ([#1413](https://github.com/The-Vibe-Company/armada/issues/1413)) ([0ac1373](https://github.com/The-Vibe-Company/armada/commit/0ac1373780e7f2767234012a46d19c723954d0c7))
* **smoke:** reconcile parity cleanup after failed probes ([#1542](https://github.com/The-Vibe-Company/armada/issues/1542)) ([1f36788](https://github.com/The-Vibe-Company/armada/commit/1f36788492d67c3a57565038d5115689a41fcf97))
* **smoke:** settle parent cleanup before delegated child deletion ([#1415](https://github.com/The-Vibe-Company/armada/issues/1415)) ([044e857](https://github.com/The-Vibe-Company/armada/commit/044e857d29664f101506b7471c29656dcd0adad8))


### Performance Improvements

* **ci:** consolidate PostgreSQL setup outside unit shards ([#1427](https://github.com/The-Vibe-Company/armada/issues/1427)) ([9e32896](https://github.com/The-Vibe-Company/armada/commit/9e32896b89cf589ab4b089457307c6ea458c9d14))
* **ci:** rebalance unit shards from measured file wall times ([#1434](https://github.com/The-Vibe-Company/armada/issues/1434)) ([5b271b6](https://github.com/The-Vibe-Company/armada/commit/5b271b673aaa5f8712a992dc42d29cb1c47a7ddb))
* **ci:** run native contracts alongside typechecking ([#1432](https://github.com/The-Vibe-Company/armada/issues/1432)) ([31af1bb](https://github.com/The-Vibe-Company/armada/commit/31af1bb8b5bee8b0581006ad78ebf6ab94e84528))
* **test:** delete duplicate MCP fixture isolation assertions ([#1435](https://github.com/The-Vibe-Company/armada/issues/1435)) ([a515d51](https://github.com/The-Vibe-Company/armada/commit/a515d51945e223b7848163d25e0fc9039617477a))
* **test:** delete duplicate migration history replay ([#1437](https://github.com/The-Vibe-Company/armada/issues/1437)) ([c2071d7](https://github.com/The-Vibe-Company/armada/commit/c2071d729244409e0aeec76eb0b4f7500eebac0d))
* **test:** prune repeated native credential consumers ([#1447](https://github.com/The-Vibe-Company/armada/issues/1447)) ([b5c4914](https://github.com/The-Vibe-Company/armada/commit/b5c4914292c696db0ee816713016af9513511a11))
* **test:** remove disk syncs from epoch admission coverage ([#1444](https://github.com/The-Vibe-Company/armada/issues/1444)) ([f652da7](https://github.com/The-Vibe-Company/armada/commit/f652da742452e2c3fcb7f0ad486a666ba03a0d13))
* **test:** remove disk syncs from GitHub control coverage ([#1445](https://github.com/The-Vibe-Company/armada/issues/1445)) ([b85c9b6](https://github.com/The-Vibe-Company/armada/commit/b85c9b6a1c614c47cc6ff0dbd7253594d445bddd))
* **test:** replace database schema fixture with cheaper guard proof ([#1439](https://github.com/The-Vibe-Company/armada/issues/1439)) ([e1628c0](https://github.com/The-Vibe-Company/armada/commit/e1628c0e10ff171bfdd8d7fb1bb86e78710ba4ed))

## [2.27.0](https://github.com/The-Vibe-Company/armada/compare/v2.26.0...v2.27.0) (2026-11-13)


### Features

* **dashboard:** Docker hosts page with add and revoke ([#1384](https://github.com/The-Vibe-Company/armada/issues/1384)) ([b6d8839](https://github.com/The-Vibe-Company/armada/commit/b6d88397e2e30bae9ba5d9db2ed2af5e18b0ce78))
* **dashboard:** launch Codex on a Docker host ([#1392](https://github.com/The-Vibe-Company/armada/issues/1392)) ([b3cd2e3](https://github.com/The-Vibe-Company/armada/commit/b3cd2e35b4435ecb7cf08ca4d027a858aef4091a))
* **dashboard:** sort sandboxes newest first by default ([#1375](https://github.com/The-Vibe-Company/armada/issues/1375)) ([c528a47](https://github.com/The-Vibe-Company/armada/commit/c528a474bd08cf106f5f7d034782ad1bf871d0ad))
* **hosts:** continue Docker Codex conversations ([#1386](https://github.com/The-Vibe-Company/armada/issues/1386)) ([9d23df8](https://github.com/The-Vibe-Company/armada/commit/9d23df8b96a4c65f74ae9b8a195b224bbcb0a48f))
* **hosts:** expose opt-in Docker one-prompt lifecycle ([#1376](https://github.com/The-Vibe-Company/armada/issues/1376)) ([70a3ccd](https://github.com/The-Vibe-Company/armada/commit/70a3ccdb1089fb6b140c2cdc95fa9c9b971c87cb))
* **runtime:** configure remote MCP through enrolled Boat runtimes ([#1377](https://github.com/The-Vibe-Company/armada/issues/1377)) ([33a0e22](https://github.com/The-Vibe-Company/armada/commit/33a0e22e36e698272a672e3a9838f6c9e2e45b20))


### Bug Fixes

* **dashboard:** leave out a sandbox list row that does not match its contract ([#1401](https://github.com/The-Vibe-Company/armada/issues/1401)) ([8bfba25](https://github.com/The-Vibe-Company/armada/commit/8bfba2522f9580883b2f6f797615155f1d668c4e))
* **dashboard:** list sandboxes on Docker hosts ([#1397](https://github.com/The-Vibe-Company/armada/issues/1397)) ([f4aeb22](https://github.com/The-Vibe-Company/armada/commit/f4aeb22553793da96695b4ff887ec7cf896e6acf))
* **dashboard:** wait for a launch and follow an unanswered one ([#1370](https://github.com/The-Vibe-Company/armada/issues/1370)) ([6a8801d](https://github.com/The-Vibe-Company/armada/commit/6a8801dd088afb7630962cc6ea6be092f59eadd7))
* **otto:** bound snapshots to the live fleet ([#1373](https://github.com/The-Vibe-Company/armada/issues/1373)) ([2165789](https://github.com/The-Vibe-Company/armada/commit/216578955a009a0674f986ba348ea0538f8e5fb1))
* **otto:** prevent read views from hanging on projection writes ([#1368](https://github.com/The-Vibe-Company/armada/issues/1368)) ([4b678de](https://github.com/The-Vibe-Company/armada/commit/4b678de81335282d9f5ef05c15e704c762fa917a))
* **pricing:** admit custom connection model prices ([#1395](https://github.com/The-Vibe-Company/armada/issues/1395)) ([17efd40](https://github.com/The-Vibe-Company/armada/commit/17efd40d9b761c8f40d892e01a6876afe244518a))
* **smoke:** delete receipted sandboxes and sweep known leftovers ([#1403](https://github.com/The-Vibe-Company/armada/issues/1403)) ([941c98b](https://github.com/The-Vibe-Company/armada/commit/941c98bede6ed7c269569cd61bfcc6f53eaeeac2))


### Performance Improvements

* **test:** reuse connection pricing and model state fixtures ([#1389](https://github.com/The-Vibe-Company/armada/issues/1389)) ([8597b46](https://github.com/The-Vibe-Company/armada/commit/8597b46c1948683ec91238c8a6e303678ea7ac1b))
* **test:** reuse Modal and golden restore SQL fixtures ([#1379](https://github.com/The-Vibe-Company/armada/issues/1379)) ([f0b15c8](https://github.com/The-Vibe-Company/armada/commit/f0b15c84614a54efbf84c919e0950c13bdc8021e))
* **test:** reuse retained runtime and preservation fixtures ([#1399](https://github.com/The-Vibe-Company/armada/issues/1399)) ([53ba87d](https://github.com/The-Vibe-Company/armada/commit/53ba87d7fbd53c7224c674632d1de3a23ad54ea7))
* **test:** reuse row-only application vault fixtures ([#1371](https://github.com/The-Vibe-Company/armada/issues/1371)) ([bb53067](https://github.com/The-Vibe-Company/armada/commit/bb53067a74c95a0ea307d489d758d13ba52801d5))
* **test:** reuse scheduler and runtime event fixtures ([#1378](https://github.com/The-Vibe-Company/armada/issues/1378)) ([24666ed](https://github.com/The-Vibe-Company/armada/commit/24666ed8d0363ee5e819af2567754a4d286428c8))

## [2.26.0](https://github.com/The-Vibe-Company/armada/compare/v2.25.0...v2.26.0) (2026-11-13)


### Features

* **boat:** bootstrap verified enrolled runtime executable ([#1292](https://github.com/The-Vibe-Company/armada/issues/1292)) ([eb3e1ae](https://github.com/The-Vibe-Company/armada/commit/eb3e1ae6a84d11e8cebd70181ec6c3321668c43d))
* **cli:** set prices on custom model connections ([#1281](https://github.com/The-Vibe-Company/armada/issues/1281)) ([5fd686b](https://github.com/The-Vibe-Company/armada/commit/5fd686bd6a046762217ed80bd852fcefbbc835d9))
* **dashboard:** add runtime-backed connection checks ([#1244](https://github.com/The-Vibe-Company/armada/issues/1244)) ([3808da8](https://github.com/The-Vibe-Company/armada/commit/3808da8aff4eeb9b95ea21b6d6843caa008404fa))
* **dashboard:** pick model connections in templates ([#1276](https://github.com/The-Vibe-Company/armada/issues/1276)) ([f0e3065](https://github.com/The-Vibe-Company/armada/commit/f0e3065f141d902f72163b78055b110b592d05c0))
* **dashboard:** set prices on custom model connections ([#1285](https://github.com/The-Vibe-Company/armada/issues/1285)) ([cdf6915](https://github.com/The-Vibe-Company/armada/commit/cdf6915a3cb7b80c9d8d538991e44a4e9e50f4cf))
* **dashboard:** the read-only Otto page (tasks, who owns what, orphans of the day) ([#1306](https://github.com/The-Vibe-Company/armada/issues/1306)) ([32f90fc](https://github.com/The-Vibe-Company/armada/commit/32f90fc619577b7f3b3775941033aad31dd4994e))
* **db:** bind plain-image Docker sandboxes to registered hosts ([#1345](https://github.com/The-Vibe-Company/armada/issues/1345)) ([5840a3c](https://github.com/The-Vibe-Company/armada/commit/5840a3ca9f50786e8451bf0a7f756451226caf15))
* **harness:** launch OpenCode on Modal through ACP v1 ([#1311](https://github.com/The-Vibe-Company/armada/issues/1311)) ([a73b192](https://github.com/The-Vibe-Company/armada/commit/a73b192023e213f03f197331c9ad3c674babc1d5))
* **hosts:** add opt-in Docker host registration daemon ([#1335](https://github.com/The-Vibe-Company/armada/issues/1335)) ([ad77191](https://github.com/The-Vibe-Company/armada/commit/ad77191876a549af3049faac843a76ac17eb8ce5))
* **hosts:** add owned Docker machine executor ([#1332](https://github.com/The-Vibe-Company/armada/issues/1332)) ([ab3a2a7](https://github.com/The-Vibe-Company/armada/commit/ab3a2a7a0dce0b10df7638aad70a44e15b972b82))
* **hosts:** bind machine jobs to persisted Docker sandboxes ([#1357](https://github.com/The-Vibe-Company/armada/issues/1357)) ([bf128b2](https://github.com/The-Vibe-Company/armada/commit/bf128b274b6d59e81c0a4bc4215b14673d274782))
* **hosts:** bootstrap Docker runtimes through bound enrolment ([#1363](https://github.com/The-Vibe-Company/armada/issues/1363)) ([00d469b](https://github.com/The-Vibe-Company/armada/commit/00d469be7ef69a8e4527aa11f126c8e7165c03e9))
* **hosts:** fence single-use runtime bootstrap delivery ([#1341](https://github.com/The-Vibe-Company/armada/issues/1341)) ([3dabf35](https://github.com/The-Vibe-Company/armada/commit/3dabf3591bc706d6f104ed379e70fedd9d12d3fa))
* **hosts:** install verified runtime into owned Docker workspace ([#1338](https://github.com/The-Vibe-Company/armada/issues/1338)) ([dad9291](https://github.com/The-Vibe-Company/armada/commit/dad9291a39dc0c87515511d4487e9aa6fb9610cc))
* **hosts:** persist scoped Docker registration and machine jobs ([#1333](https://github.com/The-Vibe-Company/armada/issues/1333)) ([7324269](https://github.com/The-Vibe-Company/armada/commit/7324269b1e1c44683b085144549ca3789a005f54))
* **hosts:** reserve Docker sandbox and create job atomically ([#1359](https://github.com/The-Vibe-Company/armada/issues/1359)) ([a1a485c](https://github.com/The-Vibe-Company/armada/commit/a1a485ca3d3c06161384eb5d6c474e12f1c99f19))
* **otto:** derive owners and retain daily orphan detections ([#1313](https://github.com/The-Vibe-Company/armada/issues/1313)) ([bff7259](https://github.com/The-Vibe-Company/armada/commit/bff7259b39a7fe3e5ac82a129d7cd146a977231f))
* **otto:** expose conservative read models with explicit ownership gaps ([#1283](https://github.com/The-Vibe-Company/armada/issues/1283)) ([48afd29](https://github.com/The-Vibe-Company/armada/commit/48afd2987f62dc8b22e0e2fb3f9827029f4a8eb5))
* **otto:** journal GitHub observations without controlling workers ([#1280](https://github.com/The-Vibe-Company/armada/issues/1280)) ([10b7c92](https://github.com/The-Vibe-Company/armada/commit/10b7c92aba1c54c2b06506ceae0d247e2968b862))
* **otto:** observe exact-head GitHub work evidence ([#1315](https://github.com/The-Vibe-Company/armada/issues/1315)) ([dbc94d9](https://github.com/The-Vibe-Company/armada/commit/dbc94d98fdc9343e9d0e98984f773413cb1fc8c5))
* **otto:** read required checks from active branch rules ([#1320](https://github.com/The-Vibe-Company/armada/issues/1320)) ([0aaa7a7](https://github.com/The-Vibe-Company/armada/commit/0aaa7a78a420f304324b52b8f8b95de6f2e651cb))
* **otto:** recognize existing worker ownership reports ([#1317](https://github.com/The-Vibe-Company/armada/issues/1317)) ([c8659f4](https://github.com/The-Vibe-Company/armada/commit/c8659f4b8e39953b203f9b416576f8d076b4e157))
* **runtime:** add ACP v1 driver and pinned OpenCode artifact ([#1297](https://github.com/The-Vibe-Company/armada/issues/1297)) ([f9a51a2](https://github.com/The-Vibe-Company/armada/commit/f9a51a20315a82f6065c8444eb689eaa571096c8))
* **runtime:** add epoch-fenced GitHub access on Boat ([#1360](https://github.com/The-Vibe-Company/armada/issues/1360)) ([15f81db](https://github.com/The-Vibe-Company/armada/commit/15f81dbaecd5da5a391d4c498b342845b6a299ae))
* **runtime:** admit explicitly opted-in Docker runtime grants ([#1351](https://github.com/The-Vibe-Company/armada/issues/1351)) ([a9e6e0e](https://github.com/The-Vibe-Company/armada/commit/a9e6e0e8727b6147faf43ab877c540c8d959e5a1))
* **runtime:** await epoch-pinned durable command replies ([#1294](https://github.com/The-Vibe-Company/armada/issues/1294)) ([255f22f](https://github.com/The-Vibe-Company/armada/commit/255f22fba57b75731c24ff32490d7b91278aa9b7))
* **runtime:** bootstrap enrolled Codex from pinned artifacts ([#1287](https://github.com/The-Vibe-Company/armada/issues/1287)) ([9a2fdf5](https://github.com/The-Vibe-Company/armada/commit/9a2fdf56cf02f116efd648dc918768c498145617))
* **runtime:** bridge Codex agent operations over dial-out ([#1300](https://github.com/The-Vibe-Company/armada/issues/1300)) ([ffb02e8](https://github.com/The-Vibe-Company/armada/commit/ffb02e8557d1dd9c7a53cdb5e3de115f9a812683))
* **runtime:** checkpoint Boat state before compute stop ([#1348](https://github.com/The-Vibe-Company/armada/issues/1348)) ([a4c5373](https://github.com/The-Vibe-Company/armada/commit/a4c53736099065436922e2e83a8570ba48ba4945))
* **runtime:** continue live Boat Codex conversations ([#1343](https://github.com/The-Vibe-Company/armada/issues/1343)) ([2823282](https://github.com/The-Vibe-Company/armada/commit/2823282d266ba05febaf10ad9b64eb89d24f6e12))
* **runtime:** coordinate enrolled Codex startup readiness ([#1302](https://github.com/The-Vibe-Company/armada/issues/1302)) ([91b9acd](https://github.com/The-Vibe-Company/armada/commit/91b9acd653937ac05220161731e1086017743d0d))
* **runtime:** expose fenced Boat bootstrap diagnostics ([#1337](https://github.com/The-Vibe-Company/armada/issues/1337)) ([553bca1](https://github.com/The-Vibe-Company/armada/commit/553bca131d8a10cae7e4d7377a6c666396f26a57))
* **runtime:** fence subscription access by the current epoch ([#1310](https://github.com/The-Vibe-Company/armada/issues/1310)) ([fc64629](https://github.com/The-Vibe-Company/armada/commit/fc6462914f781e271fe6f45eee74d8a230527966))
* **runtime:** hand Boat launches to the enrolled Codex runtime ([#1318](https://github.com/The-Vibe-Company/armada/issues/1318)) ([2f187ba](https://github.com/The-Vibe-Company/armada/commit/2f187ba9d828700d760f46fe741ed77dec26a086))
* **runtime:** install selected pinned harness artifacts ([#1268](https://github.com/The-Vibe-Company/armada/issues/1268)) ([644dbdc](https://github.com/The-Vibe-Company/armada/commit/644dbdcfcbccaf8cbfd7b4aadae5bbd8acc0ff55))
* **runtime:** launch one Boat Codex prompt through the Armada runtime ([#1326](https://github.com/The-Vibe-Company/armada/issues/1326)) ([4fd8329](https://github.com/The-Vibe-Company/armada/commit/4fd8329916b42e48326269713b2638f8594b7026))
* **runtime:** persist fenced journal events and usage ([#1232](https://github.com/The-Vibe-Company/armada/issues/1232)) ([778d70e](https://github.com/The-Vibe-Company/armada/commit/778d70e5ef39ca89930074f761b62c980226031a))
* **runtime:** persist immutable Boat runtime selection ([#1314](https://github.com/The-Vibe-Company/armada/issues/1314)) ([1f36ce3](https://github.com/The-Vibe-Company/armada/commit/1f36ce33808823d82d304321e4c0be15596b91e8))
* **runtime:** preserve OpenCode sessions with sanitized exports ([#1298](https://github.com/The-Vibe-Company/armada/issues/1298)) ([649678d](https://github.com/The-Vibe-Company/armada/commit/649678d44b93e800227c096708469e1d14b55cb4))
* **runtime:** project private Boat Codex launch configuration ([#1305](https://github.com/The-Vibe-Company/armada/issues/1305)) ([4610ba4](https://github.com/The-Vibe-Company/armada/commit/4610ba487f27e2b9387fda6b2bcc60010c1c9606))
* **runtime:** project private Docker Codex configuration ([#1352](https://github.com/The-Vibe-Company/armada/issues/1352)) ([23f2a34](https://github.com/The-Vibe-Company/armada/commit/23f2a344d3ca18906fb3ab9cc7c4da277eec2b4b))
* **runtime:** publish native auth through the current epoch ([#1242](https://github.com/The-Vibe-Company/armada/issues/1242)) ([e9c5361](https://github.com/The-Vibe-Company/armada/commit/e9c5361dd127c5bc0f589e1cdb32152b5be081dd))
* **runtime:** read durable journal history with source provenance ([#1321](https://github.com/The-Vibe-Company/armada/issues/1321)) ([46941c6](https://github.com/The-Vibe-Company/armada/commit/46941c65634be8b9386b3153b9ec9d485c2d7afa))
* **runtime:** resume checkpointed Boat conversations ([#1356](https://github.com/The-Vibe-Company/armada/issues/1356)) ([a912c40](https://github.com/The-Vibe-Company/armada/commit/a912c4005aad50ca710f81bb1825045417308845))
* **runtime:** route persisted Boat runtime targets without native fallback ([#1322](https://github.com/The-Vibe-Company/armada/issues/1322)) ([f14271e](https://github.com/The-Vibe-Company/armada/commit/f14271e3ca875ce94c63d5242fd7e36bb251e07f))


### Bug Fixes

* **access:** fence child initialization from lifecycle cleanup ([#1358](https://github.com/The-Vibe-Company/armada/issues/1358)) ([bbe8460](https://github.com/The-Vibe-Company/armada/commit/bbe8460feeee9d8d6878d6409480cd3fdf187191))
* **accounts:** remove subscription exclusivity ([#1249](https://github.com/The-Vibe-Company/armada/issues/1249)) ([efe0525](https://github.com/The-Vibe-Company/armada/commit/efe0525d18d1185d4b5fb1ffe529dc9e5bc17239))
* **ci:** reduce informational runner contention on pull requests ([#1334](https://github.com/The-Vibe-Company/armada/issues/1334)) ([d434f89](https://github.com/The-Vibe-Company/armada/commit/d434f891213324b769278f047ba12fddd30534bb))
* **ci:** separate timing diagnostics from required verification ([#1316](https://github.com/The-Vibe-Company/armada/issues/1316)) ([fb7c45c](https://github.com/The-Vibe-Company/armada/commit/fb7c45ca9b678f1e19d1c9fdd2403914f5881fda))
* **dashboard:** drop the one-option Kind select from personal provider keys ([#1296](https://github.com/The-Vibe-Company/armada/issues/1296)) ([4d4d40b](https://github.com/The-Vibe-Company/armada/commit/4d4d40b968137565a52880d80e50591345cb935c))
* **hosts:** fence Docker jobs to frozen absolute expiry ([#1346](https://github.com/The-Vibe-Company/armada/issues/1346)) ([fb5ef79](https://github.com/The-Vibe-Company/armada/commit/fb5ef79240b0d53176ed65bfba3a0e9053e11e23))
* **release:** bump the docker-host package with every release ([#1367](https://github.com/The-Vibe-Company/armada/issues/1367)) ([ee862d3](https://github.com/The-Vibe-Company/armada/commit/ee862d398e1893a2ebbbf05a5345f8a17e27535e))
* **runtime:** preserve Boat epoch across launch completion ([#1331](https://github.com/The-Vibe-Company/armada/issues/1331)) ([5b6d798](https://github.com/The-Vibe-Company/armada/commit/5b6d7988a3c82b5e4e1a237704ea80b2738da70b))
* **runtime:** prevent Codex process-loss test from hanging ([#1342](https://github.com/The-Vibe-Company/armada/issues/1342)) ([d8cedd1](https://github.com/The-Vibe-Company/armada/commit/d8cedd15ecf26ec3b4527287d1a5b4e09de10e22))
* **runtime:** publish pinned artifacts in the server image ([#1325](https://github.com/The-Vibe-Company/armada/issues/1325)) ([5756d72](https://github.com/The-Vibe-Company/armada/commit/5756d723a859cc3cb256c53364aeb5da5d531ba5))
* **runtime:** recover Claude usage after stop and resume ([#1336](https://github.com/The-Vibe-Company/armada/issues/1336)) ([a3f3305](https://github.com/The-Vibe-Company/armada/commit/a3f33054df0c5273e4901897ca8b3f765e9d8c4e))
* **runtime:** recover usage after Codex stop and resume ([#1330](https://github.com/The-Vibe-Company/armada/issues/1330)) ([468b48f](https://github.com/The-Vibe-Company/armada/commit/468b48f8e0c31af926bfbd9db282f1ab09601dd0))
* **smoke:** diagnose unproven scoped child messages ([#1355](https://github.com/The-Vibe-Company/armada/issues/1355)) ([1619b29](https://github.com/The-Vibe-Company/armada/commit/1619b294a66c7232826c0a8f03d4f40e6cba9efb))
* **smoke:** target scoped child messages explicitly ([#1264](https://github.com/The-Vibe-Company/armada/issues/1264)) ([e6e3fb3](https://github.com/The-Vibe-Company/armada/commit/e6e3fb35d30121b4e2a42bb51cc1fb76f1d8f4bd))
* **test:** make native GitHub broker phases event-driven ([#1361](https://github.com/The-Vibe-Company/armada/issues/1361)) ([60ac604](https://github.com/The-Vibe-Company/armada/commit/60ac60407d50dd93d2708ec41bc778409638322a))
* **test:** stabilize native GitHub broker fixture phases ([#1304](https://github.com/The-Vibe-Company/armada/issues/1304)) ([c9d0d56](https://github.com/The-Vibe-Company/armada/commit/c9d0d569aa50604ee5d769af6ed5eaa86106a40c))
* **usage:** apply default token rates to ordinary sessions ([#1259](https://github.com/The-Vibe-Company/armada/issues/1259)) ([be4346f](https://github.com/The-Vibe-Company/armada/commit/be4346f0ae438e1b8ce216269fef64b3e2719308))
* **usage:** price Claude cache writes by native TTL ([#1340](https://github.com/The-Vibe-Company/armada/issues/1340)) ([3cb5110](https://github.com/The-Vibe-Company/armada/commit/3cb51100c4c232e217c037466b2db2062c3f1a58))


### Performance Improvements

* **auth:** reuse migrated fixture for row-only SQL tests ([#1288](https://github.com/The-Vibe-Company/armada/issues/1288)) ([2bf9c6c](https://github.com/The-Vibe-Company/armada/commit/2bf9c6ca7922afb3fcdeb891981f87cb912906eb))
* **ci:** accelerate migrated fixtures and shard unit verification ([#1254](https://github.com/The-Vibe-Company/armada/issues/1254)) ([6dc4573](https://github.com/The-Vibe-Company/armada/commit/6dc4573ef92024f8cfa6ddae372af6e0843faffd))
* **cli:** clone migrated fixtures for API integration tests ([#1271](https://github.com/The-Vibe-Company/armada/issues/1271)) ([2266e59](https://github.com/The-Vibe-Company/armada/commit/2266e5970e5adda062c997972f941259b4bae6e7))
* **core:** batch installer and bootstrap policy fixtures ([#1309](https://github.com/The-Vibe-Company/armada/issues/1309)) ([11e6937](https://github.com/The-Vibe-Company/armada/commit/11e693724ec511c8fb1964ccf68a1df6fc6fdc2f))
* **core:** batch isolated legacy client policy fixtures ([#1295](https://github.com/The-Vibe-Company/armada/issues/1295)) ([9f7864b](https://github.com/The-Vibe-Company/armada/commit/9f7864bf892d8371d966967b0220f37abb9508a5))
* **core:** clone migrated fixtures for authorization tests ([#1267](https://github.com/The-Vibe-Company/armada/issues/1267)) ([deeac18](https://github.com/The-Vibe-Company/armada/commit/deeac180ee13ec2147a8ca4f77e021f9b9503ede))
* **core:** clone migrated fixtures for golden database suites ([#1265](https://github.com/The-Vibe-Company/armada/issues/1265)) ([16bf0b5](https://github.com/The-Vibe-Company/armada/commit/16bf0b5143ade71eb65b3231fcf51737dcab07fa))
* **core:** copy pristine Git fixtures for recovery tests ([#1290](https://github.com/The-Vibe-Company/armada/issues/1290)) ([a98b0e3](https://github.com/The-Vibe-Company/armada/commit/a98b0e3bed472fe407045d3eae9c94a74a79eaf4))
* **core:** isolate scan fixtures and prune duplicate regressions ([#1282](https://github.com/The-Vibe-Company/armada/issues/1282)) ([ff62e7d](https://github.com/The-Vibe-Company/armada/commit/ff62e7d14e800ba34bedce8b71d4f3706224a456))
* **core:** reuse migrated database in retirement tests ([#1258](https://github.com/The-Vibe-Company/armada/issues/1258)) ([d6cbec9](https://github.com/The-Vibe-Company/armada/commit/d6cbec90bc16f1076b4164514fca965ceb678ccf))
* **core:** reuse migrated images for provider admission tests ([#1289](https://github.com/The-Vibe-Company/armada/issues/1289)) ([7a7fc33](https://github.com/The-Vibe-Company/armada/commit/7a7fc33586ff00e0b03db3842f2c118399390be9))
* **core:** share migrated database across row-only vault tests ([#1262](https://github.com/The-Vibe-Company/armada/issues/1262)) ([e6117be](https://github.com/The-Vibe-Company/armada/commit/e6117be511732ec7f96afe4d4c4df8e1d03ec4b1))
* **core:** share migrated image bootstrap across row fixtures ([#1293](https://github.com/The-Vibe-Company/armada/issues/1293)) ([dd8ea3d](https://github.com/The-Vibe-Company/armada/commit/dd8ea3d53a276a2c211fc6c657e5d444caa95ef8))
* **test:** restore MCP fixtures from a pristine migrated image ([#1260](https://github.com/The-Vibe-Company/armada/issues/1260)) ([f8b83b4](https://github.com/The-Vibe-Company/armada/commit/f8b83b400be33d30ce4f10e5f13c5a2f4004e8f0))
* **test:** reuse migrated images in remaining MCP SQL fixtures ([#1266](https://github.com/The-Vibe-Company/armada/issues/1266)) ([6943965](https://github.com/The-Vibe-Company/armada/commit/6943965a7cadcc698ad5604fee9103829a7b9d4d))
* **test:** reuse migrated images in vault and authorization fixtures ([#1261](https://github.com/The-Vibe-Company/armada/issues/1261)) ([9175338](https://github.com/The-Vibe-Company/armada/commit/9175338c28353494138545cee403c3f8a734e76b))
* **test:** reuse raw row-only control API fixtures ([#1312](https://github.com/The-Vibe-Company/armada/issues/1312)) ([e1474a2](https://github.com/The-Vibe-Company/armada/commit/e1474a2b110f8a0a2d9317b3494ace812af5e03b))
* **test:** reuse row-only fixtures in MCP server tests ([#1299](https://github.com/The-Vibe-Company/armada/issues/1299)) ([19447a0](https://github.com/The-Vibe-Company/armada/commit/19447a00c0ebb8180fbbed0bb9171d289fd96a2a))
* **test:** reuse row-only golden build job fixtures ([#1365](https://github.com/The-Vibe-Company/armada/issues/1365)) ([0b43fb7](https://github.com/The-Vibe-Company/armada/commit/0b43fb75f12540b1f5931a4622932512b491c2fb))
* **test:** reuse row-only orchestrator child fixtures ([#1350](https://github.com/The-Vibe-Company/armada/issues/1350)) ([631c44f](https://github.com/The-Vibe-Company/armada/commit/631c44fed2f0e028a0ae121c229d8bfe2ff19290))
* **test:** reuse row-only orchestrator lifecycle fixtures ([#1275](https://github.com/The-Vibe-Company/armada/issues/1275)) ([c5df4af](https://github.com/The-Vibe-Company/armada/commit/c5df4af4ddfddac2af691ac1ecd6e853c6e8b06b))
* **test:** reuse row-only orchestrator recovery fixtures ([#1291](https://github.com/The-Vibe-Company/armada/issues/1291)) ([1bcf32f](https://github.com/The-Vibe-Company/armada/commit/1bcf32fc4caa228519cb52879fe4aa8f2f750bbc))
* **test:** reuse row-only runtime command fixtures ([#1353](https://github.com/The-Vibe-Company/armada/issues/1353)) ([95eb8ea](https://github.com/The-Vibe-Company/armada/commit/95eb8ea49e9c999b4b535c7233371da78d3c62e2))
* **test:** reuse row-only sandbox lifecycle fixtures ([#1349](https://github.com/The-Vibe-Company/armada/issues/1349)) ([3e4959a](https://github.com/The-Vibe-Company/armada/commit/3e4959a32fe94e2cfe8fdce5a3735214bd07ab07))
* **test:** reuse row-only template fixtures ([#1347](https://github.com/The-Vibe-Company/armada/issues/1347)) ([98be44c](https://github.com/The-Vibe-Company/armada/commit/98be44caa0f6a2ed7ee85a321141744a90b5c92b))
* **test:** share row-only database fixtures with create jobs ([#1286](https://github.com/The-Vibe-Company/armada/issues/1286)) ([2fd0767](https://github.com/The-Vibe-Company/armada/commit/2fd07679adbdf4606521c545ec17fc5bfc222707))

## [2.25.0](https://github.com/The-Vibe-Company/armada/compare/v2.24.0...v2.25.0) (2026-11-12)


### Features

* **accounts:** share server-owned Codex subscriptions across sandboxes ([#1186](https://github.com/The-Vibe-Company/armada/issues/1186)) ([8d78ebd](https://github.com/The-Vibe-Company/armada/commit/8d78ebde1752ecb101fe886d92f7746e19693093))
* **cli:** add Claude gateway connection fields ([#1216](https://github.com/The-Vibe-Company/armada/issues/1216)) ([63e475c](https://github.com/The-Vibe-Company/armada/commit/63e475c7cd037746b326ee5473d9fa1707ce2da7))
* **cli:** add Codex custom endpoint fields ([#1199](https://github.com/The-Vibe-Company/armada/issues/1199)) ([fbb61c7](https://github.com/The-Vibe-Company/armada/commit/fbb61c798adf499d0b0172abb70f183b305d643d))
* **dashboard:** add Claude gateway creation fields ([#1211](https://github.com/The-Vibe-Company/armada/issues/1211)) ([cf0f0eb](https://github.com/The-Vibe-Company/armada/commit/cf0f0eb0d49c7d1f85b5c027e5ad97cd85ade5a9))
* **dashboard:** add Codex custom endpoint creation fields ([#1204](https://github.com/The-Vibe-Company/armada/issues/1204)) ([8ab8932](https://github.com/The-Vibe-Company/armada/commit/8ab8932f06c1473bc41251d2bef3a17f86516745))
* **dashboard:** add explicit Claude gateway replacement ([#1231](https://github.com/The-Vibe-Company/armada/issues/1231)) ([9dee025](https://github.com/The-Vibe-Company/armada/commit/9dee0254c4c20666a9de2a4f3c38b238e3434285))
* **dashboard:** add explicit Codex connection replacement ([#1224](https://github.com/The-Vibe-Company/armada/issues/1224)) ([b74ab9f](https://github.com/The-Vibe-Company/armada/commit/b74ab9f5d8b182a066482551f1f57949e70bd93a))
* **dashboard:** open environment and template details in a side panel ([#1154](https://github.com/The-Vibe-Company/armada/issues/1154)) ([9364a90](https://github.com/The-Vibe-Company/armada/commit/9364a904ec8c33cd95ae05ce28c76de0bcd31455))
* **models:** support Claude gateways on Modal ([#1195](https://github.com/The-Vibe-Company/armada/issues/1195)) ([eeb9d11](https://github.com/The-Vibe-Company/armada/commit/eeb9d11bb16f48e49d4d85cada6e17a8484664a0))
* **models:** support Codex custom endpoints on Modal ([#1181](https://github.com/The-Vibe-Company/armada/issues/1181)) ([6549e4c](https://github.com/The-Vibe-Company/armada/commit/6549e4c87eabaac9c1716942a9386adf8dea7b88))
* **runtime:** add digest-checked artifact bootstrap cache ([#1191](https://github.com/The-Vibe-Company/armada/issues/1191)) ([222f5b9](https://github.com/The-Vibe-Company/armada/commit/222f5b9ded737b462f01629ad62c63c299ec5039))
* **runtime:** add durable HTTPS command bridge ([#1222](https://github.com/The-Vibe-Company/armada/issues/1222)) ([eff35ea](https://github.com/The-Vibe-Company/armada/commit/eff35ea996045c3a27b49051db720c6cb2518b50))
* **runtime:** add enrolment and dial-out client mode ([#1206](https://github.com/The-Vibe-Company/armada/issues/1206)) ([da9e849](https://github.com/The-Vibe-Company/armada/commit/da9e8499b30a5b67672a6eb69e3c500da0a41ad5))
* **runtime:** add private model connection checks ([#1226](https://github.com/The-Vibe-Company/armada/issues/1226)) ([874b719](https://github.com/The-Vibe-Company/armada/commit/874b7191a8ec03b2d097f8fe2db096a05aa2bb41))
* **runtime:** add single-use enrolment and epoch fencing ([#1198](https://github.com/The-Vibe-Company/armada/issues/1198)) ([8f72df1](https://github.com/The-Vibe-Company/armada/commit/8f72df12764dd325f4919000f42282a172651f9e))
* **runtime:** build and validate the compiled Codex artifact ([#1185](https://github.com/The-Vibe-Company/armada/issues/1185)) ([5b42d33](https://github.com/The-Vibe-Company/armada/commit/5b42d331b9ec604e9cf849c97345340294fd318a))
* **runtime:** deliver commands over authenticated WebSockets ([#1236](https://github.com/The-Vibe-Company/armada/issues/1236)) ([5eba05c](https://github.com/The-Vibe-Company/armada/commit/5eba05c939e0c4c5304ab39b3a01971a5506d35c))
* **usage:** accept sealed model connection price overrides ([#1223](https://github.com/The-Vibe-Company/armada/issues/1223)) ([bb7fb2a](https://github.com/The-Vibe-Company/armada/commit/bb7fb2aecd8c05f40284c84a135c2dc5b8b1bcd9))
* **usage:** add server price table and exact token calculator ([#1184](https://github.com/The-Vibe-Company/armada/issues/1184)) ([6ba8bdd](https://github.com/The-Vibe-Company/armada/commit/6ba8bdd9e39627caf1f794d80f18e1e8f396a5d3))
* **usage:** freeze Modal session pricing at admission ([#1205](https://github.com/The-Vibe-Company/armada/issues/1205)) ([12ee1ee](https://github.com/The-Vibe-Company/armada/commit/12ee1eecfc247a61cfe7d0f519e995ead9737c5a))
* **usage:** persist frozen server turn price records ([#1240](https://github.com/The-Vibe-Company/armada/issues/1240)) ([8f51dad](https://github.com/The-Vibe-Company/armada/commit/8f51dad993f50cb48ed91c31d8545146d44881a9))
* **usage:** publish server-priced session amounts ([#1245](https://github.com/The-Vibe-Company/armada/issues/1245)) ([ac8dc0e](https://github.com/The-Vibe-Company/armada/commit/ac8dc0eb2049cd44849faef4760c879c5beb9aee))
* **usage:** retain Claude cache-write lifetimes ([#1197](https://github.com/The-Vibe-Company/armada/issues/1197)) ([10c50a4](https://github.com/The-Vibe-Company/armada/commit/10c50a4340f24b928b2690463af4d28464d6cedb))


### Bug Fixes

* **accounts:** recover subscriptions after failed launches ([#1180](https://github.com/The-Vibe-Company/armada/issues/1180)) ([7295fc0](https://github.com/The-Vibe-Company/armada/commit/7295fc0ed7d5b5beb29da8f05f2a1a317455e441))
* **dashboard:** align list columns across rows ([#1229](https://github.com/The-Vibe-Company/armada/issues/1229)) ([f798e4d](https://github.com/The-Vibe-Company/armada/commit/f798e4d26ed2bbd4d6700938de619c7af5fd0bb3))
* **dashboard:** keep panel history handoff when Back precedes hydration ([#1235](https://github.com/The-Vibe-Company/armada/issues/1235)) ([54af56f](https://github.com/The-Vibe-Company/armada/commit/54af56f418f00e92a829086157179ed0f6ca4f15))
* **dashboard:** make API keys first-class model account choices ([#1182](https://github.com/The-Vibe-Company/armada/issues/1182)) ([f9832e1](https://github.com/The-Vibe-Company/armada/commit/f9832e17a61d2d70273707a382668d6e39ca0cc2))
* **dashboard:** open routine details in shared side panel ([#1203](https://github.com/The-Vibe-Company/armada/issues/1203)) ([bcfc7fe](https://github.com/The-Vibe-Company/armada/commit/bcfc7fef88e81ece2c900c72d9c98e6df322aea3))
* **dashboard:** open tool details in shared side panel ([#1193](https://github.com/The-Vibe-Company/armada/issues/1193)) ([6764008](https://github.com/The-Vibe-Company/armada/commit/676400878bd85af7f246be5a0c57c0b5a45045ab))
* **dashboard:** open variable details in shared side panel ([#1196](https://github.com/The-Vibe-Company/armada/issues/1196)) ([936c808](https://github.com/The-Vibe-Company/armada/commit/936c80869c222ea8ca2c6a00b288695559f3b7de))
* **dashboard:** remove sidebar descriptive subtext ([#1152](https://github.com/The-Vibe-Company/armada/issues/1152)) ([1e932b5](https://github.com/The-Vibe-Company/armada/commit/1e932b5752d8571b026d23f8d7cb69a4398eda12))
* **dashboard:** restore main browser test coverage ([#1225](https://github.com/The-Vibe-Company/armada/issues/1225)) ([3acc4a5](https://github.com/The-Vibe-Company/armada/commit/3acc4a5788fc9946f23c7ae14f8c76aaa55205a4))
* **dashboard:** say a failed sandbox failed in the closed composer ([#1230](https://github.com/The-Vibe-Company/armada/issues/1230)) ([96255a4](https://github.com/The-Vibe-Company/armada/commit/96255a420e94af120f97dbfdfe9289487690e0c1))
* **dashboard:** wait for panel actionability in history e2e tests ([#1210](https://github.com/The-Vibe-Company/armada/issues/1210)) ([5b7ba1d](https://github.com/The-Vibe-Company/armada/commit/5b7ba1dd18b05e622a27ab902bbed5f5e905b5e0))
* **github:** return typed unsupported refusal for Modal refresh ([#1243](https://github.com/The-Vibe-Company/armada/issues/1243)) ([c39e3d0](https://github.com/The-Vibe-Company/armada/commit/c39e3d0176953a1bb74814b0c6d87f361c8b3217))
* **security:** bind managed REST authorization to its endpoint ([#1092](https://github.com/The-Vibe-Company/armada/issues/1092)) ([1834ad1](https://github.com/The-Vibe-Company/armada/commit/1834ad1cc85faf75b1dae263b1d4b3801d024c9a))
* **templates:** preserve launch refusals and allow account selection ([#1183](https://github.com/The-Vibe-Company/armada/issues/1183)) ([6ec329c](https://github.com/The-Vibe-Company/armada/commit/6ec329c4d9a4214bf8da85b3d8ce5ae8163f27b5))
* **usage:** adopt verified Codex resume baselines ([#1209](https://github.com/The-Vibe-Company/armada/issues/1209)) ([a79af23](https://github.com/The-Vibe-Company/armada/commit/a79af23a60536f80568d247f2ffe28ee24e536b5))
* **usage:** attribute Codex turns to the native model ([#1192](https://github.com/The-Vibe-Company/armada/issues/1192)) ([36ae3e2](https://github.com/The-Vibe-Company/armada/commit/36ae3e24e8216afb86d8336861c654284589bfe7))
* **usage:** reject unverified Claude session totals ([#1202](https://github.com/The-Vibe-Company/armada/issues/1202)) ([a534d51](https://github.com/The-Vibe-Company/armada/commit/a534d514121f979c85ac2c9dae2df67fce82ad43))
* **usage:** restore Modal journal token accounting ([#1241](https://github.com/The-Vibe-Company/armada/issues/1241)) ([04832a3](https://github.com/The-Vibe-Company/armada/commit/04832a39e4609c6e155e90af9bd16d1f7776377a))

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
