"""Read-only card/navigation regression check against a running console.

Usage: E2E_HEADED=1 DISPLAY=:89 python e2e/check_navigation.py http://host:8793
No live writes are allowed: every non-GET/HEAD/OPTIONS request is blocked.
"""
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1].rstrip('/')
SHOTS = Path(__file__).resolve().parents[1] / 'tools' / 'shots'
SHOTS.mkdir(parents=True, exist_ok=True)
PAGES = ('home', 'requests', 'people', 'roles', 'tasks', 'schedules', 'groups', 'health', 'settings')

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=os.environ.get('E2E_HEADED') != '1')
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, service_workers='block')
    errors, writes = [], []

    def guard(route):
        if route.request.method in ('GET', 'HEAD', 'OPTIONS'):
            route.continue_()
        else:
            writes.append(route.request.url)
            route.abort()

    context.route('**/*', guard)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)

    def goto(name):
        page.goto(BASE + '/console/' + ('' if name == 'home' else name))
        page.wait_for_load_state('networkidle')
        expect(page.locator(f'[data-view={name}]')).to_be_visible()

    for width in (1440, 400):
        page.set_viewport_size({'width': width, 'height': 900})
        for name in PAGES:
            goto(name)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (name, width)
            page.screenshot(path=str(SHOTS / f'verified-{name}-{width}.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 900})

    goto('home')
    for index in range(page.locator('.home-card').count()):
        goto('home')
        card = page.locator('.home-card').nth(index)
        destination = card.get_attribute('data-card-route')
        card.focus()
        page.keyboard.press('Enter')
        expect(page.locator(f'[data-view={destination}]')).to_be_visible()

    for name, selector in [('requests', '[data-request-detail]'), ('groups', '.group-row'),
                           ('health', '[data-info-card]'), ('settings', '.setting-row')]:
        goto(name)
        if name == 'requests':
            page.locator('.history-block summary').click()
        count = page.locator(selector).count()
        for index in range(count):
            card = page.locator(selector).nth(index)
            card.focus()
            page.keyboard.press('Enter')
            expect(page.locator('#card-detail-dialog')).to_be_visible()
            page.locator('[data-close-dialog=card-detail-dialog]').click()
            expect(page.locator('#card-detail-dialog')).to_be_hidden()
        print(f'PASS {name}: {count} cards', flush=True)

    goto('roles')
    for index in range(page.locator('.role-row').count()):
        card = page.locator('.role-row').nth(index)
        card.focus()
        page.keyboard.press('Space')
        expect(card.locator('.role-row-body')).to_be_visible()
        card.locator('[data-toggle-role]').click()
        expect(card.locator('.role-row-body')).to_have_count(0)

    goto('schedules')
    for index in range(page.locator('.schedule-card').count()):
        card = page.locator('.schedule-card').nth(index)
        card.focus()
        page.keyboard.press('Enter')
        expect(card.locator('[aria-busy=true]')).to_have_count(0)
        for run_index in range(card.locator('.schedule-run-row').count()):
            row = card.locator('.schedule-run-row').nth(run_index)
            row.focus()
            page.keyboard.press('Enter')
            detail = card.locator('.schedule-run-detail').nth(run_index)
            expect(detail).to_be_visible()
            detail.locator('[data-run-back]').click()
            expect(detail).to_be_hidden()
        card.locator('[data-schedule-history]').click()

    goto('people')
    count = page.locator('.person-row').count()
    for index in range(count):
        page.locator('.person-row').nth(index).click()
        expect(page.locator('#person-form')).to_be_visible()
        page.locator('[data-person-back]').click()
        expect(page.locator('#person-form')).to_have_count(0)
    print(f'PASS people: {count} cards', flush=True)

    goto('tasks')
    count = page.locator('.task-row').count()
    for index in range(count):
        page.locator('.task-row').nth(index).click()
        expect(page.locator('#task-dialog')).to_be_visible()
        expect(page.locator('#ledger-title')).not_to_have_text('Loading ledger…')
        expect(page.locator('#ledger-title')).not_to_have_text('Ledger unavailable')
        page.locator('[data-close-dialog=task-dialog]').click()
        expect(page.locator('#task-dialog')).to_be_hidden()
    print(f'PASS tasks: {count} cards', flush=True)
    assert not writes, writes
    assert not errors, errors
    print('PASS all pages, keyboard navigation, back controls; zero console errors or writes')
    browser.close()
