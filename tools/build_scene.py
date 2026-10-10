"""Generate static/scene.svg, the fixed page background.

The scene is the room behind the figure in Blatbot's profile picture: a dark
server corridor, mostly near-black navy, lit by thin lines of electric blue,
a glowing door frame on the left, standing glass panels, columns of data
marks, a little violet, and a wireframe gem on the right. Darkness dominates;
the light is in the lines.

Run from the repo root:  python3 tools/build_scene.py
The output is deterministic (fixed seed), so the file only changes when this
script does.
"""

from __future__ import annotations

import random
from pathlib import Path

W, H = 1600, 1000
BLUE = "#2487de"
BLUE_HOT = "#7cc4ff"
VIOLET = "#6a4fe0"
rng = random.Random(7)
out: list[str] = []
add = out.append

add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice">')
add("""  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#01020b"/>
      <stop offset="45%" stop-color="#030819"/>
      <stop offset="100%" stop-color="#02040f"/>
    </linearGradient>
    <radialGradient id="poolLeft" cx="16%" cy="46%" r="38%">
      <stop offset="0%" stop-color="#0b3a8f" stop-opacity=".50"/>
      <stop offset="60%" stop-color="#06205a" stop-opacity=".16"/>
      <stop offset="100%" stop-color="#06205a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="poolRight" cx="86%" cy="38%" r="36%">
      <stop offset="0%" stop-color="#0a2f7c" stop-opacity=".42"/>
      <stop offset="60%" stop-color="#071c52" stop-opacity=".14"/>
      <stop offset="100%" stop-color="#071c52" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="poolViolet" cx="10%" cy="88%" r="34%">
      <stop offset="0%" stop-color="#3a22a0" stop-opacity=".34"/>
      <stop offset="100%" stop-color="#3a22a0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="poolVioletR" cx="92%" cy="84%" r="30%">
      <stop offset="0%" stop-color="#34208f" stop-opacity=".26"/>
      <stop offset="100%" stop-color="#34208f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="48%" r="75%">
      <stop offset="55%" stop-color="#000005" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000005" stop-opacity=".72"/>
    </radialGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d3f9a" stop-opacity=".20"/>
      <stop offset="100%" stop-color="#0d3f9a" stop-opacity=".02"/>
    </linearGradient>
    <linearGradient id="streak" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7cc4ff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#7cc4ff" stop-opacity=".75"/>
      <stop offset="100%" stop-color="#7cc4ff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="streakV" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8f7af5" stop-opacity="0"/>
      <stop offset="50%" stop-color="#8f7af5" stop-opacity=".6"/>
      <stop offset="100%" stop-color="#8f7af5" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7cc4ff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#7cc4ff" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#7cc4ff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="softer" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>
  </defs>""")

add(f'  <rect width="{W}" height="{H}" fill="url(#base)"/>')
for pool in ("poolLeft", "poolRight", "poolViolet", "poolVioletR"):
    add(f'  <rect width="{W}" height="{H}" fill="url(#{pool})"/>')

# Corridor perspective: floor and ceiling lines running to a vanishing point.
VX, VY = 800, 470
add(f'  <g stroke="{BLUE}" stroke-width="1" fill="none">')
for x in range(-400, 2001, 150):
    op = 0.05 + 0.10 * (1 - abs(x - 800) / 1400)
    add(f'    <path d="M{x} {H + 20} L{VX} {VY}" stroke-opacity="{op:.2f}"/>')
    add(f'    <path d="M{x} -20 L{VX} {VY}" stroke-opacity="{op * 0.6:.2f}"/>')
add("  </g>")
# Cross lines on the floor, closer together toward the vanishing point.
add(f'  <g stroke="{VIOLET}" stroke-width="1" fill="none">')
y, step = 990.0, 120.0
while y > VY + 30:
    t = (y - VY) / (H - VY)
    half = 1400 * t
    add(f'    <path d="M{VX - half:.0f} {y:.0f} L{VX + half:.0f} {y:.0f}" stroke-opacity="{0.06 + 0.16 * t:.2f}"/>')
    step *= 0.72
    y -= max(step, 14)
add("  </g>")

# Ceiling light strips, as in the upper part of the photo.
for (x1, y1, x2, y2, op) in ((120, 120, 620, 70, .55), (980, 60, 1500, 110, .5), (300, 190, 700, 150, .3), (900, 150, 1320, 190, .3)):
    add(f'  <path d="M{x1} {y1} L{x2} {y2}" stroke="{BLUE_HOT}" stroke-opacity="{op * 0.5:.2f}" stroke-width="9" filter="url(#soft)"/>')
    add(f'  <path d="M{x1} {y1} L{x2} {y2}" stroke="{BLUE_HOT}" stroke-opacity="{op:.2f}" stroke-width="1.5"/>')

# Standing glass panels: dark glass with a thin lit edge, nearer ones taller.
panels = [(40, 60, 150, 900, .45), (215, 120, 105, 790, .32), (345, 170, 78, 690, .22), (455, 215, 58, 600, .15),
          (1410, 60, 150, 900, .45), (1280, 120, 105, 790, .32), (1177, 170, 78, 690, .22), (1087, 215, 58, 600, .15)]
for (x, y0, w, h, op) in panels:
    add(f'  <rect x="{x}" y="{y0}" width="{w}" height="{h}" fill="url(#glass)" stroke="{BLUE}" stroke-opacity="{op:.2f}" stroke-width="1"/>')
    add(f'  <path d="M{x} {y0} L{x} {y0 + h}" stroke="url(#streak)" stroke-width="1.5"/>')

