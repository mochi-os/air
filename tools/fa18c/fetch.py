# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Fetches a build's reference files (references.json) into references/ beside
# it, which git ignores, and checks each against its recorded hash. A file
# already present with the right hash is kept. Entries without a url (NATOPS,
# live web pages) are local-only and skipped. The F/A-18C's manifest is the
# default; --catalogue names another (../missiles/references.json).
#
# usage: python3 -I fetch.py [--catalogue PATH] [ID ...]   (no IDs: every entry)
import hashlib, json, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"


def digest(path):
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for block in iter(lambda: f.read(1 << 20), b""):
			h.update(block)
	return h.hexdigest()


def fetch(entry, cache):
	target = cache / entry["file"]
	target.parent.mkdir(parents=True, exist_ok=True)
	if target.exists() and digest(target) == entry["sha256"]:
		return "kept"
	request = urllib.request.Request(entry["url"], headers={"User-Agent": AGENT})
	partial = target.with_suffix(target.suffix + ".part")
	with urllib.request.urlopen(request, timeout=120) as response, open(partial, "wb") as out:
		while block := response.read(1 << 20):
			out.write(block)
	found = digest(partial)
	if found != entry["sha256"]:
		partial.unlink()
		raise SystemExit(f"{entry['id']}: hash {found} does not match {entry['sha256']}")
	partial.replace(target)
	return "fetched"


def main():
	args = sys.argv[1:]
	catalogue = HERE / "references.json"
	if args[:1] == ["--catalogue"]:
		catalogue = Path(args[1]).resolve()
		args = args[2:]
	wanted = set(args)
	cache = catalogue.parent / "references"
	references = json.loads(catalogue.read_text())["references"]
	cache.mkdir(exist_ok=True)
	for entry in references:
		if wanted and entry["id"] not in wanted:
			continue
		if not entry.get("url"):
			print(f"{entry['id']}: local only, skipped")
			continue
		print(f"{entry['id']}: {fetch(entry, cache)}")


if __name__ == "__main__":
	main()
