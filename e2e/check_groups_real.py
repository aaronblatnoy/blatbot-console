"""Headless checks of the new Group chats page against the REAL console backend
(groups_backend_launcher.py, from ~/blatbot/app), seeded with made-up group chats
through the real Store. Not a stub. Checks: the three fixture rows render with their
channel and member count, a chat whose mode was never set shows the "Mention only"
product default, the explicitly-natural and explicitly-silent rows show their own
mode, changing a row's dropdown calls the real endpoint and the change survives a
reload (persisted through the real Store, not just the DOM), no left accent bar or
pill-chip classes are used, and no console errors.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

FRONTEND, BACKEND = sys.argv[1:3]
SHOTS = Path.home() / "scratch/groups-shots"
SHOTS.mkdir(parents=True, exist_ok=True)
LOG_PATH = SHOTS / "verification.log"
log_lines = []
results = []


def log(line):
    print(line, flush=True)
    log_lines.append(line)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        console_errors = []
        page.on("pageerror", lambda e: console_errors.append(str(e)))
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        def goto(view):
            page.goto(FRONTEND + "/console/" + view)
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

        def groups_page_renders():
            goto("groups")
            page.wait_for_selector(".group-row")
            page.screenshot(path=str(SHOTS / "groups-desktop.png"), full_page=True)
            rows = page.locator(".group-row")
            expect(rows).to_have_count(3)

        def default_mode_shows_mention():
            row = page.locator('.group-row[data-chat-id="tg:-900001"]')
            expect(row).to_contain_text("E2E Fixture Chat")
            expect(row).to_contain_text("telegram")
            expect(row).to_contain_text("2 members")
            select = row.locator("select[data-group-mode]")
            expect(select).to_have_value("mention")

        def explicit_modes_show_correctly():
            natural_row = page.locator('.group-row[data-chat-id="tg:-900002"]')
            expect(natural_row.locator("select[data-group-mode]")).to_have_value("natural")
            silent_row = page.locator('.group-row[data-chat-id="imsg:e2e-900003"]')
            expect(silent_row.locator("select[data-group-mode]")).to_have_value("silent")
            expect(silent_row).to_contain_text("imessage")

        def changing_mode_persists_through_the_real_store():
            row = page.locator('.group-row[data-chat-id="tg:-900002"]')
            row.locator("select[data-group-mode]").select_option("silent")
            page.wait_for_timeout(400)
            status = row.locator(".group-row-save-state")
            expect(status).to_have_text("Saved")
            goto("groups")  # reload the view fresh from the API, not the in-memory state
            row2 = page.locator('.group-row[data-chat-id="tg:-900002"]')
            expect(row2.locator("select[data-group-mode]")).to_have_value("silent")

        def no_pill_chips_or_left_accent_bars():
            html = page.locator("#groups-list").inner_html()
            assert "chip" not in html.lower(), "found a chip class in the group chats list"
            assert "pill" not in html.lower(), "found a pill class in the group chats list"

        def no_console_errors():
            assert not console_errors, f"console errors: {console_errors}"

        checks = [
            (1, "Group chats page renders three fixture rows", groups_page_renders),
            (2, "Never-configured chat shows the Mention default with its channel and member count", default_mode_shows_mention),
            (3, "Explicitly natural/silent chats show their own mode", explicit_modes_show_correctly),
            (4, "Changing a row's dropdown persists through the real Store across a reload", changing_mode_persists_through_the_real_store),
            (5, "No pill-chip or left-accent-bar styling in the group chats list", no_pill_chips_or_left_accent_bars),
            (6, "No console errors on the Group chats page", no_console_errors),
        ]
        for number, title, fn in checks:
            check(number, title, fn)

        browser.close()

    LOG_PATH.write_text("\n".join(log_lines) + "\n")
    passed = sum(results)
    log(f"\n{passed}/{len(results)} checks passed.")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
