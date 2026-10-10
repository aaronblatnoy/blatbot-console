"""Headless Playwright checks against the real console frontend + real backend
console routes. Prints one PASS/FAIL line per assertion; exits non-zero on any FAIL.
Never opens/foregrounds a browser window (headless only).
"""

from __future__ import annotations

import sys
import time
from typing import List, Tuple

from playwright.sync_api import sync_playwright

FRONTEND_ORIGIN = sys.argv[1]           # e.g. http://127.0.0.1:8793
BACKEND_TAILNET_BASE = sys.argv[2]      # e.g. http://100.112.46.2:8781
BACKEND_LOOPBACK_BASE = sys.argv[3]     # e.g. http://127.0.0.1:8781

PAGES = [
    ("Home", "/console/", "#home-title"),
    ("Requests", "/console/requests", "#requests-title"),
    ("Permissions", "/console/permissions", "#permissions-title"),
    ("Roles", "/console/roles", "#roles-title"),
    ("Tasks", "/console/tasks", "#tasks-title"),
    ("Schedules", "/console/schedules", "#schedules-title"),
    ("Health", "/console/health", "#health-title"),
    ("Settings", "/console/settings", "#settings-title"),
]

results: List[Tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" -- {detail}" if detail and not ok else ""))


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("dialog", lambda d: d.accept())

        console_errors: List[str] = []
        failed_requests: List[str] = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("requestfailed", lambda req: failed_requests.append(f"{req.method} {req.url}"))
        page.on("response", lambda resp: failed_requests.append(f"{resp.request.method} {resp.url} -> {resp.status}")
                if resp.status >= 400 and "/console/api/" in resp.url else None)

        # -- 1. every page loads with data, no console errors, no failed requests --
        for name, path, heading_selector in PAGES:
            console_errors.clear()
            failed_requests.clear()
            page.goto(f"{FRONTEND_ORIGIN}{path}", wait_until="networkidle")
            page.wait_for_selector(heading_selector, timeout=5000)
            time.sleep(0.3)  # let any trailing async render settle
            has_content = page.evaluate(
                """() => {
                    const main = document.querySelector('#main');
                    return main && main.textContent.trim().length > 40
                        && !main.textContent.includes('Loading');
                }"""
            )
            ok = has_content and not console_errors and not failed_requests
            detail = f"content={has_content} console_errors={console_errors} failed_requests={failed_requests}"
            record(f"page loads with data, no errors: {name}", ok, detail)

        # -- 1b. the needs-you block links to the waiting request --
        page.goto(f"{FRONTEND_ORIGIN}/console/", wait_until="networkidle")
        page.wait_for_selector("#home-content .home-needs-you", timeout=5000)
        needs_you_link = page.locator("#home-content .home-needs-you a")
        try:
            href = needs_you_link.get_attribute("href", timeout=2000)
            has_link = bool(href) and href.endswith("/console/requests")
        except Exception:
            has_link = False
        record("needs-you block links to the waiting request", has_link, f"href={href if has_link else None}")
        if has_link:
            needs_you_link.click()
            page.wait_for_selector("#requests-title", timeout=5000)
            record("needs-you link opens Requests", location := page.url.endswith("/console/requests"))

        # -- 2. event stream connected --
        page.goto(f"{FRONTEND_ORIGIN}/console/", wait_until="networkidle")
        page.wait_for_function(
            "() => document.querySelector('#stream-dot')?.className.includes('is-live')",
            timeout=8000,
        )
        stream_ok = "is-live" in page.eval_on_selector("#stream-dot", "el => el.className")
        record("event stream is connected", stream_ok)

        # -- 2b. a task's ledger shows the events the API recorded for it --
        page.goto(f"{FRONTEND_ORIGIN}/console/tasks", wait_until="networkidle")
        page.wait_for_selector(".task-row", timeout=5000)
        page.click(".task-row")
        try:
            page.wait_for_selector("#ledger-content .ledger-entry", timeout=5000)
            entries = page.locator("#ledger-content .ledger-entry").count()
        except Exception:
            entries = 0
        record("task ledger shows its recorded events", entries > 0, f"{entries} entries")
        page.keyboard.press("Escape")

        # -- 3. create a role, then delete it --
        page.goto(f"{FRONTEND_ORIGIN}/console/roles", wait_until="networkidle")
        page.wait_for_selector("#roles-list")
        role_name = f"e2e-temp-role-{int(time.time())}"
        page.click("#add-role")
        page.fill(".role-editor input[name='name']", role_name)
        page.check("input[name='scopes'][value='inbox_read']")
        page.click(".role-editor button[type='submit']")
        try:
            page.wait_for_selector(f"[data-role-name='{role_name}']", timeout=5000)
            created = True
        except Exception:
            created = False
        record("create a role", created)

        if created:
            card = page.locator(f"[data-role-name='{role_name}']")
            card.locator("[data-delete-role]").click()
            try:
                page.wait_for_selector(f"[data-role-name='{role_name}']", state="detached", timeout=5000)
                deleted = True
            except Exception:
                deleted = False
            record("delete that role", deleted)
        else:
            record("delete that role", False, "role was never created")

        # -- 4. add a member to a role, then remove them --
        page.goto(f"{FRONTEND_ORIGIN}/console/roles", wait_until="networkidle")
        page.wait_for_selector("[data-role-name='ops']", timeout=5000)
        member_key = "e2e-temp-member@example.com"
        ops_card = page.locator("[data-role-name='ops']")
        ops_card.locator("[data-member-input]").fill(member_key)
        ops_card.locator("[data-add-member] button[type='submit']").click()
        try:
            page.wait_for_selector(f"[data-remove-member='{member_key}']", timeout=5000)
            added = True
        except Exception:
            added = False
        record("add a member to a role", added)

        if added:
            page.locator(f"[data-remove-member='{member_key}']").click()
            try:
                page.wait_for_selector(f"[data-remove-member='{member_key}']", state="detached", timeout=5000)
                removed = True
            except Exception:
                removed = False
            record("remove that member", removed)
        else:
            record("remove that member", False, "member was never added")

        # -- 4b. create a schedule, pause it, then delete it --
        page.goto(f"{FRONTEND_ORIGIN}/console/schedules", wait_until="networkidle")
        page.wait_for_selector("#schedules-list")
        schedule_title = f"e2e-temp-schedule-{int(time.time())}"
        page.click("#add-schedule")
        page.fill("#schedule-title", schedule_title)
        page.fill("#schedule-prompt", "Say hello (this is only an e2e check, never actually run).")
        # "once" (the default kind) needs a run_at; recurring only needs a cron expression,
        # which is simpler for this check to fill in.
        page.select_option("#schedule-kind", "recurring")
        page.fill("#schedule-cron", "0 9 * * 1-5")
        page.click("#schedule-form button[type='submit']")
        try:
            page.wait_for_function(
                "title => [...document.querySelectorAll('.schedule-card h3')].some(h => h.textContent === title)",
                arg=schedule_title,
                timeout=5000,
            )
            schedule_created = True
        except Exception:
            schedule_created = False
        record("create a schedule", schedule_created)

        if schedule_created:
            # A freshly created schedule is "proposed" (waiting on Aaron's approval of the
            # request it raised), not "active" -- pause/resume only apply once active, so
            # this only exercises delete, which schedules.py's action() allows in any state.
            card = page.locator(".schedule-card", has=page.locator(f"h3:text-is('{schedule_title}')"))
            card.locator("[data-schedule-action='delete']").click()
            try:
                page.wait_for_function(
                    "title => ![...document.querySelectorAll('.schedule-card h3')].some(h => h.textContent === title)",
                    arg=schedule_title,
                    timeout=5000,
                )
                schedule_deleted = True
            except Exception:
                schedule_deleted = False
            record("delete that schedule", schedule_deleted)
        else:
            record("delete that schedule", False, "schedule was never created")

        # -- 5. Refresh from Inkbox completes; people count + last-sync update --
        page.goto(f"{FRONTEND_ORIGIN}/console/permissions", wait_until="networkidle")
        page.wait_for_selector("#sync-people", timeout=5000)
        before_count = page.inner_text("#people-count")
        before_sync = page.inner_text("#people-last-sync")
        page.click("#sync-people")
        page.wait_for_function(
            "() => document.querySelector('#sync-people') && !document.querySelector('#sync-people').disabled",
            timeout=10000,
        )
        time.sleep(0.3)
        after_count = page.inner_text("#people-count")
        after_sync = page.inner_text("#people-last-sync")
        sync_ok = (after_sync != before_sync) and ("never synced" not in after_sync)
        record(
            "Refresh from Inkbox completes; people count + last-sync update",
            sync_ok,
            f"before=({before_count!r},{before_sync!r}) after=({after_count!r},{after_sync!r})",
        )

        browser.close()

        # -- 6. cross-origin mutation from a disallowed origin is refused --
        api_context = p.request.new_context()
        resp = api_context.post(
            f"{BACKEND_TAILNET_BASE}/console/api/roles",
            headers={"Origin": "http://evil.example.test", "Content-Type": "application/json"},
            data='{"name": "should-not-exist", "scopes": []}',
        )
        cross_origin_ok = resp.status == 403
        record(
            "cross-origin mutation from a disallowed origin is refused",
            cross_origin_ok,
            f"status={resp.status} body={resp.text()[:200]}",
        )

        # -- 7. same API returns 404 on 127.0.0.1 (non-tailnet peer) --
        resp2 = api_context.get(f"{BACKEND_LOOPBACK_BASE}/console/api/overview")
        loopback_ok = resp2.status == 404
        record(
            "same API returns 404 when called on 127.0.0.1",
            loopback_ok,
            f"status={resp2.status} body={resp2.text()[:200]}",
        )
        api_context.dispose()

    failures = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failures)}/{len(results)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
