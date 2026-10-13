"""Launches the REAL console backend from ~/blatbot/worktrees/ux-p3 (the Builder P5
backend working copy: inkbox_claude.console + inkbox_claude.gate, the real
ScheduleService and cadence/schedprop/scopes modules) against a throwaway temp-dir
SQLite database, seeded with made-up schedules and requests through the store and
ScheduleService -- not a stub. Modeled directly on e2e/schedule_backend_launcher.py
in this repo; this is a separate copy (not an edit of that file) so it stays
disjoint from the Schedules-page builder's own e2e harness.

Binds to 0.0.0.0 so it is reachable at both 127.0.0.1 (fails the real tailnet_gate ->
404, proving that gate is live) and this box's own Tailscale address (the path the
e2e frontend actually uses). Nothing here sends anything real: send_schedule_notice
only appends to an in-memory list and writes the local message row the real one
also writes; there is no live gateway, no Telegram/SMS/email client, no network
egress beyond this loopback/tailnet listener.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

BACKEND_REPO = Path(os.environ.get("E2E_HOME_BACKEND_REPO", str(Path.home() / "blatbot/worktrees/ux-p3")))
sys.path.insert(0, str(BACKEND_REPO))

from aiohttp import web  # noqa: E402

from inkbox_claude.console import routes  # noqa: E402
from inkbox_claude.gate import schedules as sched_mod  # noqa: E402
from inkbox_claude.gate.store import Store  # noqa: E402


class FakeManager:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.schedules = sched_mod.ScheduleService(self)
        self.notices: list = []

    async def send_schedule_notice(self, schedule, text: str) -> None:
        self.notices.append((schedule.id, text))
        self.store.add_message(
            schedule.origin_chat_id or "owner", "outbound", text,
            schedule.origin_mode or "console", role="notice", schedule_id=schedule.id,
        )

    async def execute(self, req) -> None:
        self.store.set_state(req.id, "running")

    async def decide_request(self, request_id: int, decision: str, *, actor: str = "aaron",
                            source: str = "console", note: str = "") -> dict:
        """A minimal stand-in for Manager.decide_request, enough for the e2e click
        check (approve/decline a plain console request) without the gateway's
        notification/confirm machinery -- there is nothing real to notify here."""
        req = self.store.get_request(int(request_id))
        if req is None:
            return {"ok": False, "error": f"no request #{request_id}", "state": ""}
        if req.state != "pending":
            return {"ok": False, "error": f"#{req.id} is already {req.state}", "state": req.state}
        if self.schedules.is_proposal_request(req):
            return await self.schedules.decide_proposal(req, decision, note)
        d = (decision or "").strip().lower()
        if d in ("yes", "y", "ok", "approve"):
            self.store.set_state(req.id, "approved")
            return {"ok": True, "state": "approved", "error": ""}
        if d in ("no", "n", "decline", "reject"):
            self.store.set_state(req.id, "rejected")
            return {"ok": True, "state": "rejected", "error": ""}
        return {"ok": False, "error": f"unknown decision: {decision}", "state": req.state}


class FakeGateway:
    def __init__(self, manager: FakeManager) -> None:
        self.sessions = manager
        self.inkbox_directory_client = None
        self._console_started_at = time.time()
        self._public_url = ""
        self._tunnel = None


def _add_run(store: Store, schedule_id: int, *, started_at: float, outcome: str = "complete",
             result_line: str = "", final_status: str = "", denied=None, note: str = "",
             changed: bool = True, cost_usd: float = 0.01, finished_at=None) -> int:
    run_id = store.create_schedule_run(schedule_id, None, started_at)
    store.finish_schedule_run(
        run_id, finished_at=finished_at if finished_at is not None else started_at + 6,
        complete=(outcome == "complete"), outcome=outcome, result_line=result_line,
        final_status=final_status or result_line, denied=denied or [], note=note,
        changed=changed, cost_usd=cost_usd,
    )
    return run_id


def _seed(store: Store) -> None:
    """Made-up rows covering every Home row kind: a stuck paused schedule, a stuck
    active-but-incomplete schedule, a stuck schedule proposal, a stuck pending
    request, a stuck failed request, a running request, a running schedule, a
    done-today request and a done-today schedule run, and three upcoming firings."""
    now = time.time()

    # Stuck: paused with a reason (last run failed).
    task_id = store.create_task("Weekly backup check")["id"]
    s1 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Weekly backup check",
        prompt="Check the backup job log and tell me if it failed.",
        kind="weekly", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="weekly", cadence={"day": "mon", "time": "06:00"},
        report_every_time=True, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s1.id, state="paused", next_run=None,
                          last_outcome="it could not reach the backup page")
    _add_run(store, s1.id, started_at=now - 86400 * 2, outcome="failed",
             result_line="Could not reach the backup page.")

    # Stuck: active, but its last run came back incomplete (missing a capability).
    task_id = store.create_task("Donor tracker sync")["id"]
    s2 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Donor tracker sync",
        prompt="Check the donor page and use inkbox_update_contact to update the tracker note.",
        kind="every", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="every", cadence={"minutes": 240},
        report_every_time=False, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s2.id, state="active", next_run=now + 3600)
    _add_run(store, s2.id, started_at=now - 1800, outcome="incomplete",
             result_line="The total did change again (+$200).",
             denied=[{"tool": "mcp__inkbox__inkbox_update_contact", "reason": "scope"}])

    # Stuck: a schedule proposal waiting on the owner's yes.
    task_id = store.create_task("Monday brief")["id"]
    store.create_schedule(
        chat_id="owner", task_id=task_id, title="Monday brief",
        prompt="Every weekday morning, summarize overnight email.",
        kind="weekdays", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="weekdays", cadence={"time": "07:30"},
        report_every_time=True, origin_mode="console", origin_chat_id="owner",
    )

    # Running: a schedule with a run in flight.
    task_id = store.create_task("Team total watch")["id"]
    s3 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Team total watch",
        prompt="Check the team page total and tell me when it changes.",
        kind="every", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="every", cadence={"minutes": 240},
        report_every_time=False, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s3.id, state="active", next_run=now + 3600 * 3)
    running_sched_request = store.create_request(
        chat_id="owner", sender="owner", sender_name="Blatbot", mode="schedule",
        subject="", original_message="", summary="Checking the team total.",
        scopes=["web"], prompt="Check the team page.", state="running",
        task_id=task_id, schedule_id=s3.id,
    )

    # Stuck + done-today: a pending approval request and a failed request from
    # earlier today, plus one that finished cleanly (for Done today).
    task_id = store.create_task("Donor mailing approval")["id"]
    store.create_request(
        chat_id="owner", sender="jordan@example.test", sender_name="Jordan Avery",
        mode="console", subject="", original_message="Can you approve the donor mailing list?",
        summary="Approve the donor mailing list.", scopes=[], prompt="approve the mailing list",
        state="pending", task_id=task_id,
    )

    task_id = store.create_task("Vendor invoice wire")["id"]
    failed = store.create_request(
        chat_id="owner", sender="owner", sender_name="Owner", mode="console", subject="",
        original_message="Wire the vendor invoice.", summary="Wire the vendor invoice.",
        scopes=[], prompt="wire the vendor invoice", state="failed", task_id=task_id,
    )
    store.set_state(failed.id, "failed", status={"error": "the vendor portal timed out"})

    task_id = store.create_task("Draft the weekly memo")["id"]
    done = store.create_request(
        chat_id="owner", sender="owner", sender_name="Owner", mode="console", subject="",
        original_message="Draft the weekly memo.", summary="Draft the weekly memo.",
        scopes=[], prompt="draft the weekly memo", state="done", task_id=task_id,
    )
    store.set_state(done.id, "done", status={"summary": "Drafted the weekly memo and saved it."})

    # Done today: a schedule run that finished earlier today.
    task_id = store.create_task("Inbox triage")["id"]
    s4 = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Inbox triage",
        prompt="Sort overnight email into folders.",
        kind="daily", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="daily", cadence={"time": "08:00"},
        report_every_time=False, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s4.id, state="active", next_run=now + 86400)
    _add_run(store, s4.id, started_at=now - 3600, outcome="complete",
             result_line="Sorted 12 messages into 3 folders.", finished_at=now - 3500)

    # Realistic voice hand-off shapes (the coordinator's merged-backend pass): a
    # request whose summary and task title are the historical 90-char hard cut of
    # the whole call transcript, cut mid-word, with the real section headings and
    # "blatbot:"/"caller:" line prefixes; one failed with the exact JSON buffer-size
    # error string. Also a schedule whose own linked request fails (schedule_id
    # set, must never show up as a second, separate Stuck row) with a first-person
    # RESULT line from the run itself.
    phone = "+15557654321"
    transcript = "\n".join([
        f"Live phone call with {phone}. Blatbot's voice side has handed this off because the caller needs "
        "something done or looked up. The lines below are speech-recognition transcript, so expect misheard "
        "words, unfinished phrases and later corrections; trust the latest version of what they said.",
        "", "Earlier in the call (already handled, for context only):",
        "blatbot: Hi, this is Blatbot, Aaron's assistant.\ncaller: Hey, I had a question.",
        "", "What was just said (act on this):",
        "blatbot: What can I help with?\ncaller: I want to sign up for the pottery course on Saturday morning, "
        "and also ask whether the studio has parking nearby since I have never been before.\n"
        "blatbot: Let me check on that for you.",
        "", "Work out what the caller is asking for right now and handle it.",
    ])
    cut_summary = transcript[:90]
    task_id = store.create_task(cut_summary)["id"]
    store.create_request(
        chat_id="voice-pending", sender=phone, sender_name="", mode="voice", subject="",
        original_message=transcript, summary=cut_summary, scopes=[], prompt=cut_summary,
        state="pending", task_id=task_id,
    )
    task_id = store.create_task(cut_summary)["id"]
    buffer_failed = store.create_request(
        chat_id="voice-failed", sender=phone, sender_name="", mode="voice", subject="",
        original_message=transcript, summary=cut_summary, scopes=[], prompt=cut_summary,
        state="failed", task_id=task_id,
    )
    store.set_state(buffer_failed.id, "failed", status={
        "error": "Failed to decode JSON: JSON message exceeded maximum buffer size of 1048576 bytes.",
    })

    task_id = store.create_task("Pottery studio follow-up")["id"]
    s_voice = store.create_schedule(
        chat_id="owner", task_id=task_id, title="Pottery studio follow-up",
        prompt="Check back with the pottery studio about Saturday availability.",
        kind="daily", scopes=["web"], timezone="America/New_York",
        report_mode="changed", cadence_kind="daily", cadence={"time": "09:00"},
        report_every_time=False, origin_mode="console", origin_chat_id="owner",
    )
    store.update_schedule(s_voice.id, state="active", next_run=now + 1800)
    run_req = store.create_request(
        chat_id="owner", sender="owner", sender_name="Blatbot", mode="schedule", subject="",
        original_message="", summary="Checking the pottery studio.", scopes=["web"],
        prompt="check the pottery studio", state="failed", task_id=task_id, schedule_id=s_voice.id,
    )
    store.set_state(run_req.id, "failed", status={"error": "could not reach the studio's booking page"})
    _add_run(store, s_voice.id, started_at=now - 600, outcome="failed",
             result_line="I could not find a way to check Saturday availability on the studio's site.")

    # Coming up: three more active schedules with future next_run times.
    for i, title in enumerate(["Afternoon check-in", "Evening digest", "Weekend summary"]):
        task_id = store.create_task(title)["id"]
        s = store.create_schedule(
            chat_id="owner", task_id=task_id, title=title, prompt=f"{title} prompt.",
            kind="daily", scopes=["web"], timezone="America/New_York",
            report_mode="changed", cadence_kind="daily", cadence={"time": "18:00"},
            report_every_time=False, origin_mode="console", origin_chat_id="owner",
        )
        store.update_schedule(s.id, state="active", next_run=now + (i + 2) * 3600)


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
    print(f"READY home-backend http://{host}:{port} (bound 0.0.0.0, origins={allowed_origins})", flush=True)
    while True:
        await asyncio.sleep(3600)


def main() -> None:
    host = sys.argv[1] if len(sys.argv) > 1 else "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18840
    allowed_origins = sys.argv[3] if len(sys.argv) > 3 else ""
    db_path = sys.argv[4] if len(sys.argv) > 4 else "/tmp/e2e-home-real.db"
    asyncio.run(run(host, port, allowed_origins, db_path))


if __name__ == "__main__":
    main()
