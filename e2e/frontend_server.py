"""Serves the REAL frontend (~/blatbot-console: index.html + static/) from its own
port, with one override: /static/config.js is generated on the fly to point at this
run's backend, instead of editing the tracked static/config.js file.

This duplicates serve.py's tiny routing (any /console/* path -> index.html, /static/*
-> the static dir) rather than importing or modifying serve.py, since serve.py is off
limits to edit and isn't structured to take a config override as a parameter.
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FRONTEND_ROOT = Path(__file__).resolve().parent.parent  # ~/blatbot-console

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
}


def make_handler(config_js: bytes):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/static/config.js":
                data = config_js
                self._send(200, data, "application/javascript")
                return
            if path.startswith("/static/"):
                file_path = FRONTEND_ROOT / path.lstrip("/")
            else:
                file_path = FRONTEND_ROOT / "index.html"
            if not file_path.is_file() or FRONTEND_ROOT not in file_path.resolve().parents:
                self._send(404, b"not found", "text/plain")
                return
            data = file_path.read_bytes()
            self._send(200, data, CONTENT_TYPES.get(file_path.suffix, "application/octet-stream"))

        def _send(self, status: int, data: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            pass

    return Handler


def main() -> None:
    host = sys.argv[1]
    port = int(sys.argv[2])
    api_base = sys.argv[3]
    events_url = sys.argv[4]
    config_js = (
        "window.CONSOLE_CONFIG = {\n"
        f"  apiBase: {api_base!r},\n"
        f"  eventsUrl: {events_url!r},\n"
        "};\n"
    ).encode("utf-8")
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((host, port), make_handler(config_js))
    print(f"READY frontend http://{host}:{port} -> api {api_base}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
