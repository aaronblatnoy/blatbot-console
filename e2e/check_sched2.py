"""Headless checks of the Schedules page against the stub API (stub_schedules_backend.py).
See SPEC.md's "Verification" bullet for package P7 for what each check number proves."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

FRONTEND, BACKEND = sys.argv[1:3]
SHOTS = Path.home() / 'scratch/sched2-shots'
SHOTS.mkdir(parents=True, exist_ok=True)
results = []


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = context.new_page()
        page.on('dialog', lambda d: d.accept())
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        def api(path, body=None):
            url = BACKEND + '/console/api' + path
            response = context.request.get(url) if body is None else context.request.post(url, data=body)
            return response

        def open_schedules():
            page.goto(FRONTEND + '/console/schedules')
            # Scoped to #schedules-list: the unscoped selector could resolve its first
            # DOM match to the (hidden) People page's own ".empty-state" and wait on
            # that element's visibility forever instead of the real list.
            page.wait_for_selector('#schedules-list .schedule-card, #schedules-list .empty-state')

        def card(title):
            return page.locator('.schedule-card', has=page.locator('h3', has_text=title))

        def check(number, title, fn):
            try:
                fn()
                results.append(True)
                print(f'PASS {number}. {title}', flush=True)
            except Exception as e:
                results.append(False)
                print(f'FAIL {number}. {title}: {e}', flush=True)
                page.screenshot(path=str(SHOTS / f'failure-{number}.png'), full_page=True)

        def one():
            open_schedules()
            expect(page.locator('.schedule-card')).to_have_count(5)
            page.screenshot(path=str(SHOTS / 'desktop-list.png'), full_page=True)
            expect(card('Monday brief').locator('.state')).to_contain_text('Needs your yes')
            expect(card('Monday brief').locator('[data-schedule-action="approve"]')).to_be_visible()
            expect(card('Monday brief').locator('[data-schedule-action="reject"]')).to_be_visible()
            page.screenshot(path=str(SHOTS / 'card-needs-approval.png'))
            missing = card('Donor tracker sync')
            expect(missing.locator('.schedule-missing')).to_contain_text('look up and edit contacts')
            expect(missing.locator('[data-schedule-let-it]')).to_be_visible()
            expect(card('October invoice reminder')).to_contain_text('No capabilities')
            chip_font = card('Team total watch').locator('.schedule-capability-chip').first.evaluate('e => getComputedStyle(e).fontFamily')
            assert 'mono' not in chip_font.lower(), chip_font
        check(1, 'Desktop list renders every state; approval card and missing-capability card show', one)

        def two():
            errors.clear()
            donor = card('Donor tracker sync')
            donor.locator('[data-schedule-let-it]').click()
            page.wait_for_timeout(300)
            donor = card('Donor tracker sync')
            expect(donor.locator('.schedule-missing')).to_have_count(0)
            assert not errors, errors
        check(2, 'Let it button clears the missing capability', two)

        def three():
            watch = card('Team total watch')
            watch.locator('[data-schedule-action="pause"]').click()
            page.wait_for_timeout(300)
            expect(card('Team total watch').locator('.state')).to_contain_text('Paused')
            expect(card('Team total watch').locator('[data-schedule-action="start_again"]')).to_be_visible()
            card('Team total watch').locator('[data-schedule-action="start_again"]').click()
            page.wait_for_timeout(300)
            expect(card('Team total watch').locator('.state')).to_contain_text('Running')
        check(3, 'Pause and resume (start_again) call the right endpoint and flip state', three)

        def four():
            r = api('/schedules')
            sid = next(s['id'] for s in r.json()['schedules'] if s['title'] == 'Weekly backup check')
            resp = api('/schedules/action', {'id': sid, 'action': 'run_now'})
            assert resp.status == 409, resp.status
            open_schedules()
            paused = card('Weekly backup check')
            paused.locator('[data-schedule-action="start_again"]').click()
            page.wait_for_timeout(300)
            paused = card('Weekly backup check')
            paused.locator('[data-schedule-action="stop"]').click()
            page.wait_for_timeout(300)
            expect(card('Weekly backup check').locator('.state')).to_contain_text('Stopped')
        check(4, 'A refused action is 409 from the API; stop calls stop and ends the schedule', four)

        def five():
            approve_card = card('Monday brief')
            approve_card.locator('[data-schedule-action="approve"]').click()
            page.wait_for_timeout(300)
            expect(card('Monday brief').locator('.state')).to_contain_text('Running')
            expect(card('Monday brief').locator('.state')).not_to_contain_text('Needs your yes')
        check(5, 'Approve calls /schedules/approve and clears the needs-approval state', five)

        def six():
            page.locator('#add-schedule').click()
            page.wait_for_selector('#schedule-dialog[open]')
            page.locator('#schedule-prompt').fill('Watch the status page and tell me if it goes down.')
            page.locator('#schedule-title').fill('Status page watch')
            page.locator('#schedule-cadence-options select[name=cadence_kind]').select_option('every')
            # Only the selected frequency's fields are visible.
            expect(page.locator('[data-cadence-fields=every]')).to_be_visible()
            expect(page.locator('[data-cadence-fields=once]')).to_be_hidden()
            expect(page.locator('[data-cadence-fields=weekly]')).to_be_hidden()
            page.locator('[data-cadence-fields=every] input[name=cadence_every_value]').fill('2')
            page.locator('[data-cadence-fields=every] select[name=cadence_every_unit]').select_option('hours')
            page.locator('#schedule-scopes input[value=web_read]').check()
            page.screenshot(path=str(SHOTS / 'form.png'), full_page=True)
            page.locator('#schedule-form button[type=submit]').click()
            # A closed <dialog> has no `open` attribute and is not rendered (display:
            # none), so "visible" is the wrong state to wait for -- wait for it to
            # become hidden instead.
            page.wait_for_selector('#schedule-dialog', state='hidden')
            expect(page.locator('#notice')).to_contain_text('yes')
            open_schedules()
            expect(card('Status page watch')).to_be_visible()
            expect(card('Status page watch').locator('.schedule-cadence')).to_contain_text('2 hour')
        check(6, 'New-schedule form builds the "every" cadence_kind/cadence and shows the API message', six)

        def seven():
            long_card = card('Donor tracker sync')
            long_card.locator('.schedule-history-toggle').click()
            page.wait_for_selector('.schedule-history-table .schedule-run-row')
            page.screenshot(path=str(SHOTS / 'history-open.png'), full_page=True)
            row = long_card.locator('.schedule-run-row').first
            row.click()
            detail = long_card.locator('.schedule-run-full').first
            expect(detail).to_be_visible()
            text = detail.inner_text()
            assert len(text) > 2000, len(text)
            assert 'padding' in text
        check(7, 'Run history opens, loads from the runs endpoint, and a row expands the full status uncut', seven)

        def eight():
            errors.clear()
            open_schedules()
            page.wait_for_timeout(300)
            assert not errors, errors
            for path in ['', 'requests', 'people', 'roles', 'scopes', 'tasks', 'health', 'settings']:
                page.goto(FRONTEND + '/console/' + path)
                page.wait_for_timeout(250)
            assert not errors, errors
        check(8, 'No console errors on the Schedules page or any other page', eight)

        def nine():
            page.set_viewport_size({'width': 400, 'height': 900})
            open_schedules()
            page.wait_for_timeout(200)
            page.screenshot(path=str(SHOTS / '400px.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.set_viewport_size({'width': 1280, 'height': 900})
        check(9, '400px width: no horizontal scroll', nine)

        browser.close()
    print(f'{sum(results)}/{len(results)} checks passed')
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
