"""Retake every page screenshot against the stub API, headlessly.

Starts stub/server.py and serve.py on their default ports, captures each page
at 1280 px and 400 px into screenshots/, checks that no page scrolls sideways
at 400 px, then stops both servers.

Run from the repo root with a Python that has Playwright installed:
    e2e/.venv/bin/python tools/screenshots.py
"""

from __future__ import annotations

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screenshots"
STUB_PORT, EMPTY_STUB_PORT, FRONT_PORT = 8792, 8794, 8793
PAGES = [("home", "/console/"), ("requests", "/console/requests"), ("roles", "/console/roles"),
         ("permissions", "/console/permissions"), ("tasks", "/console/tasks"),
         ("schedules", "/console/schedules"), ("health", "/console/health"), ("settings", "/console/settings")]
# The empty state (nothing waiting, no schedules, never synced) only needs to be seen
# on Home, so it is the only page captured against the empty stub.
EMPTY_PAGES = [("home-empty", "/console/")]
WIDTHS = [(1280, 900), (400, 860)]


def wait_for(url: str) -> None:
    for _ in range(50):
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"{url} did not come up")


def capture(front_port: int, pages, failures) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, height in WIDTHS:
            page = browser.new_page(viewport={"width": width, "height": height})
            for name, path in pages:
                page.goto(f"http://127.0.0.1:{front_port}{path}")
                page.wait_for_load_state("networkidle")
                page.wait_for_timeout(400)
                page.screenshot(path=str(SHOTS / f"{name}-{width}.png"), full_page=True)
                overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if overflow > 0:
                    failures.append(f"{name} at {width} px scrolls sideways by {overflow} px")
                print(f"captured {name}-{width}.png")
            page.close()
        browser.close()


def main() -> int:
    failures: list = []

    procs = [subprocess.Popen([sys.executable, str(ROOT / "stub" / "server.py"), str(STUB_PORT)], cwd=ROOT),
             subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(FRONT_PORT)], cwd=ROOT)]
    try:
        wait_for(f"http://127.0.0.1:{FRONT_PORT}/")
        wait_for(f"http://127.0.0.1:{STUB_PORT}/console/api/overview")
        capture(FRONT_PORT, PAGES, failures)
    finally:
        for proc in procs:
            proc.terminate()

    # A second pass against the stub's empty-data mode (STUB_EMPTY=1), on the same
    # frontend config, so Home's "nothing waiting, no schedules, never synced" state
    # gets its own screenshot instead of being inferred.
    import os
    empty_env = {**os.environ, "STUB_EMPTY": "1"}
    config_js = ROOT / "static" / "config.js"
    original_config = config_js.read_text() if config_js.exists() else None
    config_js.write_text(
        "window.CONSOLE_CONFIG = {\n"
        f"  apiBase: \"http://127.0.0.1:{EMPTY_STUB_PORT}/console/api\",\n"
        f"  eventsUrl: \"http://127.0.0.1:{EMPTY_STUB_PORT}/console/events\",\n"
        "};\n"
    )
    empty_procs = [
        subprocess.Popen([sys.executable, str(ROOT / "stub" / "server.py"), str(EMPTY_STUB_PORT)], cwd=ROOT, env=empty_env),
        subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(FRONT_PORT)], cwd=ROOT),
    ]
    try:
        wait_for(f"http://127.0.0.1:{FRONT_PORT}/")
        wait_for(f"http://127.0.0.1:{EMPTY_STUB_PORT}/console/api/overview")
        capture(FRONT_PORT, EMPTY_PAGES, failures)
    finally:
        for proc in empty_procs:
            proc.terminate()
        if original_config is None:
            config_js.unlink(missing_ok=True)
        else:
            config_js.write_text(original_config)

    for line in failures:
        print("FAIL:", line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
