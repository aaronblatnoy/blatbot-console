# blatbot-console (frontend)

A thin client for Blatbot's console: plain HTML, CSS and JavaScript, no build step,
no framework. It renders what the API gives it and posts what the user did. Every
rule that decides what something means -- which scopes are read/write/send, the
counts shown on a person row, the sort order, the warning on a role with a send
scope -- comes from the API in `blatbot-console-restyle` (the gateway/backend repo),
not from this code. This repo is the frontend only; the backend lives in
`~/blatbot-console-restyle` (`inkbox_claude/console/`), which keeps only
`/console/api/*` and `/console/events` now that this repo owns the page.

## Deploying on Coolify

The deploy path is Coolify (self-hosted PaaS on black-sky, UI at http://black-sky:8100),
building this repo's `Dockerfile`, not the systemd unit below. The old systemd unit file
(`systemd/blatbot-console-frontend.service`) is left in the repo for reference, but it
is not how this frontend is run anymore.

- Source: GitHub repo `aaronblatnoy/blatbot-console`, branch `main`, same source
  connection the `llm-server` Coolify application uses.
- Build: Dockerfile build. The image has no dependencies beyond the Python standard
  library (`python:3.12-alpine` base).
- `entrypoint.sh` writes `static/config.js` inside the container from two environment
  variables, `CONSOLE_API_BASE` and `CONSOLE_EVENTS_URL`, then runs `serve.py` bound to
  `0.0.0.0` inside the container. The `static/config.example.js` in this repo (the
  local-dev default pointing at the stub API) is never modified by this -- only the
  running container's copy is rewritten, each time it starts.
- Application environment variables to set in Coolify:
  - `CONSOLE_API_BASE=http://100.x.y.z:8771/console/api`
  - `CONSOLE_EVENTS_URL=http://100.x.y.z:8771/console/events`
- Exposure: Tailscale only. The container's port 8793 is published with a ports
  mapping bound to black-sky's Tailscale address specifically
  (`100.x.y.z:8793:8793`), not `0.0.0.0`. No public domain should be set on the
  application -- remove any Coolify-generated `sslip.io` domain.

## Pages

| Page | What it shows |
|---|---|
| Home | What is waiting, what is running, recent activity, upcoming schedules |
| Requests | Requests waiting on the owner, approved or rejected inline |
| Permissions | Per person: what runs on its own and what still interrupts |
| People | One entry per person with their contacts inside it; create, rename, tick roles, add, move and remove contacts, merge a duplicate; unassigned contacts listed separately |
| Roles | Each role's scopes and members; the editor adds and removes scopes from a pick list grouped by system |
| Scopes | The gate's decision tree, left to right: system, question, scopes, tools, and the roles holding each scope |
| Tasks | The task ledger with each task's events |
| Schedules | Approved schedules and their next runs |
| Health | Tunnel, uptime, interrupted runs, recent errors |
| Settings | The owner's knobs, each with what it does |

## Layout

```
index.html              the single page shell; console.js decides what to render
static/
  console.css            all styling (the room-matching background, the type scale)
  console.js              the thin client: fetch, render, post -- no business rules
  config.js                API base + events URL, read before console.js runs
  brand.svg                the abstract logo mark, used as the tab icon; the sidebar shows the
                            assistant's real picture, loaded from the API (`/console/api/avatar`)
  scene.svg                 the background: the room behind Blatbot's profile photo
  fonts/
    Inter-Variable-latin.woff2    self-hosted, SIL OFL (see font section below)
    OFL-Inter.txt
    SpaceGrotesk-Variable.woff2   self-hosted, SIL OFL -- the shipped default
    OFL-SpaceGrotesk.txt
    IBMPlexSans-Regular.woff2     self-hosted, SIL OFL -- comparison candidate only
    IBMPlexSans-Bold.woff2
    OFL-IBMPlexSans.txt
serve.py                 tiny static server: /static/* from disk, everything else
                          falls back to index.html so a reload on /console/roles works
stub/
  server.py               stdlib-only fake API server with made-up data, for local
                           dev with no live credentials and no real gate.db
screenshots/             every page at 1280px and 400px, plus the background
                          before/after comparison (see below)
systemd/
  blatbot-console-frontend.service   user unit, binds to the Tailscale interface
reference/
  (not committed)         the Blatbot profile photo lives in the backend repo's own
                           reference/ folder and must never ship in either repo
```

## Run it locally

No live credentials, no real Inkbox API, no real gate.db -- this is the whole point
of the stub.

```
python3 stub/server.py 8792     # fake API + SSE stream on :8792
python3 serve.py 8793           # the frontend itself on :8793
```

Open `http://127.0.0.1:8793/console/`. Copy `static/config.example.js` to `static/config.js` (which is not tracked); the example is pointed at
`http://127.0.0.1:8792/console/api` by default (cross-origin from the frontend's own
`:8793`, which is deliberate: it exercises the same CORS path a real deploy uses,
since the frontend and `inkbox_claude`'s console API are two different processes on
two different ports in production too).

## Configure

Edit `static/config.js`:

```js
window.CONSOLE_CONFIG = {
  apiBase: "http://<tailnet-host>:<gateway-port>/console/api",
  eventsUrl: "http://<tailnet-host>:<gateway-port>/console/events",
};
```

Every request the frontend makes, including the live event stream, goes through
these two values. There is nothing else to configure on this side.

On the backend side, `CONSOLE_ALLOWED_ORIGINS` (an env var on the gateway process)
must include this frontend's own origin, e.g.
`CONSOLE_ALLOWED_ORIGINS=http://100.x.y.z:8793`, or the backend's CORS layer
refuses it. The backend's `tailnet_gate` middleware also means this frontend only
ever gets real data when it (and whoever is loading it in a browser) reaches the
gateway over the tailnet -- `/console/api/*` returns 404 to anything else, including
the public tunnel.

## Deploy (black-sky)

This frontend is pure static files; it doesn't need Docker or Coolify. The intended
path:

1. `scp -r` (or `git clone` once this has a remote, which it does not yet) this repo
   to black-sky, e.g. `~/blatbot-console` under the `aaron` user that already runs
   blatbot (see `project_blatbot_on_black_sky.md`).
2. Point `static/config.js` at the gateway's real tailnet address and port.
3. Install the systemd unit:
   ```
   cp systemd/blatbot-console-frontend.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now blatbot-console-frontend
   ```
   The unit sets `BIND_HOST` to black-sky's Tailscale IP (100.x.y.z per
   CLAUDE.md) and binds `serve.py` to port **8793** -- chosen because 8771 is
   Blatbot's own service, and 8000/8003/8100/8780/8901/8903 are already used by
   other things on black-sky per the project's own memory notes. Confirm 8793 is
   still free before enabling.
