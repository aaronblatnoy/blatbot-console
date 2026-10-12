"""Stub Schedules console API for the sched2 Schedules-page build.

The real backend (P6's package) does not exist yet, so this stub serves made-up
schedules in every state, shaped exactly like the "Console API contract" section of
SPEC.md, so the Schedules page (index.html / static/console.js / static/console.css)
can be built and checked against something real-shaped. Nothing here is the real
backend: no scopes.yaml, no store, no Claude Code session -- just enough JSON and
enough mutation bookkeeping to exercise every button and form path on the page.

Binds to 127.0.0.1 only, inside the 18800-18899 e2e port range.
"""

from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

CAPABILITY_OPTIONS = [
    {"scope": "web_read", "label": "read public web pages", "tools": ["web.fetch", "web.search"]},
    {"scope": "contacts_write", "label": "look up and edit contacts", "tools": ["contacts.lookup", "contacts.update"]},
    {"scope": "message_send", "label": "text you", "tools": ["message.send"]},
]
CAPABILITY_BY_SCOPE = {c["scope"]: c for c in CAPABILITY_OPTIONS}
CADENCE_KINDS = [
    {"kind": "once", "label": "Once", "fields": ["at"]},
    {"kind": "every", "label": "Every N minutes or hours", "fields": ["minutes"]},
    {"kind": "daily", "label": "Every day", "fields": ["time"]},
    {"kind": "weekdays", "label": "Weekdays", "fields": ["time"]},
    {"kind": "weekly", "label": "Weekly", "fields": ["day", "time"]},
    {"kind": "cron", "label": "Cron (advanced)", "fields": ["expr"]},
]
REPORT_OPTIONS = [
    {"value": "false", "label": "Only when something changed or it could not finish"},
    {"value": "true", "label": "Every time"},
]
WEEKDAYS = [
    {"value": "mon", "label": "Monday"}, {"value": "tue", "label": "Tuesday"},
    {"value": "wed", "label": "Wednesday"}, {"value": "thu", "label": "Thursday"},
    {"value": "fri", "label": "Friday"}, {"value": "sat", "label": "Saturday"},
    {"value": "sun", "label": "Sunday"},
]

STATE_LABELS = {"proposed": "Proposed", "active": "Active", "paused": "Paused", "ended": "Ended"}
OUTCOME_LABELS = {"complete": "Complete", "incomplete": "Incomplete", "failed": "Failed",
                   "interrupted": "Interrupted", "skipped": "Skipped"}


def now() -> float:
    return time.time()


def _capabilities_for(scopes):
    return [{"scope": s, "label": CAPABILITY_BY_SCOPE[s]["label"]} for s in scopes if s in CAPABILITY_BY_SCOPE]


