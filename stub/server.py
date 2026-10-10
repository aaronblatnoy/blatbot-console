#!/usr/bin/env python3
"""Stub API server for local frontend development. Serves made-up data in the exact
shapes the real /console/api/* endpoints return (see backend diff in
blatbot-console-restyle: inkbox_claude/console/api.py and routes.py), plus a
/console/events Server-Sent-Events stream that emits nothing but stays open. No
network calls, no real data, no dependency outside the Python standard library.

Run: python3 stub/server.py [port]   (default port 8792)
"""

from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8792
# STUB_EMPTY=1 serves the dashboard's empty case: nothing waiting, no schedules,
# never synced -- for a screenshot (or a manual look) of Home with no data to show.
EMPTY = os.getenv("STUB_EMPTY", "") not in ("", "0", "false", "False")

SCOPES = [
    {"name": "inkbox_read", "purpose": "read Blatbot's own mailbox, phone line and iMessage threads",
     "tools_count": 3, "group": "inkbox", "kind": "read"},
    {"name": "email_send", "purpose": "send email from the Inkbox mailbox and read that mailbox",
     "tools_count": 2, "group": "inkbox", "kind": "send"},
    {"name": "sms_send", "purpose": "send SMS from Blatbot's number and read its text threads",
     "tools_count": 2, "group": "inkbox", "kind": "send"},
    {"name": "tamid_drive_write", "purpose": "write to TAMID Google Sheets, Docs, Forms and Drive",
     "tools_count": 12, "group": "tamid", "kind": "write"},
    {"name": "tamid_drive_read", "purpose": "read TAMID Google Sheets, Docs, Forms and Drive",
     "tools_count": 12, "group": "tamid", "kind": "read"},
    {"name": "coolify_read", "purpose": "read Coolify applications, deployments and logs",
     "tools_count": 9, "group": "coolify", "kind": "read"},
]

ROLES = {
    "ops": {
        "name": "ops", "note": "day to day TAMID site changes", "scopes": ["tamid_drive_read", "tamid_drive_write"],
    },
    "comms": {
        "name": "comms", "note": "can send on Blatbot's behalf", "scopes": ["inkbox_read", "email_send", "sms_send"],
    },
}

TRUST = {
    "mia@example.edu": {"key": "mia@example.edu", "person": "Mia Chen", "role": "ops", "scopes": [], "note": "TAMID VP"},
    "+15551230000": {"key": "+15551230000", "person": "Theo Park", "role": "comms", "scopes": [], "note": "handles outbound coffee-chat replies"},
}

KNOWN_PEOPLE = {
    "mia@example.edu": {"person": "Mia Chen", "channels": ["email"], "last_seen": time.time() - 3600},
    "+15551230000": {"person": "Theo Park", "channels": ["sms", "imessage"], "last_seen": time.time() - 7200},
    "dana@example.com": {"person": "Dana Lee", "channels": ["email"], "last_seen": time.time() - 86400},
    "+15559990000": {"person": "", "channels": ["sms"], "last_seen": time.time() - 200000},
}

REQUESTS = [
    {"id": 1, "sender": "mia@example.edu", "sender_key": "mia@example.edu", "surface": "email",
     "summary": "Post the Fall recruitment flyer to Instagram", "scopes": ["ig_publish_post"],
     "original_message": "can you post this flyer", "result": "", "state": "pending",
     "subject": "flyer", "created_at": time.time() - 120, "updated_at": time.time() - 120, "revision": 0},
    {"id": 2, "sender": "+15551230000", "sender_key": "+15551230000", "surface": "sms",
     "summary": "Reply to the coffee chat thread", "scopes": ["sms_send"],
     "original_message": "reply to them", "result": "sent", "state": "done",
     "subject": "coffee chat", "created_at": time.time() - 9000, "updated_at": time.time() - 8990, "revision": 0},
]

TASKS = [
    {"id": 1, "title": "Fall recruitment flyer", "state": "open", "participants": ["mia@example.edu"]},
]

