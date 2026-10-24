# Changelog

## [0.2.1](https://github.com/theopoc/pocketmark/compare/v0.2.0...v0.2.1) (2026-10-24)


### Bug Fixes

* **compose:** use published GHCR image ([#38](https://github.com/theopoc/pocketmark/issues/38)) ([1eef406](https://github.com/theopoc/pocketmark/commit/1eef406c6f30e6f291eaa50fa355709f749ba82c))

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
