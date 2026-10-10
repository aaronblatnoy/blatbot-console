#!/usr/bin/env python3
"""Tiny static server for the Blatbot console frontend. No build step, no framework,
no dependency outside the Python standard library.

Serves:
  /static/*          -> files under ./static
  everything else     -> index.html (the client-side router in console.js decides
                          what to render from the path), so a reload or a typed-in
                          URL for /console/roles works exactly like a click did.

This process never talks to the gateway. The frontend's config.js tells the browser
where the API lives; this server just hands out bytes.

Run: python3 serve.py [port]   (default 8793)
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8793

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/static/"):
            file_path = ROOT / path.lstrip("/")
        elif path == "/" or path.rstrip("/") == "":
            file_path = ROOT / "index.html"
        elif path.startswith("/console"):
            file_path = ROOT / "index.html"
        else:
            file_path = ROOT / "index.html"
        if not file_path.is_file() or ROOT not in file_path.resolve().parents:
            self.send_response(404)
            self.end_headers()
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(file_path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def main():
    import os
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    # BIND_HOST defaults to loopback for local dev. The systemd unit sets it to the
    # box's Tailscale address so the frontend, like the backend, is reachable only
    # over the tailnet -- never 0.0.0.0.
    host = os.getenv("BIND_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"blatbot-console frontend listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
