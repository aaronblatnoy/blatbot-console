"""Headless checks of the commander role's locked-state UI (Roles page and the
commander person on the People page) against a throwaway real backend."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

FRONTEND, BACKEND, LOOPBACK = sys.argv[1:4]
SHOTS = Path.home() / 'scratch/commander-shots'
SHOTS.mkdir(parents=True, exist_ok=True)
results = []


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()
        page.on('dialog', lambda d: d.accept())
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

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
            page.goto(FRONTEND + '/console/roles')
            page.wait_for_selector('#roles-list [data-role-name]')
            card = page.locator('[data-role-name="commander"]')
            expect(card).to_be_visible()
            expect(card).to_contain_text('Everything, on verified channels only')
            expect(card).to_contain_text('Built in')
            expect(card.locator('[data-edit-role]')).to_have_count(0)
            expect(card.locator('[data-delete-role]')).to_have_count(0)
            expect(card.locator('[data-add-member]')).to_have_count(0)
            expect(card.locator('[data-remove-member]')).to_have_count(0)
            expect(card).to_contain_text('Taylor Reyes')
            # The locked role card is rendered first.
            first = page.locator('#roles-list > div').first
            expect(first).to_have_attribute('data-role-name', 'commander')
            page.screenshot(path=str(SHOTS / 'roles-page.png'), full_page=True)
        check(1, 'Roles page: commander is locked, first, described, undeletable', one)

        def two():
            page.goto(FRONTEND + '/console/people')
            page.wait_for_selector('#people-list .person-row')
            page.locator('.person-row', has=page.locator('.person-name', has_text='Taylor Reyes')).click()
            expect(page.locator('#person-form input[name=display]')).to_have_value('Taylor Reyes')
            box = page.locator('.person-role-locked')
            expect(box).to_be_visible()
            expect(box.locator('input[type=checkbox]')).to_be_checked()
            expect(box.locator('input[type=checkbox]')).to_be_disabled()
            expect(box).to_contain_text('cannot be changed here')
            expect(page.locator('.person-access')).to_contain_text('Everything, on verified channels only')
            expect(page.locator('[data-delete-person]')).to_have_count(0)
            expect(page.locator('#person-merge-form')).to_have_count(0)
            # Saving an unrelated edit (the name) must not drop the commander role.
            page.locator('#person-form input[name=display]').fill('Taylor Reyes Jr')
            page.locator('#person-form button[type=submit]').click()
            expect(page.locator('#person-form button[type=submit]')).to_be_disabled()
            expect(page.locator('.person-access')).to_contain_text('Everything, on verified channels only')
            page.screenshot(path=str(SHOTS / 'people-commander.png'), full_page=True)
        check(2, 'People page: commander person shows locked role, no delete/merge', two)

        def three():
            page.goto(FRONTEND + '/console/people')
            page.wait_for_selector('#people-list .person-row')
            page.locator('.person-row', has=page.locator('.person-name', has_text='Sam Parker')).click()
            expect(page.locator('#person-form input[name=display]')).to_have_value('Sam Parker')
            expect(page.locator('.person-role-locked')).to_have_count(0)
            expect(page.locator('[data-delete-person]')).to_have_count(1)
        check(3, 'People page: a non-commander person is unaffected', three)

        if errors:
            print('PAGE ERRORS:', errors, flush=True)
            results.append(False)

        browser.close()
        sys.exit(0 if all(results) else 1)


if __name__ == '__main__':
    main()
