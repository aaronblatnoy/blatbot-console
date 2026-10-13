"""Headless checks of the new Home page (Stuck/Running/Done today/Coming up) against
the REAL console backend (home_backend_launcher.py, from ~/blatbot/worktrees/ux-p3,
the merged backend branch), seeded with made-up schedules and requests through the
real Store + ScheduleService -- including the realistic shapes from the coordinator's
merged-backend pass: a 90-char-cut voice hand-off transcript, the JSON buffer-size
error, and a schedule whose own linked request fails. Not the stub. Also checks: no
monospace font-family on a status chip/role name/contact handle across Home, People,
Roles, Schedules; no console errors on any of the nine pages; the 400px and 1400px
layouts (a long Stuck sentence must wrap, never force horizontal scroll); node --check
already run separately on console.js."""
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

_PHONE_RE = re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")

FRONTEND, BACKEND = sys.argv[1:3]
SHOTS = Path.home() / "scratch/ux-shots"
SHOTS.mkdir(parents=True, exist_ok=True)
LOG_PATH = SHOTS / "verification.log"
log_lines = []
results = []

PAGES = ["home", "requests", "people", "roles", "scopes", "tasks", "schedules", "health", "settings"]


def log(line):
    print(line, flush=True)
    log_lines.append(line)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        page.on("dialog", lambda d: d.accept())
        console_errors = []
        page.on("pageerror", lambda e: console_errors.append(str(e)))
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        def api(path, body=None):
            url = BACKEND + "/console/api" + path
            return (context.request.get(url, headers={"Origin": FRONTEND}) if body is None
                    else context.request.post(url, data=body, headers={"Origin": FRONTEND}))

        def goto(view):
            page.goto(FRONTEND + "/console/" + ("" if view == "home" else view))
            page.wait_for_load_state("networkidle")

        def check(number, title, fn):
            try:
                fn()
                results.append(True)
                log(f"PASS {number}. {title}")
            except Exception as e:
                results.append(False)
                log(f"FAIL {number}. {title}: {e}")
                page.screenshot(path=str(SHOTS / f"failure-{number}.png"), full_page=True)

        def home_sections():
            goto("home")
            page.wait_for_selector(".home-stuck")
            page.screenshot(path=str(SHOTS / "home-desktop.png"), full_page=True)
            expect(page.locator(".home-stuck")).to_be_visible()
            expect(page.locator(".home-running")).to_be_visible()
            expect(page.locator(".home-done-today")).to_be_visible()
            expect(page.locator(".home-coming-up")).to_be_visible()
            stuck_rows = page.locator(".home-stuck .home-row")
            # Seeded: a paused schedule, an incomplete-active schedule, a proposal, a
            # pending request, a failed request, a pending voice hand-off, a voice
            # hand-off that failed with the JSON buffer error, and the pottery
            # schedule (its own linked failed request must NOT also show up as a
            # ninth, separate row) -- eight Stuck rows.
            expect(stuck_rows).to_have_count(8)
            stuck_text = page.locator(".home-stuck").inner_text()
            for forbidden in ("mcp__inkbox__inkbox_update_contact", "Live phone call with",
                              "blatbot:", "caller:", "JSON", "bytes"):
                assert forbidden not in stuck_text, f"{forbidden!r} found: {stuck_text}"
            assert not _PHONE_RE.search(stuck_text), f"a phone number leaked into: {stuck_text}"
            assert "pottery course" in stuck_text, stuck_text
            assert "studio's site" in stuck_text or "Saturday availability" in stuck_text, stuck_text
            running_text = page.locator(".home-running").inner_text()
            assert "Team total watch" in running_text, running_text
            assert "is running now" in running_text, running_text
            done_text = page.locator(".home-done-today").inner_text()
            assert "Sorted 12 messages into 3 folders" in done_text, done_text
            assert "Drafted the weekly memo and saved it" in done_text, done_text
            coming_items = page.locator(".home-coming-up .home-mini-list li")
            expect(coming_items).to_have_count(3)
            sources = page.locator(".home-sources").inner_text()
            assert "Requests" in sources and "Schedules" in sources, sources
        check(1, "Home renders all four sections with the seeded rows, nothing raw leaks", home_sections)

        def home_action_button():
            goto("home")
            page.wait_for_selector(".home-stuck")
            button = page.locator('[data-home-action*="\\"action\\":\\"approve\\""]').first
            expect(button).to_be_visible()
            with page.expect_request(lambda r: "/schedules/approve" in r.url or "/requests/decide" in r.url):
                button.click()
        check(2, "A Stuck action button calls the right endpoint", home_action_button)

        def no_mono_anywhere():
            for view, selector in [
                ("home", ".state, .home-mini-summary"),
                ("people", ".person-role, .person-key"),
                ("roles", ".role-scopes, .scope-name"),
                ("schedules", ".state, .schedule-facts dd"),
            ]:
                goto(view)
                page.wait_for_timeout(300)
                locator = page.locator(selector).first
                if locator.count() == 0:
                    continue
                family = locator.evaluate("el => getComputedStyle(el).fontFamily").lower()
                assert "mono" not in family, f"{view}/{selector} computed font-family is {family!r}"
        check(3, "No monospace font-family on a status chip, role name or contact handle", no_mono_anywhere)

        def no_console_errors():
            for view in PAGES:
                console_errors.clear()
                goto(view)
                page.wait_for_timeout(400)
                assert not console_errors, f"{view}: {console_errors}"
        check(4, "No browser console errors on any of the nine pages", no_console_errors)

        def layout_no_horizontal_scroll(width):
            page.set_viewport_size({"width": width, "height": 900})
            goto("home")
            page.wait_for_selector(".home-stuck")
            scroll_width = page.evaluate("document.documentElement.scrollWidth")
            client_width = page.evaluate("document.documentElement.clientWidth")
            page.screenshot(path=str(SHOTS / f"home-{width}.png"), full_page=True)
            assert scroll_width <= client_width + 1, f"scrollWidth {scroll_width} > clientWidth {client_width}"

        def layout_400px():
            layout_no_horizontal_scroll(400)
            page.set_viewport_size({"width": 1280, "height": 900})
        check(5, "Home works at 400px wide with no horizontal scroll", layout_400px)

        def layout_1400px():
            # The pottery-studio Stuck sentence is a long, realistic run-on ask; it
            # must wrap inside its row, never push the page wider than the viewport.
            layout_no_horizontal_scroll(1400)
            page.set_viewport_size({"width": 1280, "height": 900})
        check(7, "A long Stuck sentence wraps cleanly at 1400px with no horizontal scroll", layout_1400px)

        def typeface_screenshots():
            goto("people")
            page.wait_for_timeout(300)
            page.screenshot(path=str(SHOTS / "people.png"), full_page=True)
            goto("schedules")
            page.wait_for_timeout(300)
            page.screenshot(path=str(SHOTS / "schedules.png"), full_page=True)
        check(6, "Screenshots of People and Schedules for the typeface change", typeface_screenshots)

        browser.close()

    LOG_PATH.write_text("\n".join(log_lines) + "\n")
    if all(results):
        log("OVERALL PASS")
    else:
        log("OVERALL FAIL")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