4. Add this frontend's origin (`http://100.x.y.z:8793`, or whatever the final
   address is) to `CONSOLE_ALLOWED_ORIGINS` on the gateway process and restart it.

**Not done here**: nothing was installed or started on black-sky by this work. Step 1
(copying the repo over) and the gateway-side env var change are for Aaron to do, per
the standing instruction that live systems are never touched directly.

## Font

Three openly-licensed candidates were self-hosted and rendered side by side on
Requests and Roles at 1280px (`screenshots/requests-font-*.png`,
`screenshots/roles-font-*.png`): **Inter** (the prior default), **Space Grotesk**,
and **IBM Plex Sans**. All three are SIL Open Font License, fetched once each from
the font project's own GitHub repository (`floriankarsten/space-grotesk` and
`IBM/plex`) during this build; nothing in the shipped page makes a runtime request to
any outside host for any of them.

**Space Grotesk is the shipped default.** Its squarish, slightly geometric
letterforms read as sleek and a little technical without becoming a display face,
and it has more character than Inter's neutral humanist shapes -- closer to what
Aaron asked for ("this should be more fun really", and an explicit dislike of both
the old monospace font and the old neon palette). IBM Plex Sans is solid but reads
more corporate/neutral; Inter is clean but generic. `--sans` in `console.css` is the
one variable that controls the family everywhere; `--mono` remains reserved for
literal identifiers (request ids, scope names, handles) per the hard rule against
using monospace as the interface font. `body[data-font="inter"]` and
`body[data-font="ibm-plex-sans"]` attribute selectors exist only to reproduce the
comparison screenshots; nothing in the app sets that attribute at runtime.

## Screenshots

`screenshots/` holds, all taken headlessly against the stub API with Playwright
(never a foregrounded browser):

