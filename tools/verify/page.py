# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The review page for one build, from its verification run: the gate
# (photos.py --check, its printed output), the sky check's findings with their
# sheets and its coverage map (skyline.py's summary.json), and every solved
# photo beside the model rendered through its camera, the two laid over each
# other (photos.py --sheets) and the sky check's overlay. Writes OUT/index.html
# and OUT/img/, ready to publish as one page. The catalogue's
# skyline.notes ({region: text}) says what a finding turned out to be.
#
# usage: python3 -I page.py CATALOGUE.json CAMERAS.json SKY_DIR SHEETS_DIR GATE.txt OUT_DIR [--kicker TEXT] [--name TEXT]
import datetime, html, json, re, sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None
WIDTH = 1200     # pixels each photo's images are published at
SECTORS = ["top", "upper side", "side", "lower side", "bottom"]
LINE = re.compile(r"^(known|FAILED|unjudged \(a weak camera\)): ((?:edge|point) \S+): (.*)$")


def gate(text):
	# The gate's printed output: ({"failed": [(name, why)], "known": [...],
	# "unjudged": [...]}, its summary line or None)
	rows = {"failed": [], "known": [], "unjudged": []}
	total = None
	for line in text.splitlines():
		m = LINE.match(line)
		if m:
			kind = {"known": "known", "FAILED": "failed"}.get(m.group(1), "unjudged")
			rows[kind].append((m.group(2), m.group(3)))
		elif line.startswith("gate: "):
			total = line[6:]
	return rows, total


def copy(source, target, width=None):
	# An image as a JPEG, at most width pixels wide
	with Image.open(source) as image:
		image = image.convert("RGB")
		if width and image.width > width:
			image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
		target.parent.mkdir(parents=True, exist_ok=True)
		image.save(target, quality=82)


def signed(value):
	return f"{value:+.1f}"


def coverage(summary):
	# The coverage map: a row per part (the body per sector round its
	# section), a column per 24 in of stations; each cell the median over
	# its photos, shaded by how many judge it, framed where it is a finding
	cells = {(r["family"], r["stretch"], r["sector"]): r for r in summary["regions"]}
	skin = {tuple(k) for k in summary["universe"]} | set(cells)
	stretches = sorted({k[1] for k in skin})
	families = sorted({k[0] for k in skin if k[0] != "body"})
	rows = [("body", sector) for sector in SECTORS if any(k[0] == "body" and k[2] == sector for k in skin)] + [(f, "") for f in families]
	out = ['<div class="scroll"><table class="map"><thead><tr><th scope="col">Part</th>']
	out += [f'<th scope="col">{s}</th>' for s in stretches]
	out.append("</tr></thead><tbody>")
	for family, sector in rows:
		name = f"body, {sector}" if family == "body" else family
		out.append(f'<tr><th scope="row">{html.escape(name)}</th>')
		for s in stretches:
			key = (family, s, sector)
			if key not in skin:
				out.append('<td class="void"></td>')
				continue
			r = cells.get(key)
			if r is None:
				out.append(f'<td class="none" title="{html.escape(key[0])} FS {s}-{s + 24}: no photo">&middot;</td>')
				continue
			n = len(r["photos"])
			kind = "miss" if r["finding"] else "two" if n >= 2 else "one"
			tip = f"{r['region']}: {n} photo{'s' if n > 1 else ''}, " + ", ".join(f"{ph} {signed(m)}" for ph, m in sorted(r["photos"].items()))
			out.append(f'<td class="{kind}" title="{html.escape(tip)}">{signed(r["median"])}</td>')
		out.append("</tr>")
	out.append("</tbody></table></div>")
	return "".join(out)


