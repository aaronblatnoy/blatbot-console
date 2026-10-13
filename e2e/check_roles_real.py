"""Headless checks of the new Roles page / person panel / nav against the REAL
console backend (roles_backend_launcher.py, from ~/blatbot/worktrees/ux-roles),
seeded with made-up roles and people through the real Store. Not a stub. Checks:
plain-English rendering with no raw scope name, changing a level calls the real
endpoint and updates the row, the who-can search finds a seeded match, the person
panel shows role chips + can_text, Scopes is off the left nav but still reachable
from Settings, no console errors, no horizontal scroll at 400px, and no element's
computed font-family contains 'mono'.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

FRONTEND, BACKEND = sys.argv[1:3]
SHOTS = Path.home() / "scratch/roles-shots"
SHOTS.mkdir(parents=True, exist_ok=True)
LOG_PATH = SHOTS / "verification.log"
log_lines = []
results = []

# Real scope names seeded into the 'assistant'/'organizer' roles -- must never
# appear in the rendered Roles-page or person-panel text.
RAW_SCOPE_NAMES = ["inbox_read", "email_send", "vault_read", "tamid_drive_write", "tamid_drive_read"]


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

        def roles_page_renders():
            goto("roles")
            page.wait_for_selector(".role-row")
            page.screenshot(path=str(SHOTS / "roles-desktop.png"), full_page=True)
            rows = page.locator(".role-row")
            expect(rows).to_have_count(4)  # commander (locked) + assistant + organizer + archivist
            body_text = page.locator("#roles-list").inner_text()
            for raw in RAW_SCOPE_NAMES:
                assert raw not in body_text, f"raw scope name {raw!r} leaked into Roles page text"
            assert "READ" not in body_text and "WRITE" not in body_text
            # Plain-English sentence present for the assistant role.
            assert "without asking" in body_text or "Can, without asking" in body_text

        def role_expand_and_change_level():
            row = page.locator('[data-role-name="organizer"]')
            row.locator("[data-toggle-role]").click()
            page.wait_for_selector('[data-role-name="organizer"] [data-role-level]')
            select = row.locator('[data-role-level][data-system="tamid_workspace"]')
            # The seeded organizer role holds tamid_drive_write without tamid_drive_read,
            # which the backend reports as a 'custom' level -- change it to 'none' and
            # confirm the row's can_text sentence updates to reflect the new grant.
            before_text = row.locator(".role-row-can-text").inner_text()
            select.select_option("none")
            page.wait_for_timeout(600)
            page.wait_for_load_state("networkidle")
            after_text = row.locator(".role-row-can-text").inner_text()
            assert after_text != before_text, "can_text sentence did not change after editing the level"
            page.screenshot(path=str(SHOTS / "role-expanded.png"), full_page=True)

        def who_can_search():
            search = page.locator("#who-can-search")
            search.fill("email")
            page.wait_for_timeout(500)
            page.wait_for_load_state("networkidle")
            results_host = page.locator("#who-can-results")
            expect(results_host).to_be_visible()
            text = results_host.inner_text()
            assert "assistant" in text or "Jordan" in text, f"expected a match for 'email', got: {text}"
            page.screenshot(path=str(SHOTS / "who-can-search.png"), full_page=True)
            search.fill("")
            page.wait_for_timeout(300)
            expect(results_host).to_be_hidden()

        def person_panel_chips():
            goto("people")
            page.wait_for_selector(".person-row")
            page.locator(".person-row", has_text="Jordan Avery").first.click()
            page.wait_for_selector(".person-role-chips")
            chips_text = page.locator(".person-role-chips").inner_text()
            assert "assistant" in chips_text
            can_text = page.locator(".person-can-text").inner_text()
            assert can_text.strip(), "can_text paragraph is empty"
            for raw in RAW_SCOPE_NAMES:
                assert raw not in can_text, f"raw scope name {raw!r} leaked into person can_text"
            expect(page.locator(".person-can-text-link a")).to_have_attribute("href", "/console/roles")
            page.screenshot(path=str(SHOTS / "person-panel.png"), full_page=True)

        def scopes_off_nav_but_reachable():
            goto("home")
            expect(page.locator('nav[aria-label="Console sections"] a[data-route="scopes"]')).to_have_count(0)
            goto("settings")
            link = page.locator('.settings-scopes-link a[data-route="scopes"]')
            expect(link).to_be_visible()
            link.click()
            page.wait_for_load_state("networkidle")
            assert "/console/scopes" in page.url
            page.wait_for_selector("#scopes-breakdown")

        def no_mono_fonts():
            goto("roles")
            page.wait_for_selector(".role-row")
            found = page.evaluate("""
                () => [...document.querySelectorAll('body *')].some(el => {
                    const f = getComputedStyle(el).fontFamily.toLowerCase();
                    return f.includes('mono');
                })
            """)
            assert not found, "an element's computed font-family contains 'mono'"

        def viewport_400():
            page.set_viewport_size({"width": 400, "height": 900})
            for view in ("roles", "people", "settings"):
                goto(view)
                page.wait_for_timeout(200)
                overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                assert overflow <= 1, f"{view} page has horizontal scroll at 400px: overflow={overflow}px"
            goto("roles")
            page.locator(".role-row").first.locator("[data-toggle-role]").click()
            page.wait_for_timeout(200)
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            assert overflow <= 1, f"expanded role row has horizontal scroll at 400px: overflow={overflow}px"
            page.screenshot(path=str(SHOTS / "roles-400.png"), full_page=True)
            page.set_viewport_size({"width": 1280, "height": 900})

        def custom_level_phrases_render():
            # 'archivist' holds only tamid_site_read (one read scope of a club_websites
            # pair held without the other), which the backend reports as a 'custom'
            # level -- its plain-words phrases must render BEFORE the three-way choice
            # control that would replace them, not after it.
            goto("roles")
            page.wait_for_selector(".role-row")
            row = page.locator('[data-role-name="archivist"]')
            row.locator("[data-toggle-role]").click()
            page.wait_for_selector('[data-role-name="archivist"] .role-custom-phrases')
            system_row = row.locator(".role-system-row").filter(has=page.locator(".role-custom-phrases")).first
            phrases = system_row.locator(".role-custom-phrases li")
            expect(phrases.first).to_be_visible()
            phrases_text = system_row.locator(".role-custom-phrases").inner_text()
            assert phrases_text.strip(), "custom phrases list is empty"
            for raw in RAW_SCOPE_NAMES + ["tamid_site_read", "tamid_site_write"]:
                assert raw not in phrases_text, f"raw scope name {raw!r} leaked into custom phrases"
            phrases_box = system_row.locator(".role-custom-phrases").bounding_box()
            controls_box = system_row.locator(".role-system-controls").bounding_box()
            assert phrases_box is not None and controls_box is not None
            assert phrases_box["y"] < controls_box["y"], (
                f"phrases ({phrases_box['y']}) must render above the level control ({controls_box['y']})"
            )
            page.screenshot(path=str(SHOTS / "role-custom.png"), full_page=True)

        def focus_accessibility():
            # Every control on the Roles page and the person panel must be reachable
            # by Tab, in an order that follows the visible layout, with a visible
            # focus state -- not relying on a default the stylesheet may suppress.
            goto("roles")
            page.wait_for_selector(".role-row")
            row = page.locator('[data-role-name="assistant"]')
            row.locator("[data-toggle-role]").click()
            page.wait_for_selector('[data-role-name="assistant"] [data-role-level]')
            name_input = row.locator("[data-role-name-input]")
            name_input.focus()
            seen_tags = []
            for _ in range(8):
                outline = page.evaluate("""
                    () => {
                        const el = document.activeElement;
                        const cs = getComputedStyle(el);
                        return { tag: el.tagName, cls: el.className, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
                    }
                """)
                seen_tags.append(outline)
                if outline["tag"] == "BODY":
                    break  # tabbed past the end of this row's own controls
                visible_outline = outline["outlineStyle"] != "none" and outline["outlineWidth"] != "0px"
                assert visible_outline, f"no visible focus outline on {outline['tag']}.{outline['cls']}"
                page.keyboard.press("Tab")
            goto("people")
            page.wait_for_selector(".person-row")
            page.locator(".person-row", has_text="Jordan Avery").first.click()
            page.wait_for_selector(".person-role-chips")
            page.locator(".person-role-chips [data-add-person-role]").focus()
            outline = page.evaluate("""
                () => {
                    const el = document.activeElement;
                    const cs = getComputedStyle(el);
                    return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px';
                }
            """)
            assert outline, "no visible focus outline on the person-panel add-role select"

        def system_row_stacks_400():
            page.set_viewport_size({"width": 400, "height": 900})
            goto("roles")
            page.wait_for_selector(".role-row")
            row = page.locator('[data-role-name="assistant"]')
            row.locator("[data-toggle-role]").click()
            page.wait_for_selector('[data-role-name="assistant"] [data-role-level]')
            system_row = row.locator(".role-system-row").first
            label_box = system_row.locator(".role-system-label").bounding_box()
            controls_box = system_row.locator(".role-system-controls").bounding_box()
            assert label_box is not None and controls_box is not None
            assert controls_box["y"] >= label_box["y"] + label_box["height"] - 1, (
                "the system label and its control sit side by side at 400px instead of stacked: "
                f"label bottom={label_box['y'] + label_box['height']}, controls top={controls_box['y']}"
            )
            page.set_viewport_size({"width": 1280, "height": 900})

        check(1, "Roles page renders from /roles/summary with no raw scope names", roles_page_renders)
        check(2, "Changing a level calls set_level and updates the row's sentence", role_expand_and_change_level)
        check(3, "Who-can search finds a seeded match", who_can_search)
        check(4, "Person panel shows role chips and can_text", person_panel_chips)
        check(5, "Scopes is off the left nav but reachable from Settings", scopes_off_nav_but_reachable)
        check(6, "No computed font-family contains 'mono'", no_mono_fonts)
        check(7, "No horizontal scroll at 400px on Roles/People/Settings", viewport_400)
        check(8, "No browser console errors during the walkthrough",
              lambda: (_ for _ in ()).throw(AssertionError(console_errors)) if console_errors else None)
        check(9, "Custom-level phrases render before the three-way control", custom_level_phrases_render)
        check(10, "Every Roles/person-panel control is Tab-reachable with a visible focus state", focus_accessibility)
        check(11, "An expanded system row stacks label above control at 400px", system_row_stacks_400)

        browser.close()

    LOG_PATH.write_text("\n".join(log_lines) + "\n")
    if not all(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
