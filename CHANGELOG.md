# Changelog

## [2.1.0](https://github.com/theopoc/pocketmark/compare/v2.0.0...v2.1.0) (2026-11-27)


### Features

* **dev:** isolate the dev stack per git worktree ([#228](https://github.com/theopoc/pocketmark/issues/228)) ([c49064e](https://github.com/theopoc/pocketmark/commit/c49064e97efa90f1cab525e38b317b5a41c89d4a))
* **observability:** expose queue backlog and worker heartbeats ([#240](https://github.com/theopoc/pocketmark/issues/240)) ([1aa857c](https://github.com/theopoc/pocketmark/commit/1aa857cea0de00b2c6411c2455a6f7143d875211))
* **observability:** readable log messages and severity levels ([#236](https://github.com/theopoc/pocketmark/issues/236)) ([c103808](https://github.com/theopoc/pocketmark/commit/c103808f97e39263a815ac758a06779e15b9da61))
* **observability:** recover and log panics in background workers ([#239](https://github.com/theopoc/pocketmark/issues/239)) ([6189a23](https://github.com/theopoc/pocketmark/commit/6189a23f73daf911fd22fe605c30bb4fa77af6a5))


### Bug Fixes

* **backup:** finish runs whose backup window has ended ([#233](https://github.com/theopoc/pocketmark/issues/233)) ([174133e](https://github.com/theopoc/pocketmark/commit/174133efaf3d3720bc95c078b2c07f52c0fa56d4))
* **metrics:** keep serving /metrics when PostgreSQL is slow or down ([#238](https://github.com/theopoc/pocketmark/issues/238)) ([070a806](https://github.com/theopoc/pocketmark/commit/070a806f355c194c30c6d680e4ad66ed18cbba2e))
* **release:** let reusable CI read pull requests ([#242](https://github.com/theopoc/pocketmark/issues/242)) ([c2a1f9c](https://github.com/theopoc/pocketmark/commit/c2a1f9c851605007bb8e2f899e72940b377d15b0))
* **ui:** keep toast host attached when a React dialog unmounts ([#224](https://github.com/theopoc/pocketmark/issues/224)) ([41a229c](https://github.com/theopoc/pocketmark/commit/41a229c65f571904b3b041682428ef5f8179769b))

## [2.0.0](https://github.com/theopoc/pocketmark/compare/v1.3.4...v2.0.0) (2026-11-23)


### ⚠ BREAKING CHANGES

* **storage:** configure PostgreSQL 18 and import existing SQLite libraries offline before starting the new server. Preserve the original server secret to retain MFA and sessions.

### Features

* **backup:** schedule verified remote backups ([a3b6ac9](https://github.com/theopoc/pocketmark/commit/a3b6ac9823df005025313ec2cd7059abc9ba5645))
* **config:** add POCKETMARK_SERVER_SECRET ([026eae3](https://github.com/theopoc/pocketmark/commit/026eae3280c5997bae82151f6e1b1bc3d62eb921))
* **dev:** start Pocketmark locally with make up ([314a4ab](https://github.com/theopoc/pocketmark/commit/314a4ab86af744d9578979e2a7fcf997ab9864e3))
* **dev:** stop the local stack with make down ([f08fb5b](https://github.com/theopoc/pocketmark/commit/f08fb5bbe88ed7c5f88433910b5d1f6a24d41699))
* **extension:** show saved pages and confirm saves in the tab ([fb77888](https://github.com/theopoc/pocketmark/commit/fb77888f3f9394d20385d315edf573f9df47105a))
* **library:** group bookmark filters in a segmented control ([0b43d39](https://github.com/theopoc/pocketmark/commit/0b43d39a413c32d0121edc1b34850ca67f29b6ad))
* **library:** refine the segmented filter selector ([22f2928](https://github.com/theopoc/pocketmark/commit/22f292894d24004adab5b4a0adcc930c74f21b62))
* **library:** show and remove active tag filters ([c26eb64](https://github.com/theopoc/pocketmark/commit/c26eb64191b0cd0c48e9a4334c4b3bc8bd5195b2))
* **reader:** add a graduated text size slider ([3896c48](https://github.com/theopoc/pocketmark/commit/3896c4855cf580b2c952547c89705b0512338187))
* **reader:** open saved articles in a reading panel ([32c5c12](https://github.com/theopoc/pocketmark/commit/32c5c1297635ed2c9a3412e04e0d94300b53d349))
* **reader:** refine article layout and capture recovery ([c7d62ef](https://github.com/theopoc/pocketmark/commit/c7d62efc4ddccb617f9639e76aca0f7aacdf37a0))
* **settings:** redesign account security, sessions and API keys ([e1480d3](https://github.com/theopoc/pocketmark/commit/e1480d3bbda57b9d1ad77bb1dbc5d1718ea77397))
* **settings:** redesign the personal library settings workspace ([e1d3b05](https://github.com/theopoc/pocketmark/commit/e1d3b052a61bdf29bb7387d3f4e8c454abec6fc4))
* **storage:** replace SQLite with PostgreSQL ([1693bf7](https://github.com/theopoc/pocketmark/commit/1693bf7a38932c7e370fb1f9848ab30c215254bf))
* **tagging:** classify bookmarks with an Anthropic API key ([#196](https://github.com/theopoc/pocketmark/issues/196)) ([8ce827a](https://github.com/theopoc/pocketmark/commit/8ce827a5750d4a52e7a472fd8f3cbebdc9f6aa63))
* **tagging:** classify untagged bookmarks with a ChatGPT plan ([f3cee99](https://github.com/theopoc/pocketmark/commit/f3cee996a18832f86c415fa4365ed3ed0c1a279f))
* **tagging:** create lowercase tags when no existing tag fits ([a848a17](https://github.com/theopoc/pocketmark/commit/a848a17045a8a5e1e41f07ad84323e5795cd5964))
* **ui:** embed the Figtree font ([#192](https://github.com/theopoc/pocketmark/issues/192)) ([ff8867b](https://github.com/theopoc/pocketmark/commit/ff8867becedd52eb2e48a8f453010dda6267d298))
* **ui:** finish the redesign with the new mark, extension and design doc ([#195](https://github.com/theopoc/pocketmark/issues/195)) ([f57d27c](https://github.com/theopoc/pocketmark/commit/f57d27ce75d3a74667f724cd32013a3aa26fb0cb))
* **ui:** float the library panels and make selection actions icon-only ([#193](https://github.com/theopoc/pocketmark/issues/193)) ([c5157b7](https://github.com/theopoc/pocketmark/commit/c5157b7f1319348b2c62edc3b2e8f04f87e81445))
* **ui:** replace the indigo palette with teal tokens ([#191](https://github.com/theopoc/pocketmark/issues/191)) ([f5fd793](https://github.com/theopoc/pocketmark/commit/f5fd7932ff67d74ece60cc43b5766a68192dc243))
* **ui:** round dialogs and strengthen error toasts ([#194](https://github.com/theopoc/pocketmark/issues/194)) ([9b83186](https://github.com/theopoc/pocketmark/commit/9b83186e2e7f2ff4d8a950bd780bfa251db3a7e4))


### Bug Fixes

* **auth:** share MFA challenges across replicas ([2defb51](https://github.com/theopoc/pocketmark/commit/2defb51fae60a66f3004e31fac17e4047c406d08))
* **backup:** route rolling exports to the target revision ([518fe5e](https://github.com/theopoc/pocketmark/commit/518fe5efc8e1aabc5581e761e3247bb0d70fa01e))
* **extension:** keep save confirmation visible before closing ([5d03d5e](https://github.com/theopoc/pocketmark/commit/5d03d5ef64443ffccddfa91281698b35a0293068))
* **reader:** preserve article images, asides and code formatting ([b349897](https://github.com/theopoc/pocketmark/commit/b3498970d75d1345add247f41260c497374b1b22))
* **tagging:** classify bookmarks with English tags ([59a0042](https://github.com/theopoc/pocketmark/commit/59a004241f96695f4826a51146c8ddcfd1918051))
* **tagging:** request JSON in ChatGPT input messages ([7913d55](https://github.com/theopoc/pocketmark/commit/7913d5524952aaf858383bcd63166aa232b489db))
* **ui:** align components with design system ([e025b4e](https://github.com/theopoc/pocketmark/commit/e025b4e7f4252afc0953205a7f9a1e72c9a685fc))
* **ui:** center quick-filter labels ([a479eb0](https://github.com/theopoc/pocketmark/commit/a479eb022818bb0366cf6e0c11480094b50aa162))
* **ui:** match button colors to action roles ([25a4b89](https://github.com/theopoc/pocketmark/commit/25a4b898c57641889b78732b11f8c9b4b21aaafb))
* **ui:** smooth sidebar expansion and collapse ([0b2c0c0](https://github.com/theopoc/pocketmark/commit/0b2c0c0c49096ae11b85bac09660b4ccc32aef56))
* **ui:** unify toast design ([54be708](https://github.com/theopoc/pocketmark/commit/54be70879c622d49021b8c0bc27412c7ef06e646))

## [1.3.4](https://github.com/theopoc/pocketmark/compare/v1.3.3...v1.3.4) (2026-11-09)


### Bug Fixes

* **ui:** align settings typography and density with the library ([bda1c6d](https://github.com/theopoc/pocketmark/commit/bda1c6d47f7a037d9fea6a50854c611a78a18e7c))
* **ui:** keep settings navigation consistent across sections ([08abdde](https://github.com/theopoc/pocketmark/commit/08abdde41a748ffae2f0420318a330b6c649e47b))

## [1.3.3](https://github.com/theopoc/pocketmark/compare/v1.3.2...v1.3.3) (2026-11-04)


### Bug Fixes

* **capture:** log rejected HTTP status ([96bf36f](https://github.com/theopoc/pocketmark/commit/96bf36f32f8a81686130740f7d8d270d895ab44f))
* **observability:** preserve actionable failure diagnostics ([ef989b4](https://github.com/theopoc/pocketmark/commit/ef989b4c4d9f190f1e2644fa495344c13eefd4b3))
* **ui:** remove library capture summary ([2d05733](https://github.com/theopoc/pocketmark/commit/2d05733bf27ea7bebcf5c97d1572da56aa708924))
* **ui:** share canonical Pocketmark icon ([92f847b](https://github.com/theopoc/pocketmark/commit/92f847b38a4dcc07a610946b52d72a88d6894a07))

## [1.3.2](https://github.com/theopoc/pocketmark/compare/v1.3.1...v1.3.2) (2026-11-02)


### Bug Fixes

* **ci:** enforce full CodeQL checks on PRs ([9861862](https://github.com/theopoc/pocketmark/commit/9861862226408da69a6a890091a0f1a1621e1725))

## [1.3.1](https://github.com/theopoc/pocketmark/compare/v1.3.0...v1.3.1) (2026-11-02)


### Bug Fixes

* **ci:** scope reviewed CodeQL suppressions ([#132](https://github.com/theopoc/pocketmark/issues/132)) ([3ef7c95](https://github.com/theopoc/pocketmark/commit/3ef7c95168461b2061b49d9aef5ec75f35a24c53))
* **security:** harden credentials and previews and gate security scans ([00794c1](https://github.com/theopoc/pocketmark/commit/00794c19f29f298c9c53983e428214b863e88b85))
* **ui:** match the approved API key page design ([ecce08b](https://github.com/theopoc/pocketmark/commit/ecce08bf0933e108c7cd592c4f0cf3b76d9c9513))

## [1.3.0](https://github.com/theopoc/pocketmark/compare/v1.2.0...v1.3.0) (2026-11-01)


### Features

* simplify account security settings ([9ce7682](https://github.com/theopoc/pocketmark/commit/9ce76829345eacaabf6be1572e68ebdc664a0547))
* **ui:** add automatic and fixed sidebar modes ([#79](https://github.com/theopoc/pocketmark/issues/79)) ([7584f3d](https://github.com/theopoc/pocketmark/commit/7584f3d2d94beafd5c5fc3b5e5b9e94a47fd499c))
* **ui:** add cached bookmark thumbnails ([5a58294](https://github.com/theopoc/pocketmark/commit/5a58294066b65d1106307732deac56ff2aefaf82))
* **ui:** add capture status badges and progress spinner ([895000e](https://github.com/theopoc/pocketmark/commit/895000e168972974df8dd95d77543dcf769ac8f0))
* **ui:** add quick bookmark filters ([404d984](https://github.com/theopoc/pocketmark/commit/404d98449619edcf2274e79f29ccd8563a397bc8))
* **ui:** align bookmark list details in columns ([#120](https://github.com/theopoc/pocketmark/issues/120)) ([70bdefa](https://github.com/theopoc/pocketmark/commit/70bdefa4bd31e6670c8b623429fee822d964fade))
* **ui:** apply annotated library toolbar and row layout ([b047e6d](https://github.com/theopoc/pocketmark/commit/b047e6dfcf14b9c990249d81379c24d4687d0e76))
* **ui:** complete interface consistency and saved-file polish ([7bcfce3](https://github.com/theopoc/pocketmark/commit/7bcfce398c7e0698ff3986dbd7c3650f5f08c70c))
* **ui:** confirm bookmark deletion in app ([ca8af84](https://github.com/theopoc/pocketmark/commit/ca8af84d172ba852e1013f7c54bf14d162b0f427))
* **ui:** float bookmark selection actions ([#108](https://github.com/theopoc/pocketmark/issues/108)) ([85c50e8](https://github.com/theopoc/pocketmark/commit/85c50e8cb956f25242921fa00a683bdb04f8025c))
* **ui:** polish library workflows and saved-format navigation ([793b220](https://github.com/theopoc/pocketmark/commit/793b2208bf33522096fa6fb64ec936cc81b09ee6))
* **ui:** refine approved surfaces and preserve library controls ([043eca8](https://github.com/theopoc/pocketmark/commit/043eca8d150d7b44db0bd908247598f4781d9f50))
* **ui:** refine bookmark cards and library branding ([#81](https://github.com/theopoc/pocketmark/issues/81)) ([200397a](https://github.com/theopoc/pocketmark/commit/200397ab7a27a00fb45847a5b3fbbba588d9ac11))
* **ui:** replace browser confirmation prompts ([3106ec2](https://github.com/theopoc/pocketmark/commit/3106ec28cd5a78526e4b4c59700c5a55b63e243a))
* **ui:** select bookmarks with mouse gestures and animate removals ([f28f0fc](https://github.com/theopoc/pocketmark/commit/f28f0fc221664245a4cda2d2ac75527674007aec))
* **ui:** show site icons in bookmark list ([#121](https://github.com/theopoc/pocketmark/issues/121)) ([4ae176a](https://github.com/theopoc/pocketmark/commit/4ae176aec28d2e5980c2eecd7eb69344474d4e2a))
* **ui:** simplify library controls and include near matches ([5de88cc](https://github.com/theopoc/pocketmark/commit/5de88ccd392f61fb324c6b1755e60da24827dbd2))
* **ui:** simplify selected bookmark actions ([6ccd10b](https://github.com/theopoc/pocketmark/commit/6ccd10b3e4bdcf4dbb5ccc171085ff8a72d18022))
* **ui:** theme selectors across Pocketmark ([75c93fa](https://github.com/theopoc/pocketmark/commit/75c93fa55b4ff3ee96523832a3dba90735a444e6))
* **ui:** use expandable API key rows ([bcfa2f4](https://github.com/theopoc/pocketmark/commit/bcfa2f461d220c6c9902adefd4a8f08e4de9f262))


### Bug Fixes

* align sidebar help links ([e84fc75](https://github.com/theopoc/pocketmark/commit/e84fc7538c967242a2d48b8b31e992fd47b396c5))
* dismiss all dialogs when clicking outside ([2de80f1](https://github.com/theopoc/pocketmark/commit/2de80f178b74811496ffbec255b0b870da8b7ab5))
* reveal collection actions on hover ([21749c9](https://github.com/theopoc/pocketmark/commit/21749c90d1c279debfa07ef98c769f90b2f5894e))
* **security:** create API keys without password confirmation ([f41795b](https://github.com/theopoc/pocketmark/commit/f41795b042ee2d251ae27b8a68cda88bf888a8cc))
* **ui:** align dark brand and favicon colors ([0308444](https://github.com/theopoc/pocketmark/commit/0308444c495afe37a34ca0f801e8ee7e57ce067d))
* **ui:** align theme colors and accessible API controls ([bed5968](https://github.com/theopoc/pocketmark/commit/bed596889f526dea3b73a45b7bc227b563372ed2))
* **ui:** clarify selection action labels ([469e2bf](https://github.com/theopoc/pocketmark/commit/469e2bfa0cc83963095acb4ddcb2b1e3a1bc9a44))
* **ui:** collapse sidebar when disabling fixed mode ([93f6ef5](https://github.com/theopoc/pocketmark/commit/93f6ef5a016490e98d7cd8b09c8934d809a0f376))
* **ui:** keep sidebar layout stable for library tools ([4bbe4a2](https://github.com/theopoc/pocketmark/commit/4bbe4a2513ef60cfe54b2ba0cee2122a95dd996f))
* **ui:** make breadcrumb levels navigable ([b922139](https://github.com/theopoc/pocketmark/commit/b922139405150876aac0f9ab087106729ca6cc9f))
* **ui:** match selection toolbar colors to active theme ([35e747e](https://github.com/theopoc/pocketmark/commit/35e747e706ad9e1c4decb67d89fc68f0aa2d25cd))
* **ui:** polish API key management ([5112f0b](https://github.com/theopoc/pocketmark/commit/5112f0b59adaea64da19d28e4a11c64e6c34ace8))
* **ui:** redesign favorite snackbar ([98330cc](https://github.com/theopoc/pocketmark/commit/98330ccf59ea1f0b7e8c5bf5bd08d99147898962))
* **ui:** remove decorative bookmark card icons ([#90](https://github.com/theopoc/pocketmark/issues/90)) ([05a1025](https://github.com/theopoc/pocketmark/commit/05a10254d2bd5414e2f1fe5026fe9873c762e0c6))
* **ui:** show collection name errors only when needed ([be8e9bb](https://github.com/theopoc/pocketmark/commit/be8e9bb6cc9483b364ffcd75ebab6828a433f3c8))
* **ui:** show spinner while refreshing library ([213c145](https://github.com/theopoc/pocketmark/commit/213c1450aed76025ae018ef4ad2b2ef1c178a145))


### Reverts

* **ui:** restore interface before PR 102 ([e678b74](https://github.com/theopoc/pocketmark/commit/e678b747e0320dd63dc410fc7add647b81066c2b))

## [1.2.0](https://github.com/theopoc/pocketmark/compare/v1.1.0...v1.2.0) (2026-10-31)


### Features

* **auth:** allow copying MFA setup key ([#61](https://github.com/theopoc/pocketmark/issues/61)) ([2049afb](https://github.com/theopoc/pocketmark/commit/2049afb16098187e058fbda96cf1a7360600cc62))
* **auth:** download recovery codes ([#60](https://github.com/theopoc/pocketmark/issues/60)) ([7881bb1](https://github.com/theopoc/pocketmark/commit/7881bb14764a834f299662ff07eb47fb96c09a63))
* refine library empty states and rename Tags ([368ae4d](https://github.com/theopoc/pocketmark/commit/368ae4d7369fb35afdf1e8a34d0d10ddfcbaf811))
* **ui:** add bookmark sort menu beside view controls ([273b218](https://github.com/theopoc/pocketmark/commit/273b2187e40c0e804f8476262136f7967d9198cd))
* **ui:** add off-canvas navigation and sign-out confirmation ([#76](https://github.com/theopoc/pocketmark/issues/76)) ([f4ff490](https://github.com/theopoc/pocketmark/commit/f4ff490d91faf0fd60650cb34e164f615694aa4e))
* **ui:** move settings into workspace navigation ([#68](https://github.com/theopoc/pocketmark/issues/68)) ([a50b225](https://github.com/theopoc/pocketmark/commit/a50b22522ad67970018b7dad86bfe2f2850ff9c7))
* **ui:** move workspace actions into a popover ([aec3a4f](https://github.com/theopoc/pocketmark/commit/aec3a4f2442571f307b1a3527f1996b16944a711))
* **ui:** prioritize reading with a direct original link ([#65](https://github.com/theopoc/pocketmark/issues/65)) ([8835234](https://github.com/theopoc/pocketmark/commit/88352345c9b29add815a2edb6600bd4be6ac67f6))
* **ui:** prioritize saved bookmark formats ([231f90e](https://github.com/theopoc/pocketmark/commit/231f90e6d6f004c958199524b9ef482da0b24bbc))


### Bug Fixes

* animate entry to settings workspace ([0ac769c](https://github.com/theopoc/pocketmark/commit/0ac769c5695b2f81cd4628323557affd289bb9eb))
* **reader:** close on backdrop click ([#66](https://github.com/theopoc/pocketmark/issues/66)) ([b6b28a0](https://github.com/theopoc/pocketmark/commit/b6b28a0d337646e0687fd76214847ba9dec36a77))
* **ui:** animate help topic accordions ([1cf4f91](https://github.com/theopoc/pocketmark/commit/1cf4f91ea09795a1e1570cefb2351f0e4cfa1fd3))
* **ui:** choose HTML capture when saving bookmarks ([#64](https://github.com/theopoc/pocketmark/issues/64)) ([5fe7a8e](https://github.com/theopoc/pocketmark/commit/5fe7a8ebb7c15fbccc8201d5042476a9f62b9499))
* **ui:** clarify bookmark actions and favorite placement ([9cb9a95](https://github.com/theopoc/pocketmark/commit/9cb9a95ae7ae4b77ab5c1985791c000fbe04833e))

## [1.1.0](https://github.com/theopoc/pocketmark/compare/v1.0.0...v1.1.0) (2026-10-30)


### Features

* **web:** improve library and reader usability ([#58](https://github.com/theopoc/pocketmark/issues/58)) ([b1c64c4](https://github.com/theopoc/pocketmark/commit/b1c64c4c06479595de24d053684cf3142b448281))


### Bug Fixes

* **web:** make importing visible in empty library ([#57](https://github.com/theopoc/pocketmark/issues/57)) ([f920b66](https://github.com/theopoc/pocketmark/commit/f920b66fd148e8753bf51ce2d0687eff4b66e97f))

## [1.0.0](https://github.com/theopoc/pocketmark/compare/v0.3.1...v1.0.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* **auth:** the legacy administrator bearer is no longer accepted; integrations must use named API keys.

### Features

* **auth:** remove administrator key ([#55](https://github.com/theopoc/pocketmark/issues/55)) ([e99792b](https://github.com/theopoc/pocketmark/commit/e99792b3728c191743306bff705e8fbff1d839ad))

## [0.3.1](https://github.com/theopoc/pocketmark/compare/v0.3.0...v0.3.1) (2026-10-27)


### Bug Fixes

* **ci:** prevent browser smoke rate limit exhaustion ([#53](https://github.com/theopoc/pocketmark/issues/53)) ([7466ead](https://github.com/theopoc/pocketmark/commit/7466ead3719e3e1a51243986b158fe870fa29c98))

## [0.3.0](https://github.com/theopoc/pocketmark/compare/v0.2.0...v0.3.0) (2026-10-27)


### Features

* add integrated capture viewer ([#42](https://github.com/theopoc/pocketmark/issues/42)) ([45f6517](https://github.com/theopoc/pocketmark/commit/45f6517f07ed84d1e2e1d24fce1cc562d8f7ea9a))
* **auth:** require TOTP for web sessions ([#52](https://github.com/theopoc/pocketmark/issues/52)) ([24f7b6b](https://github.com/theopoc/pocketmark/commit/24f7b6beb1f22ded26366842d1250fa60fd4c265))
* **extension:** confirm successful saves ([#46](https://github.com/theopoc/pocketmark/issues/46)) ([19ce3db](https://github.com/theopoc/pocketmark/commit/19ce3dbc46be39c8c97ed20586ef57db2cf386ff))
* **security:** scope API keys and manage browser sessions ([#51](https://github.com/theopoc/pocketmark/issues/51)) ([7e0851e](https://github.com/theopoc/pocketmark/commit/7e0851e66d27fc78d5b8328a52cb9d408eaf4d54))
* **server:** add per-client HTTP rate limits ([#48](https://github.com/theopoc/pocketmark/issues/48)) ([593bcf5](https://github.com/theopoc/pocketmark/commit/593bcf5b775a7c11d95ec9113e8db32e606318a7))


### Bug Fixes

* bound backups and index date sorting ([#50](https://github.com/theopoc/pocketmark/issues/50)) ([f568d7d](https://github.com/theopoc/pocketmark/commit/f568d7d68c5b53b62bf13df2e96936a7d7651b0f))
* **compose:** use published GHCR image ([#38](https://github.com/theopoc/pocketmark/issues/38)) ([1eef406](https://github.com/theopoc/pocketmark/commit/1eef406c6f30e6f291eaa50fa355709f749ba82c))
* **extension:** close popup after saving ([#47](https://github.com/theopoc/pocketmark/issues/47)) ([766a427](https://github.com/theopoc/pocketmark/commit/766a4273ee2545a9dfcbf292535e73e428617b91))
* **security:** close pre-deployment audit findings ([#45](https://github.com/theopoc/pocketmark/issues/45)) ([bd2e946](https://github.com/theopoc/pocketmark/commit/bd2e946bf4794b025ad6e60247612ceba7216f99))
* **security:** harden imports previews and backups ([#49](https://github.com/theopoc/pocketmark/issues/49)) ([d276803](https://github.com/theopoc/pocketmark/commit/d2768039bf772417bb0cbf718934744fe848ea32))

## [0.2.0](https://github.com/theopoc/pocketmark/compare/v0.1.0...v0.2.0) (2026-10-24)


### Features

* rename API keys in Settings ([#22](https://github.com/theopoc/pocketmark/issues/22)) ([1f28d5b](https://github.com/theopoc/pocketmark/commit/1f28d5b2bdefa281ac499365f12d5959551cb11b))


### Bug Fixes

* **ci:** handle releases without an open PR ([#25](https://github.com/theopoc/pocketmark/issues/25)) ([7b1e252](https://github.com/theopoc/pocketmark/commit/7b1e25277482392ed986b12c11aa7be6ccaff586))
* **compose:** add explicit healthcheck ([#26](https://github.com/theopoc/pocketmark/issues/26)) ([9ea82aa](https://github.com/theopoc/pocketmark/commit/9ea82aac8e81a0aeb5c542c2966c15d8bd09263f))

## 0.1.0 (2026-10-23)


### ⚠ BREAKING CHANGES

* /api/login no longer accepts tokens, and password sign-in cannot be disabled. Existing installations without a password must configure one through the administrative account API before signing in.
* remove the Linkwarden API adapter and separate advanced extension package. Use the personal Chrome extension or Floccus WebDAV; existing library data is retained.
* /api/login no longer accepts tokens, and password sign-in cannot be disabled. Existing installations without a password must configure one through the administrative account API before signing in.

### Features

* add API key status and activity controls ([#20](https://github.com/theopoc/pocketmark/issues/20)) ([75ce3a6](https://github.com/theopoc/pocketmark/commit/75ce3a649a09ab13b4149ded7e0dfe4c6768858b))
* add bounded observability ([#21](https://github.com/theopoc/pocketmark/issues/21)) ([d1aba23](https://github.com/theopoc/pocketmark/commit/d1aba232118b76fdd4cf55d435c5a2865ceca603))
* add native Chrome bookmark workflow ([#6](https://github.com/theopoc/pocketmark/issues/6)) ([da7ea4e](https://github.com/theopoc/pocketmark/commit/da7ea4e4ecbfba9ead9de96e6cacda3607320658))
* **api:** add embedded Swagger documentation ([#9](https://github.com/theopoc/pocketmark/issues/9)) ([f027912](https://github.com/theopoc/pocketmark/commit/f02791253c14860be12867cc0560c2a467544546))
* bootstrap Pocketmark with CI and releases ([d0eda83](https://github.com/theopoc/pocketmark/commit/d0eda83fe2c7b275c9f4c6201358579cf521424d))
* **extension:** refine popup layout and flows ([#7](https://github.com/theopoc/pocketmark/issues/7)) ([184c153](https://github.com/theopoc/pocketmark/commit/184c1535771204fe8a904984189b6dc84bf691d0))
* **tags:** add searchable alphabetical index ([407af76](https://github.com/theopoc/pocketmark/commit/407af762c32ca22ff4962b7bc04b4ed81cdc9a91))
* **tags:** add suggestions and wrapping chips ([a8e5fe4](https://github.com/theopoc/pocketmark/commit/a8e5fe4ebed87b2fff136ceb1a0ebee8c02196af))
* **ui:** add subtle state transitions ([a311f80](https://github.com/theopoc/pocketmark/commit/a311f80bd551ba4ab8da21bb7f1acb1b54676a40))
* **ui:** crossfade light and dark themes ([0905729](https://github.com/theopoc/pocketmark/commit/0905729a9f29e6b66ed919bd5460a5c2c09d6378))
* **ui:** improve navigation and editing flows ([29cd43a](https://github.com/theopoc/pocketmark/commit/29cd43a7c007648c984bc09dd4da72e769bc6929))
* **ui:** manage API keys in settings ([#18](https://github.com/theopoc/pocketmark/issues/18)) ([2fa06a0](https://github.com/theopoc/pocketmark/commit/2fa06a0e16cda02e9ab2f5882f53c070395bc0c4))
* **ui:** redesign workspace with dark mode ([d3bff63](https://github.com/theopoc/pocketmark/commit/d3bff6397e5c56ee97f101761e89dbb19c714066))


### Bug Fixes

* **capture:** accept large bounded HTML tokens ([#8](https://github.com/theopoc/pocketmark/issues/8)) ([55cb67c](https://github.com/theopoc/pocketmark/commit/55cb67c8f0d4d04cbd3045a808b8ccf898528783))
* **extension:** recover local capture storage ([#16](https://github.com/theopoc/pocketmark/issues/16)) ([81106ad](https://github.com/theopoc/pocketmark/commit/81106ad641ce613dc007b00200a9c21e509aec75))


### Documentation

* explain current browser integration setup ([#4](https://github.com/theopoc/pocketmark/issues/4)) ([f886433](https://github.com/theopoc/pocketmark/commit/f886433db94cfa83ae74260b4b2ebfe663f7f46d))


### Miscellaneous Chores

* prepare repository for public access ([#2](https://github.com/theopoc/pocketmark/issues/2)) ([8e1c778](https://github.com/theopoc/pocketmark/commit/8e1c778cbe8551096265ccf114ab492ef1539463))