- `requests-1280.png`, `requests-400.png`, `requests-empty-1280.png` (the "nothing
  waiting" state, reached by approving the stub's one seeded request)
- `roles-1280.png`, `roles-400.png`, `roles-add-member-search.png` (the add-member
  search-over-people dropdown, mid-search)
- `permissions-1280.png`, `permissions-400.png`
- `tasks-1280.png`, `tasks-400.png`
- `health-1280.png`, `health-400.png`
- `settings-1280.png`, `settings-400.png`
- `requests-font-{inter,space-grotesk,ibm-plex-sans}.png`,
  `roles-font-{inter,space-grotesk,ibm-plex-sans}.png` (the font comparison)
- `background-comparison.png` (a crop of `reference/blatbot-profile.jpg`'s background
  next to the rendered page's background, side by side)

`scene.svg` (the background) went through three checked iterations against
`reference/blatbot-profile.jpg`: fixing a bug where the floor/ceiling grid-line
`<g>` had no `fill="none"`, so the browser filled each multi-point line path as a
black wedge (the "large empty wedges" the prior pass left in); brightening the base
gradient and densifying the glass-panel code-mark columns and violet panels so the
room reads as navy rather than black; then verifying it still holds up, simplified
rather than shrunk, at 400px. The reference photo itself is never copied into this
repo.

## End-to-end check (e2e/)

`e2e/` holds a rerunnable end-to-end check that exercises the REAL backend code (the
actual `inkbox_claude.console` routes imported from `~/blatbot-console-restyle`, not a
mock) against this repo's real, unmodified frontend files. It never touches live
credentials, the real Inkbox API, or any real `gate.db` -- everything runs against a
throwaway sqlite store in a temp directory and a fake Inkbox directory client with
made-up people.

```
e2e/
  backend_launcher.py   boots a real aiohttp app with the real console routes, a
                         throwaway Store, a minimal stand-in gateway object, and a
                         fake InkboxDirectoryClient; seeds roles/people/requests/tasks
  frontend_server.py    serves THIS repo's index.html + static/ unmodified from its
                         own port, except /static/config.js is generated on the fly
                         (pointed at the run's backend) instead of editing the
                         tracked config.js
  check.py              headless Playwright (never a foregrounded browser) script:
                         every page loads with data and no console/network errors;
                         create+delete a role; add+remove a role member; "Refresh
                         from Inkbox" updates the people count and last-sync time;
                         the event stream connects; a cross-origin mutation from a
                         non-allow-listed origin is refused; the API 404s on 127.0.0.1
  run.sh                the one command: starts backend + frontend, runs check.py,
                         tears everything down, exits non-zero on any failure
  .venv/                 this harness's own venv (aiohttp, pyyaml, playwright +
                         chromium) -- separate from the backend repo's uv-managed
                         .venv, which has no pip and isn't meant to take extra deps
```

Run it:

```
cd ~/blatbot-console/e2e
./run.sh
```

This requires a Tailscale IPv4 address on the machine running it (`tailscale ip -4`);
the backend binds to `0.0.0.0` on a fixed port so the SAME listener is reachable both
at that Tailscale address (exercising the real `tailnet_gate` allow path, exactly as
in production) and at `127.0.0.1` (exercising the real deny path -> 404), without
weakening `access.py` in any way to make the check pass. If there is no Tailscale
address, `run.sh` stops and says so rather than binding to loopback instead.

`E2E_BACKEND_REPO` (env var, default `~/blatbot-console-restyle`) tells
`backend_launcher.py` where to import `inkbox_claude` from if the backend repo ever
moves. `E2E_BACKEND_PORT` / `E2E_FRONTEND_PORT` override the default ports (18881 /
18893, deliberately uncommon so they don't collide with a dev server someone else has
running locally on 8792/8793) if those are taken.

## Hard rules this frontend follows

- No data in the frontend. People, contacts, roles, scopes, the scope tree, the list of
  contact types and their input hints, and the assistant's profile picture all come from
  the API at render time. What lives here is layout, wording, fonts and the background.
  `static/config.js` holds only where the API is.
- No text truncation: no `text-overflow: ellipsis`, no `nowrap` that hides visible
  content (the two `nowrap` uses left in `console.css` are on `.visually-hidden`
  screen-reader-only text and the single-word live/offline stream label, neither of
  which clips anything a sighted user can see; the `…` characters in `console.js` are
  literal loading-state words -- "Loading…", "Saving…" -- not clipped content).
- No emojis anywhere, including in code and comments (checked with a Unicode emoji
  range grep across `static/`, `index.html`, `stub/`, `serve.py`).
- No runtime request to any outside host: fonts, the background, and the brand mark
  are all self-hosted under `static/`; `static/config.js` points only at the
  console's own API host, configured per deployment.
- Works at 400px wide with no horizontal page scroll on the eight original pages
  (`document.documentElement.scrollWidth === clientWidth`, checked by script across
  Home, Requests, Permissions, Roles, Tasks, Schedules, Health and Settings). The People
  page was added later and has not been through that script; the Scopes page is a wide
  left-to-right tree that scrolls sideways inside its own panel.
- Body text contrast is checked at 4.5:1 against the brightest spot the background
  (`scene.svg`) can actually put behind on-background text, not just a dark corner of
  it: `--muted` and `--faint` were both too dark against the brightened background
  (3.93:1 and 2.63:1) and were lightened to `#bcc7e6` / `#b5c1e3` (4.47:1 / 4.76:1 at
  that same worst-case spot). `--text` on the same spot is 7.69:1.
- Amber (`--waiting`) is reserved for "needs you": the waiting-request count, the
  send-scope warning banner, the `SEND` badge, and form-control focus/validation. It
  is never used decoratively.
- Pending/running/done/failed are distinct by label text and badge shape/border, not
  color alone.
- Every input, select, textarea, checkbox and button has an explicit styled state,
  including the Roles page's "handle to add" field and the new add-member search
  dropdown (previously unstyled -- `.add-member-form input` had no CSS rule at all).