# The glowing door frame on the left of the photo: the brightest object in the room.
dx, dy, dw, dh = 250, 150, 190, 720
add(f'  <rect x="{dx}" y="{dy}" width="{dw}" height="{dh}" fill="none" stroke="{BLUE_HOT}" stroke-opacity=".55" stroke-width="10" filter="url(#softer)"/>')
add(f'  <rect x="{dx}" y="{dy}" width="{dw}" height="{dh}" fill="#0b3a8f" fill-opacity=".10" stroke="{BLUE_HOT}" stroke-opacity=".72" stroke-width="2"/>')
add(f'  <rect x="{dx + 12}" y="{dy + 12}" width="{dw - 24}" height="{dh - 24}" fill="none" stroke="{BLUE}" stroke-opacity=".35" stroke-width="1"/>')

# Thin vertical streaks of light scattered through the room.
for _ in range(34):
    x = rng.randint(20, W - 20)
    y0 = rng.randint(-40, 620)
    ln = rng.randint(140, 520)
    violet = rng.random() < 0.22
    add(f'  <path d="M{x} {y0} L{x} {y0 + ln}" stroke="url(#{"streakV" if violet else "streak"})" stroke-width="{rng.choice((1, 1, 1, 1.5))}" stroke-opacity="{rng.uniform(.35, .9):.2f}"/>')

# Columns of small data marks, densest toward the right like the photo.
add(f'  <g fill="{BLUE_HOT}">')
for _ in range(26):
    x = rng.choice((rng.randint(900, W - 30), rng.randint(900, W - 30), rng.randint(30, 700)))
    y = rng.randint(40, 300)
    op = rng.uniform(.18, .5)
    for _ in range(rng.randint(8, 30)):
        w = rng.choice((3, 3, 5, 9, 14, 20))
        add(f'    <rect x="{x}" y="{y}" width="{w}" height="2" fill-opacity="{op:.2f}"/>')
        y += rng.choice((7, 7, 9, 14))
        if y > H - 40:
            break
add("  </g>")

# Fine points of light, like the specks floating in the photo.
add("  <g>")
for _ in range(150):
    x, y = rng.randint(0, W), rng.randint(0, H)
    violet = rng.random() < 0.3
    add(f'    <circle cx="{x}" cy="{y}" r="{rng.choice((.8, 1, 1, 1.4))}" fill="{"#a898ff" if violet else BLUE_HOT}" fill-opacity="{rng.uniform(.25, .8):.2f}"/>')
add("  </g>")

# Violet holographic panels with lines of text, left middle and right lower.
for (x, y0, w, h) in ((70, 300, 130, 96), (120, 560, 100, 70), (1330, 610, 140, 100)):
    add(f'  <rect x="{x}" y="{y0}" width="{w}" height="{h}" fill="#4a2fc0" fill-opacity=".12" stroke="#8f7af5" stroke-opacity=".55" stroke-width="1"/>')
    yy = y0 + 12
    while yy < y0 + h - 8:
        add(f'  <rect x="{x + 10}" y="{yy}" width="{rng.randint(int(w * .3), w - 22)}" height="2" fill="#a898ff" fill-opacity=".45"/>')
        yy += 9
# Long violet light lines low in the frame.
for (x1, y1, x2, y2, op) in ((0, 760, 520, 742, .5), (0, 840, 380, 852, .35), (1180, 800, 1600, 780, .45), (1050, 905, 1600, 918, .3)):
    add(f'  <path d="M{x1} {y1} L{x2} {y2}" stroke="#8f7af5" stroke-opacity="{op * 0.5:.2f}" stroke-width="7" filter="url(#soft)"/>')
    add(f'  <path d="M{x1} {y1} L{x2} {y2}" stroke="#a898ff" stroke-opacity="{op:.2f}" stroke-width="1"/>')

# Wireframe gem on the right, as in the photo.
gx, gy = 1245, 395
pts = [(0, -62), (58, -22), (36, 48), (-36, 48), (-58, -22)]
hub = (0, 2)
add(f'  <g stroke="#a898ff" stroke-width="1.2" fill="none" stroke-opacity=".8" transform="translate({gx} {gy})">')
add('    <path d="M' + " L".join(f"{x} {y}" for x, y in pts) + ' Z"/>')
for (x, y) in pts:
    add(f'    <path d="M{x} {y} L{hub[0]} {hub[1]}" stroke-opacity=".55"/>')
add('    <path d="M-58 -22 L36 48 M58 -22 L-36 48 M0 -62 L-36 48 M0 -62 L36 48" stroke-opacity=".3"/>')
for (x, y) in pts + [hub]:
    add(f'    <circle cx="{x}" cy="{y}" r="2" fill="#cfc6ff" stroke="none"/>')
add("  </g>")
add(f'  <circle cx="{gx}" cy="{gy}" r="70" fill="#6a4fe0" fill-opacity=".16" filter="url(#softer)"/>')

# Circuit traces: right-angle runs with small nodes, low contrast.
add(f'  <g stroke="{BLUE}" stroke-width="1" fill="none" stroke-opacity=".35">')
for _ in range(14):
    x, y = rng.randint(40, W - 200), rng.randint(60, H - 60)
    a, b, c = rng.randint(40, 160), rng.choice((-1, 1)) * rng.randint(20, 70), rng.randint(30, 120)
    add(f'    <path d="M{x} {y} h{a} v{b} h{c}"/>')
    add(f'    <circle cx="{x + a + c}" cy="{y + b}" r="2.5" fill="{BLUE_HOT}" fill-opacity=".7" stroke="none"/>')
add("  </g>")

add(f'  <rect width="{W}" height="{H}" fill="url(#vignette)"/>')
add("</svg>")

dest = Path(__file__).resolve().parent.parent / "static" / "scene.svg"
dest.write_text("\n".join(out) + "\n", encoding="utf-8")
print(f"wrote {dest} ({dest.stat().st_size} bytes)")
