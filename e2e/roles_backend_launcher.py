"""Launches the REAL console backend from ~/blatbot/worktrees/ux-roles (the Builder's
backend working copy: inkbox_claude.console + inkbox_claude.gate, the real roles-summary
API) against a throwaway temp-dir SQLite database, seeded with made-up roles, people and
contacts through the real Store -- not a stub. Modeled on e2e/home_backend_launcher.py in
this repo; a separate copy so it stays disjoint from the Home-page builder's own harness.

Binds to 0.0.0.0 so it is reachable at both 127.0.0.1 (fails the real tailnet_gate -> 404,
proving that gate is live) and this box's own Tailscale address (the path the e2e frontend
actually uses). Nothing here sends anything real: there is no live gateway, no Telegram/
SMS/email client, no network egress beyond this loopback/tailnet listener. Every name,
phone number and role below is made up for this test only.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

BACKEND_REPO = Path(os.environ.get("E2E_ROLES_BACKEND_REPO", str(Path.home() / "blatbot/worktrees/ux-roles")))
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
    """Made-up roles and people covering every case the Roles-page e2e check exercises:
    a plain read-level system, a send scope (with its warning), a 'custom' level (one
    half of a read/change pair held without the other), and a notes grant -- plus two
    people holding those roles so the who-can search and member lists have something to
    find. The 'commander' built-in role is created automatically by Store.__init__ and is
    left with zero members here (no approver handles are configured in this harness)."""
    store.set_role(
        "assistant",
        ["inbox_read", "email_send", "vault_read"],
        note="Reads Blatbot's own inbox and can send email; reads every note.",
    )
    store.set_role(
        "organizer",
        ["tamid_drive_write"],
        note="Updates the TAMID workspace (custom grant: write without the read scope).",
    )
    store.set_role(
        "archivist",
        ["tamid_site_read"],
        note="Reads one of two club-website admins (custom grant: one read scope of a pair).",
    )

    jordan = store.create_person(display="Jordan Avery", role="assistant",
                                  scopes=[], note="Made-up fixture person for e2e.")
    store.set_trust("+15550001111", person="Jordan Avery", role="assistant", scopes=[])

    riley = store.create_person(display="Riley Chen", role="organizer",
                                 scopes=[], note="Made-up fixture person for e2e.")
    store.set_trust("riley@example.test", person="Riley Chen", role="organizer", scopes=[])

    store.create_person(display="Sam Okafor", role="", scopes=[], note="No roles yet.")

    store.create_person(display="Morgan Ellis", role="archivist", scopes=[], note="Made-up fixture person for e2e.")
    store.set_trust("morgan@example.test", person="Morgan Ellis", role="archivist", scopes=[])


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
    print(f"READY roles-backend http://{host}:{port} (bound 0.0.0.0, origins={allowed_origins})", flush=True)
    while True:
        await asyncio.sleep(3600)


def main() -> None:
    host = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18860
    allowed_origins = sys.argv[3] if len(sys.argv) > 3 else ""
    db_path = sys.argv[4] if len(sys.argv) > 4 else "/tmp/e2e-roles-real.db"
    asyncio.run(run(host, port, allowed_origins, db_path))


if __name__ == "__main__":
    main()