def build(catalogue, cameras, sky, sheets, gate_text, out, kicker, name):
	out = Path(out)
	img = out / "img"
	summary = json.loads((Path(sky) / "summary.json").read_text())
	rows, total = gate(gate_text)
	regions = summary["regions"]
	fixed = [r for r in regions if r["finding"] and not r["moving"]]
	moving = [r for r in regions if r["finding"] and r["moving"]]
	judged = {(r["family"], r["stretch"], r["sector"]): len(r["photos"]) for r in regions}
	skin = {tuple(k) for k in summary["universe"]} | set(judged)
	two = sum(1 for k in skin if judged.get(k, 0) >= 2)
	one = sum(1 for k in skin if judged.get(k, 0) == 1)
	none = len(skin) - two - one
	weak = [p for p, v in summary["photos"].items() if v["weak"]]
	places = sum(v["judged"] for p, v in summary["photos"].items() if not v["weak"])
	e = html.escape

	parts = [f'''<title>{e(name)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>{STYLE}</style>
<main>
<header class="col">
<div class="kicker">{e(kicker)} &middot; {datetime.date.today().isoformat()}</div>
<h1>{e(name)}</h1>
<p class="lede">The model checked against every solved photo of the real aircraft, rebuilt with each build. The sky check finds the aircraft's own outline wherever sky lies beyond it in a photo and measures the model's against it; the gate holds the hand-traced edges and the measured points to their tolerances. Misses are in inches: + where the model stands outside the photo's outline, &minus; where it falls inside.</p>
<div class="figures"><span><b>{len(summary["photos"]) - len(weak)}</b>photos judging</span><span><b>{len(weak)}</b>weak cameras</span><span><b>{places:,}</b>places measured</span><span><b>{len(fixed)}</b>findings</span><span><b>{len(moving)}</b>on moving surfaces</span><span><b>{two}</b>regions seen twice or more</span><span><b>{one}</b>seen once</span><span><b>{none}</b>never seen</span></div>
</header>
''']

	notes = catalogue.get("skyline", {}).get("notes", {})
	parts.append('<section><h2>Findings</h2>')
	if fixed:
		parts.append('<p class="legend col">Regions of the fixed structure where two or more photos agree the model misses by more than an inch (the median over the photos, two thirds of them on that side). Each sheet shows every photo that judges the region: the model\'s outline in red, a line from it to the photo\'s outline, green within 1 in, yellow within 2.5, magenta beyond.</p><div class="findings">')
		for r in fixed:
			agree = sum(1 for m in r["photos"].values() if (m > 0) == (r["median"] > 0))
			sheet = Path(sky) / f"finding {r['region']}.png"
			target = f"img/finding-{re.sub(r'[^a-z0-9]+', '-', r['region'].lower()).strip('-')}.jpg"
			if sheet.exists():
				copy(sheet, out / target)
			parts.append(f'<figure class="finding"><figcaption><span class="pid">{e(r["region"])}</span> <span class="miss">{signed(r["median"])} in</span><span class="stats">{len(r["photos"])} photos, {agree} on that side, {r["places"]} places</span></figcaption>')
			if r["region"] in notes:
				parts.append(f'<p class="note col">{e(notes[r["region"]])}</p>')
			if sheet.exists():
				parts.append(f'<a href="{target}"><img loading="lazy" src="{target}" alt="Every photo judging {e(r["region"])}"></a>')
			parts.append("</figure>")
		parts.append("</div>")
	else:
		parts.append("<p>No region of the fixed structure misses.</p>")
	if moving:
		parts.append('<h3>On moving surfaces</h3><p class="legend col">These follow each photo\'s pose. The rudders, stabilators, flaps and ailerons are posed from the photos where a fit was kept (poses.py); the gear, canopy and nozzles stand as the catalogue guesses.</p><ul class="moving">')
		parts += [f'<li><span class="pid">{e(r["region"])}</span> {signed(r["median"])} in, {len(r["photos"])} photos' + (f'<br><span class="note">{e(notes[r["region"]])}</span>' if r["region"] in notes else "") + "</li>" for r in moving]
		parts.append("</ul>")
	parts.append("</section>")

	parts.append(f'<section><h2>Coverage</h2><p class="legend col">Each cell is a region of skin: a part, or for the body a sector round its section, across 24 in of stations (the column gives the first). Its number is the median miss over the photos that judge it. Green: two or more photos; amber: one; dot: none, so nothing has checked that region against a photo. Framed red: a finding. Hover a cell for each photo\'s miss.</p>{coverage(summary)}</section>')

	parts.append(f'<section class="col"><h2>Gate</h2><p class="lede">{e(total or "not run")}.</p>')
	for kind, heading in (("failed", "Failed"), ("known", "Known misses")):
		if rows[kind]:
			parts.append(f'<h3>{heading}</h3><div class="scroll"><table><thead><tr><th>Edge or point</th><th>Miss and why</th></tr></thead><tbody>')
			parts += [f'<tr><td class="pid">{e(n)}</td><td class="note">{e(w)}</td></tr>' for n, w in rows[kind]]
			parts.append("</tbody></table></div>")
	parts.append("</section>")

	parts.append('<section><h2>Photos against the model</h2><p class="legend col">Each photo (lens distortion removed), the model rendered through the camera solved for it and posed as the aircraft stood, the two laid over each other with the model\'s outline in red, and the sky check. Select an image to open it full size.</p><div class="gallery">')
	for camera in cameras:
		pid = camera["photo"]
		entry = catalogue["photos"].get(pid, {})
		stats = summary["photos"].get(pid, {})
		images = []
		for kind, label in (("photo", "The photo"), ("model", "The model through the same camera"), ("over", "The model laid over the photo")):
			source = Path(sheets) / f"{pid}-{kind}.jpg"
			if source.exists():
				copy(source, img / f"{pid}-{kind}.jpg", WIDTH)
				images.append((f"img/{pid}-{kind}.jpg", label))
		overlay = Path(sky) / f"{pid}.png"
		if overlay.exists():
			copy(overlay, img / f"{pid}-sky.jpg", WIDTH)
			images.append((f"img/{pid}-sky.jpg", "The sky check: the model's outline and the photo's"))
		what = entry.get("shows") or entry.get("what") or ""
		figures = f"fit {camera.get('rms', '?')} px, field {camera.get('field', '?')} deg"
		if stats:
			figures += f", {stats['judged']} of {stats['tried']} places judged"
			if stats.get("median") is not None:
				figures += f", median miss {stats['median']:.2f} in"
		flag = '<span class="chip weak">weak camera</span>' if stats.get("weak") else ""
		parts.append(f'<figure class="sheet" id="{e(pid)}"><figcaption><span class="pid">{e(pid)}</span> {flag}<span class="what">{e(what)}</span><span class="stats">{e(figures)}</span></figcaption><div class="quad">')
		parts += [f'<a href="{src}"><img loading="lazy" src="{src}" alt="{e(label)}, {e(pid)}"></a>' for src, label in images]
		parts.append("</div></figure>")
	parts.append("</div></section></main>")
	out.mkdir(parents=True, exist_ok=True)
	(out / "index.html").write_text("\n".join(parts) + "\n")


