"""Launches a real console backend for the e2e check.

Imports the ACTUAL console package from ~/blatbot-console-restyle (inkbox_claude.console
and inkbox_claude.gate) and mounts its real routes via routes.register(app, gateway) --
no bypass, no test switch added to that package. The gate/tailnet/cors checks in
access.py run exactly as they do in production; this script only supplies a throwaway
Store (temp-dir sqlite file) and a minimal stand-in "gateway" object with the handful of
attributes routes.py/api.py read (`sessions.store`, `sessions.decide_request`,
`_console_started_at`, `_public_url`, `_tunnel`, `inkbox_directory_client`).

Binds to 0.0.0.0 on a fixed port so the SAME listener is reachable both at this box's
Tailscale address (exercising the real tailnet_gate allow path) and at 127.0.0.1
(exercising the real tailnet_gate deny path -> 404), without weakening access.py at all.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

BACKEND_REPO = Path(os.environ.get("E2E_BACKEND_REPO", str(Path.home() / "blatbot-integration")))
sys.path.insert(0, str(BACKEND_REPO))

from aiohttp import web  # noqa: E402

from inkbox_claude.console import routes  # noqa: E402
from inkbox_claude.gate.schedules import ScheduleService  # noqa: E402
from inkbox_claude.gate.store import Store  # noqa: E402


class FakeDirectoryClient:
    """Implements the InkboxDirectoryClient protocol (sync.py) with made-up people
    across several channels. Never touches the real Inkbox API."""

    def imessage_conversations(self) -> Iterable[Dict[str, Any]]:
        return [
            {"handle": "+15550001111", "name": "Priya Nair", "last_seen": time.time() - 3600},
            {"handle": "+15550002222", "name": "Marcus Webb", "last_seen": time.time() - 86400},
        ]

    def sms_threads(self) -> Iterable[Dict[str, Any]]:
        return [
            {"handle": "+15550003333", "name": "Dana Ruiz", "last_seen": time.time() - 7200},
        ]

    def email_threads(self) -> Iterable[Dict[str, Any]]:
        return [
            {"handle": "jordan.kim@example.com", "name": "Jordan Kim", "last_seen": time.time() - 1800},
            {"handle": "sofia.alvarez@example.org", "name": "Sofia Alvarez", "last_seen": time.time() - 500000},
        ]

    def calls(self) -> Iterable[Dict[str, Any]]:
        return [
            {"handle": "+15550004444", "name": "", "last_seen": time.time() - 10000},
        ]

    def contacts(self) -> Iterable[Dict[str, Any]]:
        return [
            {"handle": "liam.oconnor@example.net", "name": "Liam O'Connor", "last_seen": time.time() - 200000},
        ]


class FakeSessionManager:
    """Minimal stand-in for GateSessionManager: the console only ever reaches it
    through `.store` and `.decide_request`. Mirrors the real decision state machine
    just enough to exercise the API (pending -> approved/rejected), without running
    any actual Claude Code work."""

    def __init__(self, store: Store) -> None:
        self.store = store

    async def decide_request(self, request_id: int, decision: str, *, actor: str = "aaron",
                              source: str = "console", note: str = "") -> Dict[str, Any]:
        req = self.store.get_request(int(request_id))
        if req is None:
            return {"ok": False, "error": f"no request #{request_id}", "state": ""}
        if req.state != "pending":
            return {"ok": False, "error": f"#{req.id} is already {req.state}", "state": req.state}
        d = (decision or "").strip().lower()
        if d == "yes":
            self.store.set_state(req.id, "approved")
            return {"ok": True, "state": "approved", "error": ""}
        if d == "no":
            self.store.set_state(req.id, "rejected")
            return {"ok": True, "state": "rejected", "error": ""}
        if d == "edit":
            if not note.strip():
                return {"ok": False, "error": "an edit needs instructions", "state": req.state}
            self.store.revise_prompt(req.id, f"{req.prompt}\n\n--- NOTE ---\n{note.strip()}")
            return {"ok": True, "state": "pending", "error": ""}
        return {"ok": False, "error": f"unknown decision {decision!r}", "state": req.state}

    async def send_to_approver(self, text: str) -> None:
        """ScheduleService.propose()/edit() tells Aaron a schedule needs a decision.
        No real send in this harness -- the api.create_schedule/edit_schedule path
        under test only needs this to exist and not raise."""
        return None


class FakeGateway:
    """The handful of attributes routes.py/api.py read off `request.app["console.gateway"]`."""

    def __init__(self, store: Store) -> None:
        self.sessions = FakeSessionManager(store)
        # api.create_schedule/edit_schedule/schedule_action read manager.schedules off the
        # same object routes.py calls `_manager(request)` -- which is request.app's
        # console.gateway.sessions -- so the ScheduleService has to hang off `.sessions`,
        # not off the gateway itself.
        self.sessions.schedules = ScheduleService(self.sessions)
        self.inkbox_directory_client = FakeDirectoryClient()
        self._console_started_at = time.time()
        self._public_url = ""  # no public tunnel in this harness
        self._tunnel = None


def _seed(store: Store) -> None:
    """Made-up roles, people, requests, and tasks so every console page has content."""
    store.set_role("ops", ["inbox_read", "email_send"], note="Day-to-day operations")
    store.set_role("read-only", ["inbox_read"], note="Can see, cannot act")

    store.set_trust("priya.nair@example.com", person="Priya Nair", role="ops",
                     scopes=[], note="Ops lead")
    store.set_trust("+15550002222", person="Marcus Webb", role="read-only",
                     scopes=[], note="")
    store.set_trust("dana.ruiz@example.com", person="Dana Ruiz", role="",
                     scopes=["inbox_read"], note="Scoped directly, no role")

    task = store.create_task("Investigate email bounce", participants=["priya.nair@example.com"])
    task_id = task["id"]
    store.task_event(task_id, "note", "Created by e2e seed data", chat_id="seed-chat")

    store.create_request(
        chat_id="seed-chat-1", sender="priya.nair@example.com", sender_name="Priya Nair",
        mode="email", subject="Resend the October invoice",
        original_message="Can you resend the October invoice to billing@example.com?",
        summary="Resend October invoice to billing@example.com", scopes=["email_send"],
        prompt="Resend the October invoice to billing@example.com", state="pending",
        task_id=task_id,
    )
    store.create_request(
        chat_id="seed-chat-2", sender="+15550002222", sender_name="Marcus Webb",
        mode="sms", subject="Check order status",
        original_message="What's the status of order #4821?",
        summary="Look up order #4821 status", scopes=["inbox_read"],
        prompt="Look up order #4821 status", state="done",
        task_id=task_id,
    )

    store.set_setting("GATE_CONFIRM_SENDS", "true")


async def run(host: str, port: int, allowed_origins: str, db_path: str) -> None:
    os.environ["CONSOLE_ALLOWED_ORIGINS"] = allowed_origins
    store = Store(db_path)
    _seed(store)
    gateway = FakeGateway(store)

    app = web.Application()
    routes.register(app, gateway)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    print(f"READY backend http://{host}:{port} (bound 0.0.0.0, origins={allowed_origins})", flush=True)
    while True:
        await asyncio.sleep(3600)


def main() -> None:
    host = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8781
    allowed_origins = sys.argv[3] if len(sys.argv) > 3 else ""
    db_path = sys.argv[4] if len(sys.argv) > 4 else "/tmp/e2e-console.db"
    asyncio.run(run(host, port, allowed_origins, db_path))


if __name__ == "__main__":
    main()
