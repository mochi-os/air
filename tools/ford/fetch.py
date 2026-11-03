# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Fetches the Ford build's reference files (references.json) into references/,
# which git ignores, and checks each against its recorded hash. A file already
# present with the right hash is kept. Entries without a url are local-only and
# skipped.
#
# The Navy's sites answer only a full set of browser headers, so every request
# sends one. A few government hosts serve certificates signed by the DoD's own
# authority, which the system store lacks: their entries set "insecure", and the
# recorded hash is what vouches for the file.
#
# An image host that answers a page's headers with a web page of its own
# (Reddit's) is asked as a browser asks for a picture: the entry says
# "image": true. A photo's file is refused unless it is a picture, fetched or
# kept, so such a page's hash is never recorded as the photo's.
#
# A web page ("volatile") changes under its own address, so its hash records
# the copy read when the facts were taken from it: a cached copy is kept as it
# is, and a fresh fetch that differs is reported rather than refused. Its facts
# carry the quoted text, which is what they stand on.
#
# usage: python3 -I fetch.py [--record] [ID ...]   (no IDs: every entry)
#   --record  fill in sha256 and bytes for entries that have none yet, writing
#             references.json back; entries with a hash are still checked
import hashlib, json, ssl, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "references.json"
CACHE = HERE / "references"
HEADERS = {
	"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en;q=0.9",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
}
PICTURE = {key: value for key, value in HEADERS.items() if key not in ("Sec-Fetch-User", "Upgrade-Insecure-Requests")}
PICTURE.update({"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors",
	"Sec-Fetch-Site": "cross-site"})
# What a picture's file begins with, by its suffix
SIGNATURES = {".jpg": b"\xff\xd8\xff", ".jpeg": b"\xff\xd8\xff", ".png": b"\x89PNG\r\n\x1a\n"}


def picture(path, suffix):
	# Whether a file meant to be a picture of this suffix is one
	signature = SIGNATURES.get(suffix.lower())
	if signature is None:
		return True
	with open(path, "rb") as f:
		return f.read(len(signature)) == signature


def digest(path):
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for block in iter(lambda: f.read(1 << 20), b""):
			h.update(block)
	return h.hexdigest()


def fetch(entry, record):
	target = CACHE / entry["file"]
	target.parent.mkdir(parents=True, exist_ok=True)
	known = entry.get("sha256")
	volatile = entry.get("volatile", False)
	if target.exists() and known and (volatile or digest(target) == known):
		if not picture(target, target.suffix):
			raise SystemExit(f"{entry['id']}: {entry['file']} is not a picture: its recorded hash vouches for something else")
		return "kept"
	if not known and not record:
		raise SystemExit(f"{entry['id']}: no sha256 recorded (run with --record)")
	request = urllib.request.Request(entry["url"], headers=PICTURE if entry.get("image") else HEADERS)
	context = ssl._create_unverified_context() if entry.get("insecure") else None
	partial = target.with_suffix(target.suffix + ".part")
	with urllib.request.urlopen(request, timeout=300, context=context) as response, open(partial, "wb") as out:
		while block := response.read(1 << 20):
			out.write(block)
	if not picture(partial, target.suffix):
		partial.unlink()
		raise SystemExit(f"{entry['id']}: {entry['url']} answered something other than a picture")
	found = digest(partial)
	if known and found != known:
		if not volatile:
			partial.unlink()
			raise SystemExit(f"{entry['id']}: hash {found} does not match {known}")
		partial.replace(target)
		return f"changed since it was read (now {found})"
	partial.replace(target)
	if not known:
		entry["sha256"] = found
		entry["bytes"] = target.stat().st_size
		return "recorded"
	return "fetched"


def main():
	arguments = sys.argv[1:]
	record = "--record" in arguments
	wanted = {a for a in arguments if a != "--record"}
	manifest = json.loads(MANIFEST.read_text())
	CACHE.mkdir(exist_ok=True)
	changed = False
	try:
		for entry in manifest["references"]:
			if wanted and entry["id"] not in wanted:
				continue
			if not entry.get("url"):
				print(f"{entry['id']}: local only, skipped")
				continue
			result = fetch(entry, record)
			changed = changed or result == "recorded"
			print(f"{entry['id']}: {result}")
	finally:
		if changed:
			MANIFEST.write_text(json.dumps(manifest, indent="\t", ensure_ascii=False) + "\n")


if __name__ == "__main__":
	main()
