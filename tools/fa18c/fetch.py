# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Fetches the F/A-18C build's reference files (references.json) into
# references/, which git ignores, and checks each against its recorded hash.
# A file already present with the right hash is kept. Entries without a url
# (NATOPS) are local-only and skipped.
#
# usage: python3 -I fetch.py [ID ...]   (no IDs: every entry)
import hashlib, json, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "references"
AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"


def digest(path):
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for block in iter(lambda: f.read(1 << 20), b""):
			h.update(block)
	return h.hexdigest()


def fetch(entry):
	target = CACHE / entry["file"]
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
	wanted = set(sys.argv[1:])
	references = json.loads((HERE / "references.json").read_text())["references"]
	CACHE.mkdir(exist_ok=True)
	for entry in references:
		if wanted and entry["id"] not in wanted:
			continue
		if not entry.get("url"):
			print(f"{entry['id']}: local only, skipped")
			continue
		print(f"{entry['id']}: {fetch(entry)}")


if __name__ == "__main__":
	main()
