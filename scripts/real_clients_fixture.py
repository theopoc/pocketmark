#!/usr/bin/env python3
"""Local-only rendered fixture and request logger for manual real-client tests.

Run against an isolated Pocketmark on 18092. Logs methods, paths, status and
non-secret JSON field names; never Authorization, passwords, tokens or values.
This is test infrastructure, not part of the application deployment.
"""
import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOG = Path('/private/tmp/pocketmark-real-clients/http-events.jsonl')
LOCK = threading.Lock()
PAGE = b'''<!doctype html><html><head><title>Pocketmark real client fixture</title>
<meta charset="utf-8"><style>body{font:20px system-ui;margin:40px;background:#fafbf6;color:#173c32}section{min-height:700px;padding:24px;border-top:4px solid #32765b}h1{font-size:40px}@media print{section{break-after:page;min-height:400px}}</style></head>
<body><h1>Pocketmark real client fixture</h1><p>Only synthetic public test content.</p>
<div id="rendered"></div><script>const p=document.createElement('p');p.textContent='JavaScript rendered marker: rendered-client-fixture-2026';document.querySelector('#rendered').append(p);for(let i=1;i<=5;i++){const s=document.createElement('section');s.innerHTML='<h2>Section '+i+'</h2><p>Client rendering test page '+i+'.</p>';document.body.append(s)}const b=document.createElement('p');b.textContent='BOTTOM MARKER: full-page-capture-complete';document.body.append(b);</script></body></html>'''

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)
    def log_message(self, *_):
        pass

class Proxy(BaseHTTPRequestHandler):
    def relay(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > 21 * 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('host', 'connection', 'accept-encoding')}
        headers['Host'] = '127.0.0.1:18094'
        conn = http.client.HTTPConnection('127.0.0.1', 18092, timeout=60)
        try:
            conn.request(self.command, self.path, body, headers)
            response = conn.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('connection', 'transfer-encoding'):
                    self.send_header(key, value)
            self.end_headers()
            event = {'method': self.command, 'path': self.path, 'status': response.status}
            if body and 'json' in self.headers.get('Content-Type', '') and not any(s in self.path for s in ('session', 'account', 'login', 'token')):
                try:
                    value = json.loads(body)
                    if isinstance(value, dict):
                        event['fields'] = sorted(value)
                except ValueError:
                    pass
            with LOCK, LOG.open('a') as log:
                log.write(json.dumps(event) + '\n')
            if self.command != 'HEAD':
                while block := response.read(65536):
                    self.wfile.write(block)
        finally:
            conn.close()
            self.close_connection = True
    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_HEAD = do_PROPFIND = do_MKCOL = do_MOVE = do_LOCK = do_UNLOCK = relay
    def log_message(self, *_):
        pass

if __name__ == '__main__':
    LOG.parent.mkdir(parents=True, exist_ok=True)
    fixture = ThreadingHTTPServer(('127.0.0.1', 18093), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    print('Synthetic page: http://127.0.0.1:18093/; logged Pocketmark: http://127.0.0.1:18094/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 18094), Proxy).serve_forever()