SCHEDULES = [
    {"id": 1, "title": "Dermacare daily report", "state": "active", "kind": "recurring",
     "cadence": "0 13 * * 1-5 America/New_York", "next_run": time.time() + 3600,
     "last_outcome": "sent in 6247s", "report_mode": "changed", "scopes": ["browser_read", "email_send"],
     "task_id": 1},
    {"id": 2, "title": "Follow up with Sean about the intro", "state": "paused", "kind": "once",
     "cadence": "once at 2026-10-10 09:00 America/New_York", "next_run": None,
     "last_outcome": "No runs yet.", "report_mode": "always", "scopes": ["sms_send"], "task_id": 1},
]
_schedules_paused = {"value": False}

SETTINGS = [
    {"name": "quiet_hours", "value": "22:00-07:00", "kind": "text", "source": "default"},
]

HEALTH = {
    "tunnel": {"connected": True, "url": "https://blatbot.inkboxwire.com", "mode": "configured"},
    "uptime_seconds": 54000, "last_restart": time.time() - 54000,
    "interrupted_runs": 0, "recent_errors": [],
}

_sync_state = {"at": None, "counts": {}}

if EMPTY:
    REQUESTS[:] = []
    SCHEDULES[:] = []
    KNOWN_PEOPLE.clear()
    TRUST.clear()
    ROLES.clear()
    _sync_state["at"] = None
    _sync_state["counts"] = {}


def home_model():
    pending = [r for r in REQUESTS if r["state"] == "pending"]
    oldest = min(pending, key=lambda r: r["created_at"], default=None)
    running = [r for r in REQUESTS if r["state"] == "running"]
    recent = sorted(REQUESTS, key=lambda r: -r["created_at"])[:8]
    people = people_model()
    roles_summary = [{"name": r["name"], "members": len([p for p in TRUST.values() if p["role"] == r["name"]])}
                      for r in ROLES.values()]
    now = time.time()
    upcoming = sorted(
        (s for s in SCHEDULES if s.get("next_run") and s["next_run"] >= now and s["state"] == "active"),
        key=lambda s: s["next_run"],
    )[:5]
    contacts = sorted((p for p in people if p.get("last_seen")), key=lambda p: -p["last_seen"])[:6]
    return {
        "needs_you": {
            "count": len(pending),
            "oldest": None if not oldest else {
                "id": oldest["id"], "sender": oldest["sender"], "surface": oldest["surface"],
                "summary": oldest["summary"], "state": oldest["state"],
                "created_at": oldest["created_at"], "updated_at": oldest["updated_at"],
            },
        },
        "right_now": {
            "running_count": len(running),
            "running": [{"id": r["id"], "sender": r["sender"], "surface": r["surface"], "summary": r["summary"],
                         "state": r["state"], "created_at": r["created_at"], "updated_at": r["updated_at"]}
                        for r in running[:5]],
            "gateway_up": True,
            "tunnel_connected": bool(HEALTH["tunnel"]["connected"]),
        },
        "recent_activity": [{"id": r["id"], "sender": r["sender"], "surface": r["surface"], "summary": r["summary"],
                              "state": r["state"], "created_at": r["created_at"], "updated_at": r["updated_at"]}
                             for r in recent],
        "coming_up": {
            "schedules_paused": _schedules_paused["value"],
            "next": [{"id": s["id"], "title": s["title"], "cadence": s["cadence"], "next_run": s["next_run"],
                      "state": s["state"]} for s in upcoming],
        },
        "people": {
            "total": len(people),
            "with_role": sum(1 for p in people if p.get("role")),
            "roles": roles_summary,
            "last_sync": {"at": _sync_state["at"], "counts": _sync_state["counts"], "failed": []},
        },
        "recent_contacts": [{"key": p["key"], "person": p.get("person") or p["key"],
                              "channels": p.get("channels") or [], "last_seen": p.get("last_seen") or 0}
                             for p in contacts],
    }


def _scope_kind(name):
    for s in SCOPES:
        if s["name"] == name:
            return s["kind"]
    return "write"