class State:
    """Holds the made-up schedules and their runs; mutated by POST handlers."""

    def __init__(self):
        self.next_id = 1
        self.schedules = {}
        self.runs = {}  # schedule_id -> list of run dicts, newest first
        self._seed()

    def _new_id(self):
        sid = self.next_id
        self.next_id += 1
        return sid

    def _seed(self):
        t = now()

        # 1. Active, healthy, next run soon.
        sid = self._new_id()
        self.schedules[sid] = {
            "id": sid, "title": "Team total watch", "prompt": "Check the team page total and tell me when it changes.",
            "state": "active", "cadence_kind": "every", "cadence": {"minutes": 240}, "timezone": "America/New_York",
            "timezone_label": "Eastern", "report_every_time": False, "until": None,
            "capability_scopes": ["web_read", "contacts_write"], "missing_capability_scopes": [],
            "next_run": t + 3600 * 3 + 60 * 20, "needs_approval": False, "approval_request_id": None,
            "actions": ["pause", "run_now", "stop", "edit"],
        }
        self.runs[sid] = [{
            "id": self._new_id(), "started_at": t - 7200, "finished_at": t - 7190, "outcome": "complete",
            "result_line": "Total went from $4,027.39 to $4,922.45, 5 new donors.",
            "final_status": "Checked the team page, compared to last note, found a change, updated the tracker contact note, then closed out.",
            "denied": [], "note": "Last total was $4,922.45.", "changed": True, "cost_usd": 0.0132,
        }]

        # 2. Proposed, waiting on the owner's yes.
        sid = self._new_id()
        self.schedules[sid] = {
            "id": sid, "title": "Monday brief", "prompt": "Every weekday morning, summarize overnight email.",
            "state": "proposed", "cadence_kind": "weekdays", "cadence": {"time": "07:30"}, "timezone": "America/New_York",
            "timezone_label": "Eastern", "report_every_time": True, "until": None,
            "capability_scopes": ["web_read"], "missing_capability_scopes": [],
            "next_run": t + 86400, "needs_approval": True, "approval_request_id": 501,
            "actions": ["approve", "reject", "edit"],
        }
        self.runs[sid] = []

        # 3. Active but missing a capability it needs (incomplete last run).
        sid = self._new_id()
        self.schedules[sid] = {
            "id": sid, "title": "Donor tracker sync", "prompt": "Check the donor page and update the tracker contact note.",
            "state": "active", "cadence_kind": "every", "cadence": {"minutes": 60}, "timezone": "America/New_York",
            "timezone_label": "Eastern", "report_every_time": False, "until": None,
            "capability_scopes": ["web_read"], "missing_capability_scopes": ["contacts_write"],
            "next_run": t + 1800, "needs_approval": False, "approval_request_id": None,
            "actions": ["pause", "run_now", "stop", "edit"],
        }
        self.runs[sid] = [{
            "id": self._new_id(), "started_at": t - 1800, "finished_at": t - 1794, "outcome": "incomplete",
            "result_line": "The total did change (+$200).",
            "final_status": "Checked the donor page, found a change, tried to update the tracker contact note but that tool is not granted, so stopped there." + (" padding " * 400),
            "denied": [{"tool": "contacts.update", "scope": "contacts_write"}], "note": "Change not yet written to the tracker.",
            "changed": True, "cost_usd": 0.0081,
        }]

        # 4. Paused after repeated failures.
        sid = self._new_id()
        self.schedules[sid] = {
            "id": sid, "title": "Weekly backup check", "prompt": "Check the backup job log and tell me if it failed.",
            "state": "paused", "cadence_kind": "weekly", "cadence": {"day": "mon", "time": "06:00"},
            "timezone": "America/New_York", "timezone_label": "Eastern", "report_every_time": True, "until": None,
            "capability_scopes": ["web_read"], "missing_capability_scopes": [],
            "next_run": None, "needs_approval": False, "approval_request_id": None,
            "actions": ["start_again", "edit"],
        }
        self.runs[sid] = [{
            "id": self._new_id(), "started_at": t - 86400 * 7, "finished_at": t - 86400 * 7 + 30, "outcome": "failed",
            "result_line": "Could not reach the backup page.",
            "final_status": "Tried three times to load the backup log page and gave up.",
            "denied": [], "note": "", "changed": False, "cost_usd": 0.0041,
        }]

        # 5. Ended (stopped by the owner).
        sid = self._new_id()
        self.schedules[sid] = {
            "id": sid, "title": "October invoice reminder", "prompt": "Remind me to send the October invoice.",
            "state": "ended", "cadence_kind": "once", "cadence": {"at": "2026-10-01T09:00:00"},
            "timezone": "America/New_York", "timezone_label": "Eastern", "report_every_time": True, "until": None,
            "capability_scopes": [], "missing_capability_scopes": [],
            "next_run": None, "needs_approval": False, "approval_request_id": None,
            "actions": ["edit"],
        }
        self.runs[sid] = [{
            "id": self._new_id(), "started_at": t - 86400 * 11, "finished_at": t - 86400 * 11 + 12, "outcome": "complete",
            "result_line": "Reminded the owner to send the October invoice.",
            "final_status": "Sent the one-time reminder, then this schedule's STATUS was STOP.",
            "denied": [], "note": "", "changed": True, "cost_usd": 0.0019,
        }]

    def _started_text(self, ts):
        return time.strftime("%a %b %-d, %-I:%M %p EDT", time.localtime(ts))

    def _next_run_text(self, ts):
        if ts is None:
            return None
        return time.strftime("%a %b %-d, %-I:%M %p EDT", time.localtime(ts))

    def schedule_view(self, sid):
        s = self.schedules[sid]
        runs = self.runs.get(sid, [])
        last = None
        if runs:
            r = runs[0]
            last = {
                "started_at": r["started_at"], "started_text": self._started_text(r["started_at"]),
                "duration_seconds": r["finished_at"] - r["started_at"],
                "outcome": r["outcome"], "outcome_label": OUTCOME_LABELS[r["outcome"]],
                "result_line": r["result_line"],
                "denied": [{"tool": d["tool"], "label": CAPABILITY_BY_SCOPE.get(d.get("scope"), {}).get("label", d.get("scope", ""))} for d in r["denied"]],
            }
        next_run = s["next_run"]
        return {
            "id": s["id"], "title": s["title"], "prompt": s["prompt"], "state": s["state"],
            "state_label": STATE_LABELS[s["state"]],
            "cadence_kind": s["cadence_kind"], "cadence": s["cadence"], "cadence_text": describe_cadence(s),
            "timezone": s["timezone"], "timezone_label": s["timezone_label"],
            "next_run": next_run, "next_run_text": self._next_run_text(next_run),
            "next_run_in_seconds": (next_run - now()) if next_run else None,
            "report_every_time": s["report_every_time"],
            "report_text": "Every time" if s["report_every_time"] else "Only when something changed or it could not finish",
            "until": s["until"],
            "capabilities": _capabilities_for(s["capability_scopes"]),
            "missing_capabilities": _capabilities_for(s["missing_capability_scopes"]),
            "last_run": last, "needs_approval": s["needs_approval"], "approval_request_id": s["approval_request_id"],
            "actions": s["actions"],
        }

    def run_view(self, sid, run):
        return {
            "id": run["id"], "started_at": run["started_at"], "started_text": self._started_text(run["started_at"]),
            "duration_seconds": run["finished_at"] - run["started_at"],
            "outcome": run["outcome"], "outcome_label": OUTCOME_LABELS[run["outcome"]],
            "result_line": run["result_line"], "final_status": run["final_status"],
            "denied": [{"tool": d["tool"], "label": CAPABILITY_BY_SCOPE.get(d.get("scope"), {}).get("label", d.get("scope", ""))} for d in run["denied"]],
            "note": run["note"], "cost_usd": run["cost_usd"], "request_id": run["id"],
        }


