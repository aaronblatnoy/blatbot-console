"""Launches the REAL console backend from ~/blatbot/worktrees/sched2 (inkbox_claude.console
+ inkbox_claude.gate, including the real ScheduleService and cadence/schedprop/scopes
modules) against a throwaway temp-dir SQLite database, seeded with made-up schedules
through the store and ScheduleService -- not a stub.

Modeled on e2e/backend_launcher.py (the pattern already used for the People page): a
minimal stand-in "manager" (what routes.py calls `request.app["console.gateway"].sessions`)
carrying a real Store and a real ScheduleService bound to it, plus the handful of
seams ScheduleService calls into (_notice / execute). Nothing here sends anything
real: send_schedule_notice only appends to an in-memory list and writes the local
message row the real one also writes; there is no live gateway, no Telegram/SMS/email
client, no network egress beyond this loopback/tailnet listener.

Binds to 0.0.0.0 so it is reachable at both 127.0.0.1 (fails the real tailnet_gate ->
404, proving that gate is live) and this box's own Tailscale address (passes it, the
path the e2e frontend actually uses).
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict

BACKEND_REPO = Path(os.environ.get("E2E_SCHED_BACKEND_REPO", str(Path.home() / "blatbot/worktrees/sched2")))
sys.path.insert(0, str(BACKEND_REPO))

from aiohttp import web  # noqa: E402

from inkbox_claude.console import routes  # noqa: E402
from inkbox_claude.gate import schedules as sched_mod  # noqa: E402
from inkbox_claude.gate.store import Store  # noqa: E402


class FakeManager:
    """Enough of the real gate Manager for ScheduleService and the console API: a
    store, a bound ScheduleService, and the two seams ScheduleService calls into.
    Modeled directly on tests/test_console_schedules.py's FakeManager in the backend
    repo -- never the live Manager, never a real send."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.schedules = sched_mod.ScheduleService(self)
        self.notices: list = []

    async def send_schedule_notice(self, schedule, text: str) -> None:
        # Fake send: records the notice locally and writes the same message row the
        # real one would (so run history / message tagging still works), but never
        # reaches Telegram, SMS, email or any outbound channel.
        self.notices.append((schedule.id, text))
        self.store.add_message(
            schedule.origin_chat_id or "owner", "outbound", text,
            schedule.origin_mode or "console", role="notice", schedule_id=schedule.id,
        )

    async def execute(self, req) -> None:
        self.store.set_state(req.id, "running")


class FakeGateway:
    def __init__(self, manager: FakeManager) -> None:
        self.sessions = manager
        self.inkbox_directory_client = None
        self._console_started_at = time.time()
        self._public_url = ""
        self._tunnel = None


def _add_run(store: Store, schedule_id: int, *, started_at: float, outcome: str = "complete",
             result_line: str = "", final_status: str = "", denied=None, note: str = "",
             changed: bool = True, cost_usd: float = 0.01) -> int:
    run_id = store.create_schedule_run(schedule_id, None, started_at)
    store.finish_schedule_run(
        run_id, finished_at=started_at + 6, complete=(outcome == "complete"),
        outcome=outcome, result_line=result_line, final_status=final_status or result_line,
        denied=denied or [], note=note, changed=changed, cost_usd=cost_usd,
    )
    return run_id


