# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Checks that every fact in facts.json stands on its source: each entry's quote
# must appear in the fetched copy of the reference it names (references/, see
# fetch.py), and every source it names must be in references.json. A host that
# answers a block page in place of the document fails here, since the quote is
# not in it. Text is compared with whitespace, quote marks and dashes folded.
#
# usage: python3 -I sources.py   (exits non-zero on any failure)
import html, json, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "references"
FOLD = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " "})


def fold(text):
	return re.sub(r"\s+", " ", text.translate(FOLD)).strip().lower()


def texts(path):
	# The file's text, in each reading a quote may be found in
	if path.suffix == ".pdf":
		# Reading order keeps a two-column page's sentences whole; -layout
		# keeps a table's rows whole, which reading order splits by column
		readings = []
		for flags in ([], ["-layout"]):
			out = subprocess.run(["pdftotext", *flags, str(path), "-"], capture_output=True, check=True)
			readings.append(out.stdout.decode("utf-8", "replace"))
		return readings
	raw = path.read_text("utf-8", "replace")
	raw = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", raw)
	return [html.unescape(re.sub(r"<[^>]+>", " ", raw))]


def entries(node, path=()):
	# every dict with a source and a quote, with its path in the file
	if isinstance(node, dict):
		if "source" in node and "quote" in node:
			yield path, node
		for key, value in node.items():
			yield from entries(value, path + (key,))
	elif isinstance(node, list):
		for index, value in enumerate(node):
			yield from entries(value, path + (str(index),))


def check(references, facts, cache):
	# the facts checked and the failures, one line each
	known = {r["id"]: r for r in references}
	read, failures, count = {}, [], 0
	for path, entry in entries(facts):
		count += 1
		name = ".".join(path)
		reference = known.get(entry["source"])
		if not reference:
			failures.append(f"{name}: source {entry['source']} is not in references.json")
			continue
		file = cache / reference["file"]
		if not file.exists():
			failures.append(f"{name}: {reference['file']} not fetched (run fetch.py)")
			continue
		if file not in read:
			read[file] = [fold(t) for t in texts(file)]
		if not any(fold(entry["quote"]) in t for t in read[file]):
			failures.append(f"{name}: \"{entry['quote']}\" not found in {reference['file']}")
	return count, failures


def main():
	references = json.loads((HERE / "references.json").read_text())["references"]
	facts = json.loads((HERE / "facts.json").read_text())
	count, failures = check(references, facts, CACHE)
	for failure in failures:
		print("FAIL", failure)
	print(f"{count - len(failures)} of {count} facts found in their sources")
	sys.exit(1 if failures else 0)


if __name__ == "__main__":
	main()