STYLE = """
/* Layout: one reading column of findings, a wide coverage map, then a gallery of photo-against-model sheets. Ghost-grey ground after the jet's own paint. */
:root {
	--ground: #e8ebee; --panel: #f6f7f8; --ink: #1d2730; --muted: #5a6670; --rule: #c9d0d6; --accent: #2f5d7c;
	--good: #2f7a4d; --bad: #b4462b; --open: #9a6b12; --good-bg: #dcefe3; --bad-bg: #f6dfd7; --open-bg: #f3e8cf; --void: transparent;
	--display: "Barlow Condensed", "Arial Narrow", sans-serif; --body: "Barlow", "Helvetica Neue", Arial, sans-serif; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
	--ground: #151b20; --panel: #1c242b; --ink: #e2e7ea; --muted: #97a3ac; --rule: #33404a; --accent: #8db8d6;
	--good: #7cc79a; --bad: #ee9a80; --open: #e2bd6a; --good-bg: #1d3427; --bad-bg: #3d2219; --open-bg: #3a2f17; color-scheme: dark } }
:root[data-theme="dark"] {
	--ground: #151b20; --panel: #1c242b; --ink: #e2e7ea; --muted: #97a3ac; --rule: #33404a; --accent: #8db8d6;
	--good: #7cc79a; --bad: #ee9a80; --open: #e2bd6a; --good-bg: #1d3427; --bad-bg: #3d2219; --open-bg: #3a2f17; color-scheme: dark }
body { background: var(--ground); color: var(--ink); font: 16px/1.55 var(--body); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 28px 64px; }
main { max-width: 1180px; margin: 0 auto; display: grid; gap: 40px; }
main > * { min-width: 0; }
.col { max-width: 760px; }
h1, h2, h3 { font-family: var(--display); font-weight: 600; letter-spacing: 0.01em; text-wrap: balance; margin: 0; }
h1 { font-size: clamp(2.1rem, 5vw, 3rem); line-height: 1.05; }
h2 { font-size: 1.6rem; margin-bottom: 12px; }
h3 { font-size: 1.2rem; margin: 18px 0 8px; }
.kicker { font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
p { margin: 0 0 10px; }
.lede { font-size: 1.08rem; }
.legend { font-size: 0.9rem; color: var(--muted); }
.figures { display: flex; flex-wrap: wrap; gap: 12px 28px; margin-top: 16px; font-family: var(--mono); font-size: 0.86rem; color: var(--muted); }
.figures b { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; font-size: 1.05rem; margin-right: 4px; }
table { border-collapse: collapse; width: 100%; font-size: 0.93rem; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; }
th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--rule); }
thead th { font-family: var(--mono); font-size: 0.74rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
td.note { color: var(--muted); min-width: 16rem; }
.pid { font-family: var(--mono); font-weight: 500; overflow-wrap: anywhere; }
.what { color: var(--muted); }
.stats { font-family: var(--mono); font-size: 0.8rem; color: var(--muted); margin-left: auto; }
.miss { font-family: var(--mono); color: var(--bad); font-variant-numeric: tabular-nums; }
.chip { display: inline-block; font-family: var(--mono); font-size: 0.74rem; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.chip.weak { color: var(--open); background: var(--open-bg); }
.findings { display: grid; gap: 22px; margin-top: 8px; }
.finding, .sheet { margin: 0; border-top: 1px solid var(--rule); padding-top: 12px; }
.finding figcaption, .sheet figcaption { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; margin-bottom: 8px; }
.finding img, .quad img { display: block; width: 100%; height: auto; border-radius: 4px; background: var(--panel); }
.finding .note { color: var(--muted); font-size: 0.95rem; }
.moving { padding-left: 20px; }
.moving li { margin-bottom: 4px; }
.map { width: auto; font-family: var(--mono); font-size: 0.72rem; font-variant-numeric: tabular-nums; }
.map th, .map td { padding: 3px 5px; border: 1px solid var(--rule); text-align: center; white-space: nowrap; }
.map tbody th { text-align: left; font-family: var(--body); font-size: 0.82rem; color: var(--ink); font-weight: 500; }
.map td.void { background: var(--void); border-color: transparent; }
.map td.none { color: var(--muted); }
.map td.one { background: var(--open-bg); color: var(--open); }
.map td.two { background: var(--good-bg); color: var(--good); }
.map td.miss { background: var(--bad-bg); color: var(--bad); font-weight: 500; outline: 2px solid var(--bad); outline-offset: -2px; }
.gallery { display: grid; gap: 22px; }
.quad { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
a { color: var(--accent); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 640px) { .quad { grid-template-columns: 1fr; } .stats { margin-left: 0; } }
"""


def main():
	args, flags = [], {}
	argv = sys.argv[1:]
	while argv:
		a = argv.pop(0)
		if a in ("--kicker", "--name"):
			flags[a[2:]] = argv.pop(0)
		else:
			args.append(a)
	catalogue, cameras, sky, sheets, gate_file, out = args
	build(json.loads(Path(catalogue).read_text()), json.loads(Path(cameras).read_text()), sky, sheets, Path(gate_file).read_text(), out,
		flags.get("kicker", "Shape review"), flags.get("name", "Shape review"))


if __name__ == "__main__":
	main()
