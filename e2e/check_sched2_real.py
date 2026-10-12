"""Headless checks of the Schedules page against the REAL console backend
(schedule_backend_launcher.py, from ~/blatbot/worktrees/sched2), seeded with made-up
schedules through the real Store + ScheduleService. Not the stub -- see SPEC.md's
"Verification" bullet for P7, extended per the coordinator's real-backend brief."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

FRONTEND, BACKEND, LOOPBACK = sys.argv[1:4]
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
            return (context.request.get(url, headers={'Origin': FRONTEND}) if body is None
                    else context.request.post(url, data=body, headers={'Origin': FRONTEND}))

        def open_schedules():
            page.goto(FRONTEND + '/console/schedules')
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
                page.screenshot(path=str(SHOTS / f'real-failure-{number}.png'), full_page=True)

        def one():
            open_schedules()
            expect(page.locator('.schedule-card')).to_have_count(6)
            page.screenshot(path=str(SHOTS / 'real-desktop-list.png'), full_page=True)
            expect(card('Team total watch').locator('.state')).to_contain_text('Waiting')
            expect(card('Monday brief').locator('.state')).to_contain_text('Needs your yes')
            expect(card('Friday wrap-up').locator('.state')).to_contain_text('Needs your yes')
            expect(card('Weekly backup check').locator('.state')).to_contain_text('Paused')
            expect(card('October invoice reminder').locator('.state')).to_contain_text('Ended')
            donor = card('Donor tracker sync')
            expect(donor.locator('.schedule-missing')).to_contain_text('look up and edit contacts')
            expect(donor.locator('[data-schedule-let-it]')).to_be_visible()
        check(1, 'Real backend: every seeded state renders with the right label', one)

        def two():
            team = card('Team total watch')
            team.locator('.schedule-history-toggle').click()
            page.wait_for_selector('.schedule-history-table .schedule-run-row')
            rows = team.locator('.schedule-run-row')
            expect(rows).to_have_count(2)
            expect(team.locator('.schedule-history-table')).to_contain_text('look up and edit contacts')
            page.screenshot(path=str(SHOTS / 'real-history-open.png'), full_page=True)
            incomplete_row = team.locator('.schedule-run-row', has_text='Could not finish')
            incomplete_row.click()
            detail = incomplete_row.locator('xpath=following-sibling::tr[1]//*[contains(@class,"schedule-run-full")]')
            expect(detail).to_be_visible()
            text = detail.inner_text()
            assert len(text) > 2000, len(text)
            assert 'so stopped there' in text
        check(2, 'Real run history: both rows, denied label from a real scope, long status uncut', two)

        def three():
            donor = card('Donor tracker sync')
            donor.locator('[data-schedule-let-it]').click()
            page.wait_for_timeout(400)
            donor = card('Donor tracker sync')
            # The real edit endpoint always re-proposes a capability change (needs_approval
            # is keyed on the *presence* of "scopes" in the request, not whether it is new),
            # so "Let it" does not take effect immediately here the way the chat command in
            # SPEC.md's example does -- it has to be approved like any other change.
            expect(donor.locator('.state')).to_contain_text('Needs your yes')
            expect(donor.locator('.schedule-missing')).to_have_count(0)
            donor.locator('[data-schedule-action="approve"]').click()
            page.wait_for_timeout(400)
            donor = card('Donor tracker sync')
            expect(donor.locator('.state')).not_to_contain_text('Needs your yes')
            expect(donor.locator('.scope-row')).to_contain_text('look up and edit contacts')
        check(3, 'Let it clears the gap in the data at once, but still needs an approve', three)

        def four():
            team = card('Team total watch')
            team.locator('[data-schedule-action="pause"]').click()
            page.wait_for_timeout(300)
            expect(card('Team total watch').locator('.state')).to_contain_text('Paused')
            card('Team total watch').locator('[data-schedule-action="resume"]').click()
            page.wait_for_timeout(300)
            expect(card('Team total watch').locator('.state')).to_contain_text('Waiting')
            r = api('/schedules')
            sid = next(s['id'] for s in r.json()['schedules'] if s['title'] == 'October invoice reminder')
            resp = api('/schedules/action', {'id': sid, 'action': 'run_now'})
            assert resp.status == 409, (resp.status, resp.text())
        check(4, 'Pause/resume flip real state; an action invalid for ended is a real 409', four)

        def five():
            card('Monday brief').locator('[data-schedule-action="approve"]').click()
            page.wait_for_timeout(300)
            expect(card('Monday brief').locator('.state')).to_contain_text('Waiting')
            card('Friday wrap-up').locator('[data-schedule-action="reject"]').click()
            page.wait_for_timeout(300)
            expect(card('Friday wrap-up').locator('.state')).to_contain_text('Stopped')
        check(5, 'Approve activates; reject on a fresh proposal ends it as Stopped', five)

        def six():
            card('Weekly backup check').locator('[data-schedule-action="stop"]').click()
            page.wait_for_timeout(300)
            expect(card('Weekly backup check').locator('.state')).to_contain_text('Stopped')
        check(6, 'Stop from paused ends the schedule as Stopped', six)

        def seven():
            import time as _time
            r = api('/schedules').json()
            sid = next(s['id'] for s in r['schedules'] if s['title'] == 'Team total watch')
            card('Team total watch').locator('[data-schedule-action="run_now"]').click()
            page.wait_for_timeout(300)
            after = api('/schedules').json()
            next_run_after = next(s['next_run'] for s in after['schedules'] if s['id'] == sid)
            # action('run_now') sets next_run to literally "now" at the moment of the
            # call; this harness runs no ticker to then fire it, so the only thing to
            # check is that the server set it to (close to) the current time.
            assert abs(next_run_after - _time.time()) < 10, (next_run_after, _time.time())
        check(7, 'Run now sets the real next_run to now (no ticker running in this harness to fire it)', seven)

        CADENCE_CASES = [
            ('once', 'Once watch', lambda f: (
                f.locator('#schedule-cadence-options input[value=once]').check(),
                f.locator('[data-cadence-fields=once] input[name=cadence_at]').fill('2026-11-03T09:15'),
            ), 'once on Tue Nov 3 at 9:15 AM'),
            ('every', 'Every watch', lambda f: (
                f.locator('#schedule-cadence-options input[value=every]').check(),
                f.locator('[data-cadence-fields=every] input[name=cadence_every_value]').fill('10'),
                f.locator('[data-cadence-fields=every] select[name=cadence_every_unit]').select_option('minutes'),
            ), 'every 10 minutes'),
            ('daily', 'Daily watch', lambda f: (
                f.locator('#schedule-cadence-options input[value=daily]').check(),
                f.locator('[data-cadence-fields=daily] input[name=cadence_daily_time]').fill('09:00'),
            ), 'daily at 9:00 AM'),
            ('weekdays', 'Weekdays watch', lambda f: (
                f.locator('#schedule-cadence-options input[value=weekdays]').check(),
                f.locator('[data-cadence-fields=weekdays] input[name=cadence_weekdays_time]').fill('07:30'),
            ), 'weekdays at 7:30 AM'),
            ('weekly', 'Weekly watch', lambda f: (
                f.locator('#schedule-cadence-options input[value=weekly]').check(),
                f.locator('[data-cadence-fields=weekly] select[name=cadence_day]').select_option('wed'),
                f.locator('[data-cadence-fields=weekly] input[name=cadence_weekly_time]').fill('16:00'),
            ), 'Wednesdays at 4:00 PM'),
            ('cron', 'Cron watch', lambda f: (
                f.locator('.cadence-advanced').evaluate('(e) => e.open = true'),
                f.locator('#schedule-cadence-advanced input[value=cron]').check(),
                f.locator('[data-cadence-fields=cron] input[name=cadence_expr]').fill('0 9 * * 1-5'),
            ), None),  # cron wording is cron.describe's own job; just confirm it is non-empty
        ]

        def eight():
            for kind, title, fill, expected_text in CADENCE_CASES:
                open_schedules()
                page.locator('#add-schedule').click()
                page.wait_for_selector('#schedule-dialog[open]')
                page.locator('#schedule-prompt').fill(f'Watch something for the {kind} cadence check.')
                page.locator('#schedule-title').fill(title)
                fill(page)
                page.locator('#schedule-scopes input[value=web]').check()
                page.locator('#schedule-form button[type=submit]').click()
                page.wait_for_selector('#schedule-dialog', state='hidden')
                open_schedules()
                created = card(title)
                expect(created).to_be_visible()
                if expected_text:
                    expect(created.locator('.schedule-cadence')).to_contain_text(expected_text)
                else:
                    cadence_text = created.locator('.schedule-cadence').inner_text()
                    assert len(cadence_text.strip()) > 0
            # Every create proposes (needs_approval, regardless of cadence kind) -- approve
            # them all here so 9/10 can isolate editing an already-active schedule, rather
            # than conflating "still needs its first yes" with "this edit needed a new one".
            listing = api('/schedules').json()['schedules']
            for _, title, _, _ in CADENCE_CASES:
                sid = next(s['id'] for s in listing if s['title'] == title)
                resp = api('/schedules/approve', {'id': sid, 'approve': True})
                assert resp.status == 200, (title, resp.status, resp.text())
        check(8, 'Create accepted for all six cadence kinds; card shows the server\'s own wording', eight)

        def nine():
            open_schedules()
            daily = card('Daily watch')
            daily.locator('[data-schedule-action="edit"]').click()
            page.wait_for_selector('#schedule-dialog[open]')
            page.locator('[data-cadence-fields=daily] input[name=cadence_daily_time]').fill('11:45')
            page.locator('#schedule-form button[type=submit]').click()
            page.wait_for_selector('#schedule-dialog', state='hidden')
            expect(page.locator('#notice')).to_contain_text('updated')
            open_schedules()
            daily = card('Daily watch')
            expect(daily.locator('.state')).not_to_contain_text('Needs your yes')
            expect(daily.locator('.schedule-cadence')).to_contain_text('11:45 AM')
        check(9, 'Editing only the cadence applies at once, no approval asked', nine)

        def ten():
            weekly = card('Weekly watch')
            weekly.locator('[data-schedule-action="edit"]').click()
            page.wait_for_selector('#schedule-dialog[open]')
            page.locator('#schedule-prompt').fill('Watch something else entirely now.')
            page.screenshot(path=str(SHOTS / 'real-form.png'), full_page=True)
            page.locator('#schedule-form button[type=submit]').click()
            page.wait_for_selector('#schedule-dialog', state='hidden')
            open_schedules()
            weekly = card('Weekly watch')
            expect(weekly.locator('.state')).to_contain_text('Needs your yes')
            weekly.locator('[data-schedule-action="approve"]').click()
            page.wait_for_timeout(300)
            expect(card('Weekly watch').locator('.state')).not_to_contain_text('Needs your yes')
        check(10, 'Editing the prompt asks for approval; approve clears it', ten)

        def eleven():
            errors.clear()
            open_schedules()
            page.wait_for_timeout(300)
            for path in ['', 'requests', 'people', 'roles', 'scopes', 'tasks', 'health', 'settings']:
                page.goto(FRONTEND + '/console/' + path)
                page.wait_for_timeout(250)
            assert not errors, errors
        check(11, 'No console errors on Schedules or any other page against the real backend', eleven)

        def twelve():
            page.set_viewport_size({'width': 400, 'height': 900})
            open_schedules()
            page.wait_for_timeout(200)
            page.screenshot(path=str(SHOTS / 'real-400px.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.set_viewport_size({'width': 1280, 'height': 900})
        check(12, '400px width: no horizontal scroll against the real backend', twelve)

        loopback_check = context.request.get(LOOPBACK + '/console/api/schedules')
        assert loopback_check.status == 404, loopback_check.status
        print('PASS extra. Real tailnet_gate still denies the loopback address (404)', flush=True)
        results.append(True)

        browser.close()
    print(f'{sum(results)}/{len(results)} checks passed')
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
