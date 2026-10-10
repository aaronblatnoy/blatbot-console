"""Headless checks of the unified People page against a throwaway real backend."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

FRONTEND, BACKEND, LOOPBACK = sys.argv[1:4]
SHOTS = Path.home() / 'scratch/people-page-shots'
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
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '409' not in m.text else None)

        def api(path, body=None):
            url = BACKEND + '/console/api' + path
            response = context.request.get(url) if body is None else context.request.post(url, data=body, headers={'Origin': FRONTEND})
            assert response.ok, f'{path}: {response.status} {response.text()}'
            return response.json()

        def directory(): return api('/people/directory')
        def person(name): return next(p for p in directory()['people'] if p['display'] == name)
        def open_people():
            page.goto(FRONTEND + '/console/people')
            page.wait_for_selector('#people-list .person-row')
            page.wait_for_function("document.querySelector('#stream-label').textContent === 'live'")
        def select(name):
            page.locator('.person-row', has=page.locator('.person-name', has_text=name)).click()
            expect(page.locator('#person-form input[name=display]')).to_have_value(name)
        def check(number, title, fn):
            try:
                fn()
                results.append(True)
                print(f'PASS {number}. {title}', flush=True)
            except Exception as e:
                results.append(False)
                print(f'FAIL {number}. {title}: {e}', flush=True)
                page.screenshot(path=str(SHOTS / f'failure-{number}.png'), full_page=True)
        def save():
            page.locator('#person-form button[type=submit]').click()
            expect(page.locator('#person-form button[type=submit]')).to_be_disabled()
            expect(page.locator('#person-dirty-label')).to_be_hidden()

        def one():
            open_people(); expect(page.locator('#person-editor')).to_contain_text('Select a person'); select('Sam Parker')
            assert page.locator('.person-row', has_text='Sam Parker').count() == 1
            expect(page.locator('.person-row', has_text='Sam Parker')).to_contain_text('2 contacts')
            assert page.locator('#person-contacts .person-contact').count() == 2
            page.screenshot(path=str(SHOTS / 'people-desktop.png'))
            page.locator('#unassigned-block').evaluate('(e) => e.open = true')
            page.screenshot(path=str(SHOTS / 'people-unassigned.png'))
        check(1, 'One person row, two contact fields and contact count', one)

        def two():
            page.locator('#person-form input[name=display]').fill('Sam Draft')
            expect(page.locator('#person-form button[type=submit]')).to_be_enabled()
            page.reload(); select('Sam Parker')
            page.locator('#person-form input[name=display]').fill('Escape draft')
            page.locator('#person-form input[name=display]').press('Escape')
            expect(page.locator('#person-form input[name=display]')).to_have_value('Sam Parker')
            page.locator('#person-form input[name=display]').fill('Sam Updated')
            page.locator('#person-form input[name=display]').press('Control+s')
            expect(page.locator('#person-form button[type=submit]')).to_be_disabled()
            expect(page.locator('.person-row.is-selected')).to_contain_text('Sam Updated')
            expect(page.locator('#person-form input[name=display]')).to_have_value('Sam Updated')
        check(2, 'Name draft discarded on reload; saved rename keeps selection', two)

        def three():
            select('Sam Updated')
            page.locator('#person-form input[value=ops]').check(); save()
            expect(page.locator('.person-access')).to_contain_text('email_send')
            sam = person('Sam Updated')
            roles = api('/roles'); ops = next(r for r in roles if r['name'] == 'ops')
            assert any(m.get('person') == 'Sam Updated' for m in ops['members'])
            page.goto(FRONTEND + '/console/roles')
            expect(page.locator('[data-role-name=ops] .role-members h4')).to_have_text(f"Members ({len(ops['members'])})")
            open_people(); select('Sam Updated')
        check(3, 'Role save updates effective scopes and Roles member count', three)

        def four():
            row = page.locator('.person-contact', has=page.locator('input[data-contact-value][value="sam@example.com"]'))
            row.locator('input').fill('sam.new@example.com'); row.locator('input').press('Enter')
            expect(row.locator('.contact-status')).to_have_text('Saved')
            page.reload(); select('Sam Updated')
            row = page.locator('.person-contact', has=page.locator('input[data-contact-value][value="sam.new@example.com"]'))
            row.locator('input').fill('alex@example.com'); row.locator('input').press('Enter')
            expect(row.locator('.contact-status')).to_contain_text('Already belongs to Alex Morgan')
            assert row.locator('.contact-status').inner_text().find(person('Alex Morgan')['id']) == -1
            assert len(person('Sam Updated')['contacts']) == 2
            assert any(c['value'] == 'alex@example.com' for c in person('Alex Morgan')['contacts'])
            page.screenshot(path=str(SHOTS / 'contact-clash.png'))
            row.locator('input').press('Escape')
            expect(row.locator('input')).to_have_value('sam.new@example.com')
        check(4, 'Contact Enter persists; clash names owner without deleting', four)

        def five():
            page.locator('#unassigned-block').evaluate('(e) => e.open = true')
            page.locator('#person-form textarea[name=note]').fill('Draft while assigning')
            before = int(page.locator('#unassigned-count').inner_text())
            row = page.locator('.unassigned-row', has_text='unassigned@example.com')
            row.locator('[data-assign]').click()
            expect(page.locator('#person-contacts')).to_contain_text('Remove')
            expect(page.locator('#person-contacts input[value="unassigned@example.com"]')).to_be_visible()
            expect(page.locator('#unassigned-count')).to_have_text(str(before-1))
            expect(page.locator('#person-form textarea[name=note]')).to_have_value('Draft while assigning')
            page.locator('[data-discard-person]').click()
        check(5, 'Assign immediately adds contact and lowers unassigned count', five)

        def six():
            p = api('/people/create', {'display':'Delete Sample'})
            api('/people/contact/add',{'person_id':p['id'],'kind':'email','value':'delete@example.com'})
            open_people(); select('Delete Sample'); page.locator('[data-delete-person]').click()
            expect(page.locator('.person-row',has_text='Delete Sample')).to_have_count(0)
            page.locator('#unassigned-block').evaluate('(e) => e.open = true')
            expect(page.locator('#unassigned-list')).to_contain_text('delete@example.com')
        check(6, 'Delete person leaves contacts unassigned', six)

        def seven():
            a = api('/people/create',{'display':'Merge Sample A','role':'ops'})
            b = api('/people/create',{'display':'Merge Sample B','role':'read-only'})
            api('/people/contact/add',{'person_id':a['id'],'kind':'email','value':'merge@example.com'})
            open_people(); select('Merge Sample A'); page.locator('.person-advanced').evaluate('(e) => e.open = true')
            page.locator('#person-merge-form select').select_option(b['id'])
            page.locator('#person-merge-form button').click()
            expect(page.locator('.person-row',has_text='Merge Sample A')).to_have_count(0)
            expect(page.locator('.person-row',has_text='Merge Sample B')).to_have_count(1)
            assert person('Merge Sample B')['role'] == 'read-only'
            assert any(c['value'] == 'merge@example.com' for c in person('Merge Sample B')['contacts'])
        check(7, 'Merge leaves one person and preserves target roles', seven)

        def eight():
            select('Sam Updated'); page.locator('#person-form input[name=display]').fill('Keep my draft')
            second = context.new_page()
            second.goto(FRONTEND + '/console/people'); second.wait_for_selector('.person-row')
            second.locator('.person-row',has_text='Alex Morgan').click()
            second.locator('#person-form textarea[name=note]').fill('Changed from second page')
            second.locator('#person-form button[type=submit]').click()
            expect(page.locator('#person-external-change')).to_be_visible()
            expect(page.locator('#person-form input[name=display]')).to_have_value('Keep my draft')
            expect(page.locator('#person-dirty-label')).to_be_visible()
            second.close(); page.locator('[data-discard-person]').click()
        check(8, 'Second page mutation preserves open draft and shows reload notice', eight)

        def nine():
            page.set_viewport_size({'width':400,'height':900}); select('Sam Updated')
            page.locator('[data-list-mode=people]').click()
            expect(page.locator('#people-records')).to_be_visible()
            page.screenshot(path=str(SHOTS / 'people-mobile.png'),full_page=True)
            page.locator('[data-list-mode=unassigned]').click()
            expect(page.locator('#unassigned-list')).to_be_visible()
            page.screenshot(path=str(SHOTS / 'unassigned-mobile.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.evaluate("""() => [...document.querySelectorAll('#people input, #people select, #people button, #people .person-row')].filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().right <= innerWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis')""")
            page.set_viewport_size({'width':1400,'height':900})
        check(9, '400px: both list positions reachable, no clipping or horizontal scroll', nine)

        def ten():
            page.goto(FRONTEND + '/console/permissions'); expect(page.locator('#people-title')).to_be_visible()
            page.wait_for_selector('.person-row'); assert page.locator('#permissions').count() == 0
        check(10, 'Legacy permissions URL opens People', ten)

        def eleven():
            before = api('/roles'); old = next(r for r in before if r['name'] == 'read-only')
            page.goto(FRONTEND + '/console/roles'); page.locator('[data-role-name="read-only"] [data-edit-role]').click()
            page.locator('.role-editor input[name=name]').fill('reader')
            page.screenshot(path=str(SHOTS / 'roles-edit.png'),full_page=True)
            page.locator('.role-editor button[type=submit]').click()
            expect(page.locator('[data-role-name=reader]')).to_be_visible()
            new = next(r for r in api('/roles') if r['name'] == 'reader')
            assert {m['key'] for m in new['members']} == {m['key'] for m in old['members']}
            page.locator('[data-role-name=reader] [data-delete-role]').click()
            expect(page.locator('[data-role-name=reader]')).to_have_count(0)
            assert all('reader' not in p['role'].split(', ') for p in directory()['people'])
        check(11, 'Role rename keeps members; deletion removes role from people', eleven)

        def twelve():
            errors.clear()
            for name,path in [('Home',''),('Requests','requests'),('People','people'),('Roles','roles'),('Scopes','scopes'),('Tasks','tasks'),('Schedules','schedules'),('Health','health'),('Settings','settings')]:
                page.goto(FRONTEND + '/console/' + path)
                page.wait_for_function("""() => document.querySelector('#main [data-view]:not([hidden])')?.textContent.trim().length > 30""")
                page.wait_for_timeout(300)
            assert not errors, errors
        check(12, 'No console errors on all nine pages', twelve)
        def extras():
            open_people(); select('Dana Ruiz')
            direct = person('Dana Ruiz')['scopes']
            page.locator('#person-form textarea[name=note]').fill('Keep direct grants')
            save()
            expect(page.locator('.person-access')).to_contain_text('plus 1 direct grants')
            assert person('Dana Ruiz')['scopes'] == direct
            select('Sam Updated')
            page.locator('#contact-add-form input').fill('alex@example.com')
            page.locator('#contact-add-form button[type=submit]').click()
            expect(page.locator('#contact-add-form .contact-status')).to_contain_text('Already belongs to Alex Morgan')
            page.locator('#contact-add-form [data-clash-move]').click()
            expect(page.locator('#person-contacts input[value="alex@example.com"]')).to_be_visible()
            assert not any(c['value'] == 'alex@example.com' for c in person('Alex Morgan')['contacts'])
            page.locator('#add-person').click()
            expect(page.locator('#person-form input[name=display]')).to_have_value('')
            expect(page.locator('.person-row.is-selected')).to_contain_text('(unnamed)')
            page.locator('#person-form input[name=display]').fill('Created Sample'); save()
            page.locator('#contact-add-form input').fill('created@example.com')
            page.locator('#contact-add-form button[type=submit]').click()
            expect(page.locator('#person-contacts input[value="created@example.com"]')).to_be_visible()
            row = page.locator('#person-contacts .person-contact').first
            row.locator('select').select_option('other'); row.locator('select').press('Tab')
            expect(row.locator('.contact-status')).to_have_text('Saved')
            assert person('Created Sample')['contacts'][0]['kind'] == 'other'
            page.locator('.person-advanced').evaluate('(e) => e.open = true')
            page.locator('#contact-move-form select[name=contact_id]').select_option(person('Created Sample')['contacts'][0]['id'])
            page.locator('#contact-move-form button').click()
            expect(page.locator('#person-contacts')).to_contain_text('No contacts.')
            page.locator('#unassigned-block').evaluate('(e) => e.open = true')
            row = page.locator('.unassigned-row',has_text='created@example.com')
            row.locator('[data-new-contact-person]').click()
            expect(page.locator('#person-form input[name=display]')).to_have_value('created@example.com')
            row = page.locator('#person-contacts .person-contact').first
            row.locator('[data-remove-contact]').click()
            expect(page.locator('#person-contacts')).to_contain_text('No contacts.')
            response = context.request.get(LOOPBACK + '/console/api/overview')
            assert response.status == 404
            response = context.request.post(BACKEND + '/console/api/roles',data={'name':'forbidden','scopes':[]},headers={'Origin':'http://disallowed.example.test'})
            assert response.status == 403
        check('extra', 'Add clash move, create, type edit, unassign, new person, remove and access gate', extras)
        browser.close()
    print(f'{sum(results)}/{len(results)} checks passed')
    return 0 if all(results) else 1

if __name__ == '__main__': sys.exit(main())