def _seed(store: Store) -> None:
    """Made-up schedules covering every state asked for, seeded through the store
    directly (the same pattern tests/test_console_schedules.py uses), not through
    the stub. See the coordinator brief for the exact list; the one schedule whose
    prompt names a tool its scopes lack is seeded this way on purpose: propose()
    and edit() both reject creating or saving that combination (by design -- the
    service will not knowingly schedule something it cannot do), so the only way
    this state exists in the real system is a scope later revoked out from under an
    already-active schedule. The view layer (missing_capabilities) clearly supports
    rendering it, so it is a real state, just not one reachable via the create/edit
    API -- reported to the coordinator as a contract note, not a bug."""
    now = time.time()

    # 1. Active repeating: a finished run, then a newer run that could not finish
    # because a contacts-scope tool it needs was denied.
    task_id = store.create_task("Team total watch")["id"]
    s1 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Team total watch",
        prompt="Check the team page total and tell me when it changes.",
        kind="every", scopes=["web", "contacts"], timezone="America/New_York",
        report_mode="changed", cadence_kind="every", cadence={"minutes": 240},
        report_every_time=False, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s1.id, state="active", next_run=now + 3600 * 3 + 60 * 20)
    _add_run(store, s1.id, started_at=now - 7200, outcome="complete",
             result_line="Total went from $4,027.39 to $4,922.45, 5 new donors.",
             final_status="Checked the team page, compared to last note, found a change, "
                           "updated the tracker contact note, then closed out.",
             note="Last total was $4,922.45.")
    _add_run(store, s1.id, started_at=now - 1800, outcome="incomplete",
             result_line="The total did change again (+$200).",
             final_status=("Checked the team page, found a change, tried to update the tracker "
                            "contact note but that tool is not granted, so stopped there. ") * 60,
             denied=[{"tool": "mcp__inkbox__inkbox_update_contact", "reason": "scope"}],
             note="Change not yet written to the tracker.")

    # 2. Proposed, waiting on the owner's yes.
    task_id = store.create_task("Monday brief")["id"]
    store.create_schedule(
        chat_id="owner", task_id=task_id, title="Monday brief",
        prompt="Every weekday morning, summarize overnight email.",
        kind="weekdays", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="weekdays", cadence={"time": "07:30"},
        report_every_time=True, origin_mode="console", origin_chat_id="owner",
    )

    # 2b. A second proposed schedule, for the Reject check (kept separate from the
    # Approve one so each check leaves the other schedule alone).
    task_id = store.create_task("Friday wrap-up")["id"]
    store.create_schedule(
        chat_id="owner", task_id=task_id, title="Friday wrap-up",
        prompt="Every Friday afternoon, summarize the week.",
        kind="weekly", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="weekly", cadence={"day": "fri", "time": "16:00"},
        report_every_time=True, origin_mode="console", origin_chat_id="owner",
    )

    # 3. Paused, with a failed last run (for the Failed/red outcome state).
    task_id = store.create_task("Weekly backup check")["id"]
    s3 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Weekly backup check",
        prompt="Check the backup job log and tell me if it failed.",
        kind="weekly", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="weekly", cadence={"day": "mon", "time": "06:00"},
        report_every_time=True, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s3.id, state="paused", next_run=None)
    _add_run(store, s3.id, started_at=now - 86400 * 7, outcome="failed",
             result_line="Could not reach the backup page.",
             final_status="Tried three times to load the backup log page and gave up.")

    # 4. Ended one-time (reached naturally, not stopped by the owner -> "Ended").
    task_id = store.create_task("October invoice reminder")["id"]
    s4 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="October invoice reminder",
        prompt="Remind me to send the October invoice.",
        kind="once", scopes=[], timezone="America/New_York",
        report_mode="changed", cadence_kind="once", cadence={"at": "2026-10-01T09:00:00"},
        report_every_time=True, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s4.id, state="ended", next_run=None, last_outcome="its one run finished")
    _add_run(store, s4.id, started_at=now - 86400 * 11, outcome="complete",
             result_line="Reminded the owner to send the October invoice.",
             final_status="Sent the one-time reminder, then this schedule's STATUS was STOP.")

    # 5. Active, but its prompt names a tool outside its granted scopes -- see the
    # module docstring for why this is seeded directly rather than via propose().
    task_id = store.create_task("Donor tracker sync")["id"]
    s5 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Donor tracker sync",
        prompt="Check the donor page and use inkbox_update_contact to update the tracker note.",
        kind="every", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="every", cadence={"minutes": 60},
        report_every_time=False, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s5.id, state="active", next_run=now + 1800)


async def run(host: str, port: int, allowed_origins: str, db_path: str) -> None:
    os.environ["CONSOLE_ALLOWED_ORIGINS"] = allowed_origins
    store = Store(db_path)
    _seed(store)
    manager = FakeManager(store)
    gateway = FakeGateway(manager)

    app = web.Application()
    # get_avatar() otherwise reaches for request.app["console.gateway"].cfg to fetch
    # the real Inkbox identity's picture over the network -- pre-filling its module
    # cache (same trick e2e/backend_launcher.py uses) skips that path entirely, so
    # this harness never makes an outbound call for it and FakeGateway never needs a
    # fake `cfg` object with real-looking credentials.
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
    print(f"READY schedule-backend http://{host}:{port} (bound 0.0.0.0, origins={allowed_origins})", flush=True)
    while True:
        await asyncio.sleep(3600)


def main() -> None:
    host = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18825
    allowed_origins = sys.argv[3] if len(sys.argv) > 3 else ""
    db_path = sys.argv[4] if len(sys.argv) > 4 else "/tmp/e2e-sched2-real.db"
    asyncio.run(run(host, port, allowed_origins, db_path))


if __name__ == "__main__":
    main()
