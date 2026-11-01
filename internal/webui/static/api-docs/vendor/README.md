# Swagger UI static assets

Vendored from the official `swagger-ui-dist` npm package, version **5.34.1**.
Only the browser bundle, stylesheet and associated license/notice files ship.
No package manager, CDN, build step or additional process is needed at runtime.
The application shell does not load these assets; only `/api-docs/` does.

- Source: https://github.com/swagger-api/swagger-ui/tree/v5.34.1
- Package: https://registry.npmjs.org/swagger-ui-dist/-/swagger-ui-dist-5.34.1.tgz
- Package integrity: `sha512-VSr8fXfI93obYaQicLJbLUKGRxDojj/SfRJDDLCioGTUBj4BK/Nj4eE9jCeCAnJxVLi7iS+08PbiZLyrQKBkJQ==`
- License: Apache-2.0; retain `LICENSE`, `NOTICE` and the bundle's dependency license file.

To update, download a specific official package version, verify its registry
integrity, and replace these five upstream files without modification. Update
this provenance and the checksums below. Keep external validation and URL-based
configuration disabled in `../docs.js`. Verify both themes, mobile layouts,
authorization and a same-origin request under the existing strict CSP.

SHA-256 checksums for the unmodified upstream files:

```
36eeb4d5640b9c036b1d0f854499af1cceebbdb260b790a03a18be5e8488fbf5  swagger-ui-bundle.js
c3cfe8248c4b0b89673600fb829924eafbac6de4bc4b2b06f5f5243483074d0a  swagger-ui.css
37eb6e7e59aed57b2c1acf076574b818ea07b74265717e0bd67b59e0baf9abbb  swagger-ui-bundle.js.LICENSE.txt
cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  LICENSE
0d20d1adef18aee3f40dd258172155521ce702ac445cb5f7b7d60ed32dad2fb2  NOTICE
```

The CI inventory in `tools/security/package-lock.json` must be updated together
with these bytes. `scripts/check_swagger_vendor.py` verifies equality against the
audited npm package; Retire.js also scans the actual bundle for embedded libraries.