def describe_cadence(s):
    kind, cadence = s["cadence_kind"], s["cadence"]
    if kind == "once":
        return f"Once, {cadence.get('at', '')}"
    if kind == "every":
        minutes = cadence.get("minutes", 0)
        if minutes % 60 == 0:
            hours = minutes // 60
            return f"every {hours} hour{'s' if hours != 1 else ''}"
        return f"every {minutes} minutes"
    if kind == "daily":
        return f"daily at {cadence.get('time', '')}"
    if kind == "weekdays":
        return f"weekdays at {cadence.get('time', '')}"
    if kind == "weekly":
        day = next((w["label"] for w in WEEKDAYS if w["value"] == cadence.get("day")), cadence.get("day", ""))
        return f"{day}s at {cadence.get('time', '')}"
    if kind == "cron":
        return f"cron {cadence.get('expr', '')}"
    return kind


STATE = State()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # The frontend's POSTs send Content-Type: application/json, which triggers a
        # CORS preflight from a browser since the two servers run on different ports.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        # The console's generic page chrome (nav badge, avatar, live-update stream)
        # calls these on every page load regardless of which page is active. They are
        # outside the Schedules contract, but stubbing them keeps the "no console
        # errors on any page" check honest instead of failing on unrelated 404s.
        if path == "/console/api/requests":
            self._json(200, [])
            return
        # Other pages (People, Roles, Scopes, Tasks, Health, Settings, Home) are not
        # part of this package, but the "no console errors" check still visits them;
        # the smallest made-up shape that satisfies each page's own render code,
        # nothing more -- these are not a real contract, just enough to not 404.
        if path == "/console/api/home":
            self._json(200, {"needs_you": {"count": 0, "oldest": None}, "right_now": {"running_count": 0, "running": [], "gateway_up": True, "tunnel_connected": True}, "recent_activity": [], "coming_up": {"schedules_paused": False, "next": []}})
            return
        if path == "/console/api/overview":
            self._json(200, {})
            return
        if path in ("/console/api/people", "/console/api/people/directory"):
            self._json(200, {"people": [], "unassigned": []})
            return
        if path == "/console/api/roles":
            self._json(200, [])
            return
        if path == "/console/api/scopes":
            self._json(200, [])
            return
        if path == "/console/api/scopes/breakdown":
            self._json(200, [])
            return
        if path == "/console/api/tasks":
            self._json(200, [])
            return
        if path == "/console/api/health":
            self._json(200, {"tunnel": "up", "uptime_s": 0, "last_restart": None, "interrupted": [], "errors": []})
            return
        if path == "/console/api/settings":
            self._json(200, [])
            return
        if path == "/console/api/avatar":
            body = b'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#030411"/></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/console/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path == "/console/api/schedules":
            schedules = [STATE.schedule_view(sid) for sid in STATE.schedules]
            self._json(200, {
                "schedules": schedules, "paused_all": False,
                "cadence_kinds": CADENCE_KINDS, "capability_options": CAPABILITY_OPTIONS,
                "report_options": REPORT_OPTIONS, "weekdays": WEEKDAYS,
            })
            return
        if path.startswith("/console/api/schedules/") and path.endswith("/runs"):
            sid = int(path.split("/")[-2])
            if sid not in STATE.schedules:
                self._json(404, {"error": "no such schedule"})
                return
            runs = [STATE.run_view(sid, r) for r in STATE.runs.get(sid, [])]
            self._json(200, {"runs": runs})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}

        if path == "/console/api/schedules":
            self._create_or_edit(body, creating=True)
            return
        if path == "/console/api/schedules/edit":
            self._create_or_edit(body, creating=False)
            return
        if path == "/console/api/schedules/action":
            self._action(body)
            return
        if path == "/console/api/schedules/approve":
            self._approve(body)
            return
        self._json(404, {"error": "not found"})

    def _create_or_edit(self, body, creating):
        scopes = [s for s in (body.get("scopes") or []) if s in CAPABILITY_BY_SCOPE]
        if creating:
            sid = STATE._new_id()
            STATE.schedules[sid] = {
                "id": sid, "title": body.get("title", ""), "prompt": body.get("prompt", ""),
                "state": "proposed", "cadence_kind": body.get("cadence_kind", "once"),
                "cadence": body.get("cadence") or {}, "timezone": body.get("timezone") or "America/New_York",
                "timezone_label": "Eastern", "report_every_time": bool(body.get("report_every_time")),
                "until": body.get("until"), "capability_scopes": scopes, "missing_capability_scopes": [],
                "next_run": now() + 3600, "needs_approval": True, "approval_request_id": sid + 1000,
                "actions": ["approve", "reject", "edit"],
            }
            STATE.runs[sid] = []
            self._json(200, {"schedule": STATE.schedule_view(sid), "applied": False, "needs_approval": True,
                              "message": "Set up. Reply yes to start."})
            return

        sid = body.get("id")
        if sid is None or int(sid) not in STATE.schedules:
            self._json(409, {"error": "no such schedule"})
            return
        sid = int(sid)
        s = STATE.schedules[sid]
        prompt_or_scopes_changed = (body.get("prompt") is not None and body.get("prompt") != s["prompt"]) or \
            (set(scopes) != set(s["capability_scopes"]))
        s["title"] = body.get("title", s["title"])
        s["prompt"] = body.get("prompt", s["prompt"])
        s["cadence_kind"] = body.get("cadence_kind", s["cadence_kind"])
        s["cadence"] = body.get("cadence") or s["cadence"]
        s["report_every_time"] = bool(body.get("report_every_time", s["report_every_time"]))
        s["until"] = body.get("until", s["until"])
        s["capability_scopes"] = scopes
        s["missing_capability_scopes"] = [m for m in s["missing_capability_scopes"] if m not in scopes]
        if prompt_or_scopes_changed:
            s["needs_approval"] = True
            s["approval_request_id"] = sid + 2000
            message = "Change needs your yes."
        else:
            message = "Applied."
        self._json(200, {"schedule": STATE.schedule_view(sid), "applied": not prompt_or_scopes_changed,
                          "needs_approval": s["needs_approval"], "message": message})

    def _action(self, body):
        sid = body.get("id")
        action = body.get("action")
        if sid is None or int(sid) not in STATE.schedules:
            self._json(404, {"error": "no such schedule"})
            return
        sid = int(sid)
        s = STATE.schedules[sid]
        if action not in s["actions"]:
            self._json(409, {"error": f'"{action}" is not available for this schedule right now.'})
            return
        if action == "pause":
            s["state"] = "paused"
            s["actions"] = ["start_again", "edit"]
        elif action == "resume" or action == "start_again":
            s["state"] = "active"
            s["actions"] = ["pause", "run_now", "stop", "edit"]
        elif action == "stop":
            s["state"] = "ended"
            s["actions"] = ["edit"]
        elif action == "run_now":
            pass  # made-up stub: no real run is launched
        self._json(200, {"schedule": STATE.schedule_view(sid), "message": f"{action} done."})

    def _approve(self, body):
        sid = body.get("id")
        approve = bool(body.get("approve"))
        if sid is None or int(sid) not in STATE.schedules:
            self._json(404, {"error": "no such schedule"})
            return
        sid = int(sid)
        s = STATE.schedules[sid]
        if not s["needs_approval"]:
            self._json(409, {"error": "nothing is waiting for approval on this schedule."})
            return
        s["needs_approval"] = False
        s["approval_request_id"] = None
        if approve:
            s["state"] = "active"
            s["actions"] = ["pause", "run_now", "stop", "edit"]
            message = "Started."
        else:
            s["state"] = "ended"
            s["actions"] = ["edit"]
            message = "Not started."
        self._json(200, {"schedule": STATE.schedule_view(sid), "message": message})


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18810
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"READY backend http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
