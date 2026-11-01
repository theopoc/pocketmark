#!/usr/bin/env python3
"""Bind the audited npm inventory to the actual shipped Swagger UI bytes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'internal/webui/static/api-docs/vendor'
PACKAGE = ROOT / 'tools/security/node_modules/swagger-ui-dist'
for name in ('swagger-ui-bundle.js', 'swagger-ui.css', 'swagger-ui-bundle.js.LICENSE.txt', 'LICENSE', 'NOTICE'):
    if (VENDOR / name).read_bytes() != (PACKAGE / name).read_bytes():
        raise SystemExit(f'{name}: vendored Swagger UI differs from the audited package; update both together')
print('Vendored Swagger UI matches the audited npm package.')
