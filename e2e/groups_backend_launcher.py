"""Launches the REAL console backend from ~/blatbot/app (the live app code, not a
worktree -- the per-chat response-mode feature was built directly there) against a
throwaway temp-dir SQLite database, seeded with made-up group chats through the real
Store -- not a stub. Modeled on e2e/roles_backend_launcher.py in this repo.

Binds to 0.0.0.0 so it is reachable at both 127.0.0.1 (fails the real tailnet_gate ->
404, proving that gate is live) and this box's own Tailscale address (the path the
e2e frontend actually uses). Nothing here sends anything real: there is no live
gateway, no Telegram/SMS/email client, no network egress beyond this loopback/tailnet
listener. Every chat name and member below is made up for this test only.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

BACKEND_REPO = Path(os.environ.get("E2E_GROUPS_BACKEND_REPO", str(Path.home() / "blatbot/app")))
sys.path.insert(0, str(BACKEND_REPO))

from aiohttp import web  # noqa: E402

from inkbox_claude.console import routes  # noqa: E402
from inkbox_claude.gate.store import Store  # noqa: E402


class FakeManager:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.notices: list = []

    async def send_schedule_notice(self, schedule, text: str) -> None:
        self.notices.append((schedule.id, text))

    async def execute(self, req) -> None:
        self.store.set_state(req.id, "running")

    async def decide_request(self, request_id: int, decision: str, *, actor: str = "aaron",
                            source: str = "console", note: str = "") -> dict:
        return {"ok": False, "error": "not used in this harness", "state": ""}


class FakeGateway:
    def __init__(self, manager: FakeManager) -> None:
        self.sessions = manager
        self.inkbox_directory_client = None
        self._console_started_at = time.time()
        self._public_url = ""
        self._tunnel = None


def _seed(store: Store) -> None:
    """Three made-up group chats covering the three modes, plus messages so the
    member count is non-trivial: a Telegram group left at the default (mention,
    never explicitly set), one explicitly natural, one explicitly silent."""
    store.set_thread("tg:-900001", "idle", "telegram",
                     {"conversation_kind": "group", "group_title": "E2E Fixture Chat"})
    store.add_message("tg:-900001", "inbound",
                      "[telegram group: E2E Fixture Chat | from: Jordan Avery | your reply goes to the whole group]\nhi",
                      "telegram")
    store.add_message("tg:-900001", "inbound", "Riley Chen: overheard line", "telegram")

    store.set_thread("tg:-900002", "idle", "telegram",
                     {"conversation_kind": "group", "group_title": "E2E Natural Chat"})
    store.set_response_mode("tg:-900002", "natural")

    store.set_thread("imsg:e2e-900003", "idle", "imessage",
                     {"conversation_kind": "group"})
    store.set_response_mode("imsg:e2e-900003", "silent")


async def run(host: str, port: int, allowed_origins: str, db_path: str) -> None:
    os.environ["CONSOLE_ALLOWED_ORIGINS"] = allowed_origins
    store = Store(db_path)
    _seed(store)
    manager = FakeManager(store)
    gateway = FakeGateway(manager)

    app = web.Application()
    routes._avatar_cache.update(
        at=time.time(),
        body=b'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
             b'<rect width="64" height="64" fill="#030411"/></svg>',
        type="image/svg+xml",
    )
    routes.register(app, gateway)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    print(f"READY groups-backend http://{host}:{port} (bound 0.0.0.0, origins={allowed_origins})", flush=True)
    while True:
        await asyncio.sleep(3600)


def main() -> None:
    host = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18870
    allowed_origins = sys.argv[3] if len(sys.argv) > 3 else ""
    db_path = sys.argv[4] if len(sys.argv) > 4 else "/tmp/e2e-groups-real.db"
    asyncio.run(run(host, port, allowed_origins, db_path))


if __name__ == "__main__":
    main()
