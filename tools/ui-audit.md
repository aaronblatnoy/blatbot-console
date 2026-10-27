# Console interaction audit — 2026-10-27

## Findings and changes

- Home looked clickable but its surfaces were inert. All four cards now open their owning page, show large counts, and expose hover and keyboard focus states. Stuck schedule rows open Schedules.
- Request history only displayed text. Rows now open a read-only detail with a Back arrow, and the history disclosure has a clear Open/Back cue.
- Schedule and role inspection required finding a small control. Their full cards now open history or role details, while nested action controls keep their existing behavior.
- Schedule failures could hide the recorded error. Last-run summaries, history, and legacy Home summaries now use `final_status` when `result_line` is missing.
- People details fell below the mobile viewport. Selection scrolls to the editor; Back returns to the selected person and warns before discarding unsaved changes.
- Group, health, and settings surfaces looked interactive without opening anything. They now open read-only details, leaving editing controls directly accessible.
- Frequency and report choices were scattered radio controls. They now use native dropdowns; repair frequency changes also update the visible fields.
- Dense prose, status boxes, and left-edge selection stripes added noise. Summaries are shorter, status text is plain, and card selection uses outlines. The navy identity and bundled sans-serif font remain.

## Browser verification

Astra and the primary agent used headed Chromium in Xvfb. Before/after captures cover Home, Requests, People, Roles, Tasks, Schedules, Group chats, Health, and Settings at 1440px and 400px. Neither width overflowed horizontally. The primary agent also used xdotool for the nine-page walkthrough.

All rendered instances were inspected: 4 Home cards, 197 request rows, 31 people, 4 roles, 50 task ledgers, 3 schedules and their 3 run rows, 4 groups, 5 health cards, and 14 settings rows. Keyboard activation and Back were verified. Browser console/page errors and attempted mutations: zero. Browser routing blocked every method except GET, HEAD, and OPTIONS throughout live verification.

Screenshots remain local (they include live data): `tools/shots/before-{page}-{1440,400}.png`, `after-{page}-{1440,400}.png`, `walk-{page}.png`, and detail captures. `e2e/check_navigation.py` provides a repeatable read-only regression pass and captures `verified-*` images.

## Existing test suites

- Roles: 13 checks passed.
- Group chats: 6 checks passed.
- Schedule repair: 3 checks passed.
- Schedule stub: 8/9 passed; unchanged main also fails its cross-page console check because the fixture lacks endpoints (404).
- Real schedules: 11/13 passed after adapting radio selectors to dropdowns. Unchanged main has the same failures: fixture supplies 7 schedules while the assertion expects 6; its backend lacks the roles summary endpoint.
- Home: unchanged main reproduces the same wording mismatch and roles-summary endpoint/CORS failure.
- Legacy People: backend setup fails before browser checks because its Store no longer has `set_approver_handles`.

All write-testing suites use their own disposable databases and non-live ports. Live files were compared byte-for-byte with index.html, static/console.js, and static/console.css served at port 8793. Cache version: ux20261027.