def role_model(row):
    scope_names = row["scopes"]
    details = [s for s in SCOPES if s["name"] in scope_names]
    read_scopes = [d for d in details if d["kind"] == "read"]
    write_scopes = [d for d in details if d["kind"] in ("write", "send")]
    has_send = any(d["kind"] == "send" for d in details)
    members = [{"key": r["key"], "person": r["person"] or r["key"]} for r in TRUST.values() if r["role"] == row["name"]]
    return {
        "name": row["name"], "note": row["note"], "scopes": scope_names,
        "read_scopes": read_scopes, "write_scopes": write_scopes,
        "members": members, "people_count": len(members),
        "warning": "People in this role can have Blatbot send messages without Aaron seeing them first." if has_send else "",
    }


def people_model():
    by_key = {}
    for key, row in KNOWN_PEOPLE.items():
        by_key[key] = {"key": key, "person": row["person"] or key, "role": "", "scopes": [], "note": "",
                       "channels": row["channels"], "last_seen": row["last_seen"]}
    for key, row in TRUST.items():
        merged = dict(by_key.get(key, {}))
        merged.update(row)
        by_key[key] = merged
    out = []
    for row in by_key.values():
        role_scopes = ROLES.get(row.get("role") or "", {}).get("scopes", [])
        effective = sorted(set(role_scopes) | set(row.get("scopes") or []))
        read = sum(1 for n in effective if _scope_kind(n) == "read")
        write = sum(1 for n in effective if _scope_kind(n) in ("write", "send"))
        row["effective_scopes"] = effective
        row["scope_counts"] = {"read": read, "write": write, "total": len(effective)}
        row["has_send"] = any(_scope_kind(n) == "send" for n in effective)
        out.append(row)
    return sorted(out, key=lambda r: ((r.get("person") or "").lower(), r["key"]))


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        if path == "/console/api/home":
            self._send(home_model())
        elif path == "/console/api/overview":
            waiting = [r for r in REQUESTS if r["state"] == "pending"]
            self._send({"counts": {"pending": len(waiting), "done": len(REQUESTS) - len(waiting)},
                        "health": HEALTH, "waiting": waiting})
        elif path == "/console/api/people":
            self._send({"people": people_model(), "count": len(people_model()), "last_sync": _sync_state})
        elif path == "/console/api/roles":
            self._send([role_model(r) for r in ROLES.values()])
        elif path == "/console/api/scopes":
            self._send(SCOPES)
        elif path == "/console/api/requests":
            state = (query.get("state") or [""])[0]
            rows = [r for r in REQUESTS if not state or r["state"] == state]
            self._send(rows)
        elif path == "/console/api/tasks":
            self._send(TASKS)
        elif path.startswith("/console/api/tasks/"):
            task_id = int(path.rsplit("/", 1)[-1])
            row = next((t for t in TASKS if t["id"] == task_id), None)
            if row is not None:
                # The real API returns the task with its recorded events, oldest first.
                row = dict(row, events=[
                    {"kind": "inbound", "chat_id": "stub-chat", "request_id": None,
                     "text": "can you post this flyer", "created_at": time.time() - 900},
                    {"kind": "request", "chat_id": "stub-chat", "request_id": 1,
                     "text": "Post the Fall recruitment flyer to Instagram [scopes: tamid_instagram_post]",
                     "created_at": time.time() - 880},
                ])
            self._send(row, 200 if row else 404)
        elif path == "/console/api/schedules":
            self._send({"schedules": SCHEDULES, "global_paused": _schedules_paused["value"]})
        elif path == "/console/api/health":
            self._send(HEALTH)
        elif path == "/console/api/settings":
            self._send(SETTINGS)
        elif path == "/console/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    time.sleep(15)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path
        body = self._body()
        if path == "/console/api/people/sync":
            _sync_state["at"] = time.time()
            _sync_state["counts"] = {"imessage": 2, "sms": 1, "email": 1, "call": 0, "contact": 0}
            self._send({"ok": True, "synced_at": _sync_state["at"], "people": len(people_model()), "counts": _sync_state["counts"]})
        elif path == "/console/api/people":
            key = body.get("key", "").strip()
            if not key:
                return self._send({"error": "key is required"}, 400)
            TRUST[key] = {"key": key, "person": body.get("person", ""), "role": body.get("role", ""),
                          "scopes": body.get("scopes", []), "note": body.get("note", "")}
            row = next(r for r in people_model() if r["key"] == key)
            self._send(row)
        elif path == "/console/api/people/delete":
            TRUST.pop(body.get("key", ""), None)
            self._send({"ok": True, "key": body.get("key", "")})
        elif path == "/console/api/roles":
            name = body.get("name", "").strip().lower()
            if not name:
                return self._send({"error": "name is required"}, 400)
            ROLES[name] = {"name": name, "scopes": body.get("scopes", []), "note": body.get("note", "")}
            self._send(role_model(ROLES[name]))
        elif path == "/console/api/roles/delete":
            ROLES.pop(body.get("name", ""), None)
            self._send({"ok": True, "name": body.get("name", "")})
        elif path == "/console/api/roles/members/add":
            name, key = body.get("name", ""), body.get("key", "")
            if name not in ROLES:
                return self._send({"error": f"no such role: {name}"}, 400)
            existing = TRUST.get(key, {"key": key, "person": key, "role": "", "scopes": [], "note": ""})
            existing["role"] = name
            TRUST[key] = existing
            self._send(role_model(ROLES[name]))
        elif path == "/console/api/roles/members/remove":
            name, key = body.get("name", ""), body.get("key", "")
            if key in TRUST and TRUST[key]["role"] == name:
                TRUST[key]["role"] = ""
            self._send(role_model(ROLES.get(name, {"name": name, "scopes": [], "note": ""})))
        elif path == "/console/api/schedules":
            new_id = max((s["id"] for s in SCHEDULES), default=0) + 1
            SCHEDULES.append({
                "id": new_id, "title": body.get("title", ""), "state": "pending_approval",
                "kind": body.get("kind", "once"), "cadence": body.get("cron") or body.get("run_at") or "once",
                "next_run": None, "last_outcome": "No runs yet.",
                "report_mode": body.get("report_mode", "always"), "scopes": body.get("scopes", []),
                "task_id": new_id,
            })
            self._send({"schedules": SCHEDULES, "global_paused": _schedules_paused["value"]})
        elif path == "/console/api/schedules/edit":
            row = next((s for s in SCHEDULES if s["id"] == body.get("id")), None)
            if row:
                row.update({"title": body.get("title", row["title"]), "kind": body.get("kind", row["kind"]),
                            "report_mode": body.get("report_mode", row["report_mode"]),
                            "scopes": body.get("scopes", row["scopes"])})
            self._send({"schedules": SCHEDULES, "global_paused": _schedules_paused["value"]})
        elif path == "/console/api/schedules/action":
            row = next((s for s in SCHEDULES if s["id"] == body.get("id")), None)
            action = body.get("action")
            if row and action == "pause":
                row["state"] = "paused"
            elif row and action == "resume":
                row["state"] = "active"
            elif row and action == "delete":
                SCHEDULES[:] = [s for s in SCHEDULES if s["id"] != row["id"]]
            self._send({"schedules": SCHEDULES, "global_paused": _schedules_paused["value"]})
        elif path == "/console/api/schedules/global":
            _schedules_paused["value"] = bool(body.get("paused"))
            self._send({"schedules": SCHEDULES, "global_paused": _schedules_paused["value"]})
        elif path == "/console/api/requests/decide":
            rid = body.get("id")
            row = next((r for r in REQUESTS if r["id"] == rid), None)
            if row:
                row["state"] = "approved" if body.get("decision") == "yes" else "rejected"
            self._send({"ok": bool(row), "state": row["state"] if row else None})
        elif path == "/console/api/settings":
            self._send({"ok": True, "settings": SETTINGS})
        else:
            self._send({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        pass


def main():
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"stub API listening on http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
