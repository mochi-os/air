# Mochi app: Air
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

# decimal(value) -> bool: whether value is a non-empty ASCII decimal string.
# This is what .isdigit() was reached for, but isdigit() also accepts Unicode
# digit forms (Arabic-Indic "٣", Devanagari "३") that int() rejects,
# which aborts the action as a 500 instead of taking the guard's else branch.
def decimal(value):
    if not value:
        return False
    for c in value.elems():
        if c not in "0123456789":
            return False
    return True
def database_create():
	# Per-key mission/graphics settings for the signed-in user. The app DB is
	# already per-user, so no account column is needed. `updated` versions each
	# key as an LWW-register so writes converge under multi-host replication.
	mochi.db.execute("create table if not exists settings (name text not null primary key, value text not null, updated integer not null)")
	mochi.db.execute("create table if not exists matches (id text not null primary key, world text not null, session text not null, mode text not null, team text not null default '', started integer not null, ended integer not null, reason text not null, players text not null, kills integer not null, deaths integer not null, cheated integer not null default 0, grade text not null default '', remarks text not null default '', wire integer not null default 0, created integer not null, recording text not null default '', size integer not null default 0, title text not null default '')")
	# A match is identified by where and when it ran; the unique index makes the
	# dedup atomic (insert ... on conflict do nothing) instead of a racy check-
	# then-insert.
	mochi.db.execute("create unique index if not exists matches_replay on matches(world, session, started)")
	# The read paths. matches_replay leads on world, which neither of them
	# constrains, so without these SQLite scans the whole table: match_list on
	# every page of the log (scan plus a sort), and the (session, started)
	# lookup on every save. A database with statistics can skip-scan the lookup
	# off matches_replay, but no app database is ever analyzed, so the plan
	# they actually get is the scan.
	mochi.db.execute("create index if not exists matches_started on matches(started)")
	mochi.db.execute("create index if not exists matches_session on matches(session, started)")

# database_upgrade(version): schema migrations run on demand at the first
# request after the version bump (app.json "schema").
def database_upgrade(version):
	if version == 14:
		# Recordings are kept forever (#57): nothing prunes, so the pin that
		# exempted a recording from pruning and the index the prune read go.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "pinned" in columns:
			mochi.db.execute("alter table matches drop column pinned")
		mochi.db.execute("drop index if exists matches_stored")
	if version == 13:
		# The last pass's LSO grade, its write-up and the wire, so the log shows
		# how a sortie ended on the deck; older rows keep ''.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "grade" not in columns:
			mochi.db.execute("alter table matches add column grade text not null default ''")
			mochi.db.execute("alter table matches add column remarks text not null default ''")
			mochi.db.execute("alter table matches add column wire integer not null default 0")
	if version == 12:
		# The server's name as its status gave it when the flight was flown, so
		# the log can show it instead of the address; older rows keep ''.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "title" not in columns:
			mochi.db.execute("alter table matches add column title text not null default ''")
	if version == 11:
		# Index the three read paths, which had scanned since the table was
		# created; see database_create for which query each one serves.
		mochi.db.execute("create index if not exists matches_started on matches(started)")
		mochi.db.execute("create index if not exists matches_session on matches(session, started)")
		mochi.db.execute("create index if not exists matches_stored on matches(created) where recording != ''")
	if version == 10:
		# `recorded` held the recording's size in bytes; rename it to `size`. The
		# branches below keep the old name deliberately: they run on databases that
		# still carry it.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "size" not in columns:
			mochi.db.execute("alter table matches rename column recorded to size")
	if version == 8 or version == 9:
		# Move recordings from core's attachment store to file storage at
		# "recordings/<match id>" and set the marker to the match id. Abort without
		# advancing if the store cannot be read yet; a recording whose bytes are gone
		# clears its marker. Matches already marked with their own id are skipped, so
		# the step runs at either version.
		rows = mochi.db.rows("select id, recording from matches where recording != ''") or []
		files = {}
		if rows:
			exported = attachment_export()
			for att in exported:
				files[att.get("id", "")] = att.get("file", "")
		for row in rows:
			if row["recording"] == row["id"]:
				continue
			old = files.get(row["recording"], "")
			if old and mochi.file.exists(old):
				mochi.file.move(old, "recordings/" + row["id"])
				mochi.db.execute("update matches set recording = ? where id = ?", row["id"], row["id"])
			else:
				mochi.db.execute("update matches set recording = '', recorded = 0 where id = ?", row["id"])
	if version == 7:
		# Flight recordings (#213): the attachment id, its stored size, and the
		# pin that exempts it from pruning.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "recording" not in columns:
			mochi.db.execute("alter table matches add column recording text not null default ''")
		if "recorded" not in columns:
			mochi.db.execute("alter table matches add column recorded integer not null default 0")
		if "pinned" not in columns:
			mochi.db.execute("alter table matches add column pinned integer not null default 0")

	if version == 6:
		# The dev CSV telemetry is gone (#216): the flight recorder now carries
		# the same channels as standard ACMI properties, which TacView graphs,
		# so the table had nothing left to hold. Dropped rather than orphaned.
		mochi.db.execute("drop table if exists telemetry")

	if version == 5:
		# Collapse (world, session, started) collisions to the lowest id so the unique
		# index can be created; it makes match dedup atomic (#191).
		mochi.db.execute("delete from matches where id not in (select min(id) from matches group by world, session, started)")
		mochi.db.execute("create unique index if not exists matches_replay on matches(world, session, started)")
	if version == 4:
		# Telemetry rows move out of the settings store (#161); rows config_save had
		# rewritten as the literal "null" are dropped.
		mochi.db.execute("create table if not exists telemetry (name text not null primary key, value text not null, created integer not null)")
		mochi.db.execute("insert or ignore into telemetry (name, value, created) select name, value, updated from settings where name like 'telemetry%' and value <> 'null'")
		mochi.db.execute("delete from settings where name like 'telemetry%'")
	if version == 3:
		# The teams mode (#130): record which side this player flew.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "team" not in columns:
			mochi.db.execute("alter table matches add column team text not null default ''")
	if version == 2:
		# Mark matches flown with cheats enabled so an honest player's history
		# stays honest. Idempotent via the column check.
		columns = [c["name"] for c in mochi.db.table("matches")]
		if "cheated" not in columns:
			mochi.db.execute("alter table matches add column cheated integer not null default 0")

# What one save may carry. Nothing prunes the settings table and config_load
# decodes every row on every mission-menu open, so an oversized save is
# permanent: core's 1 MB body admits about 80,000 keys. The honest set is 33
# (DEFAULT_CONFIG) with a longest name of 15 characters, so these are far above
# any real client and are a flood ceiling, not a policy on what a setting may be
# called.
SETTINGS_MAXIMUM = 200
SETTINGS_LONGEST = 64

def config_load(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	config = {}
	for row in mochi.db.rows("select name, value from settings"):
		config[row["name"]] = json.decode(row["value"], None)
	return {"data": {"config": config, "name": a.user.identity.name, "identity": a.user.identity.id}}

# config_save() -> {"data": {"saved": bool}}: upsert each posted key (newer `updated` wins; stale writes rejected).
def config_save(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	# Require a matching identity: a debounced client save firing after an in-place
	# account switch, or before config/load, would otherwise write another
	# account's edits here. Empty is refused too - the client always sends its
	# loaded identity. 409, not 403: the caller is allowed to save, but the
	# account it loaded under is no longer the session's.
	if a.input("identity", "") != a.user.identity.id:
		a.error.label(409, "errors.identity_changed")
		return
	config = json.decode(a.input("config", ""), None)
	if type(config) != "dict":
		a.error.label(400, "errors.invalid_request")
		return
	# Refuse the whole save rather than writing the keys that fit: a partial
	# write reported as a success is the worse failure, and no honest client
	# reaches either ceiling.
	if len(config) > SETTINGS_MAXIMUM:
		a.error.label(400, "errors.invalid_request")
		return
	for name in config:
		if len(name) > SETTINGS_LONGEST:
			a.error.label(400, "errors.invalid_request")
			return
	now = mochi.time.now()
	for name in config:
		mochi.db.execute("insert into settings (name, value, updated) values (?, ?, ?) on conflict(name) do update set value = excluded.value, updated = excluded.updated where excluded.updated >= settings.updated", name, json.encode(config[name]), now)
	return {"data": {"saved": True}}

# whole(a, name) -> int: a non-negative numeric input, zero for anything
# malformed. int() on garbage is an unhandled Starlark error (no try/except
# exists), so a buggy client's post would 500 instead of degrading.
def whole(a, name):
	value = a.input(name, "0") or "0"
	return int(value) if decimal(value) else 0

# match_record() -> {"data": {"stored": bool}}: store this player's own view of a flight or match.
def match_record(a):
	if not a.user:
		a.error.label(401, "errors.not_logged_in")
		return
	world = a.input("world", "")[:256]
	title = a.input("title", "")[:128]
	session = a.input("session", "")[:64]
	if not world or not session:
		a.error.label(400, "errors.missing_field")
		return
	# The (world, session, started) index is the race-free dedup (#191): a
	# finished row is never overwritten, and whether our own id landed tells the
	# caller if this was the first record. A row saved while the flight was
	# still flying (reason "flying", #16) is the one exception: the later
	# record, a checkpoint or the finish, takes its place.
	started = whole(a, "started")
	id = mochi.uid()
	mochi.db.execute("insert into matches (id, world, title, session, mode, team, started, ended, reason, players, kills, deaths, cheated, grade, remarks, wire, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(world, session, started) do update set title=excluded.title, mode=excluded.mode, team=excluded.team, ended=excluded.ended, reason=excluded.reason, players=excluded.players, kills=excluded.kills, deaths=excluded.deaths, cheated=excluded.cheated, grade=excluded.grade, remarks=excluded.remarks, wire=excluded.wire where matches.reason='flying'",
		id, world, title, session, a.input("mode", "")[:32], a.input("team", "")[:16], started, whole(a, "ended"), a.input("reason", "")[:32],
		a.input("players", "")[:1024], whole(a, "kills"), whole(a, "deaths"), whole(a, "cheated"), a.input("grade", "")[:16], a.input("remarks", "")[:256], whole(a, "wire"), mochi.time.now())
	stored = mochi.db.exists("select 1 from matches where world = ? and session = ? and started = ? and id = ?", world, session, started, id)
	return {"data": {"stored": stored}}

# match_list() -> {"data": {"matches": [...], "more": bool, "totals": {...}}}:
# this player's flights, most recent first, a page at a time (#57: every
# recording is kept, so the log must reach every flight). `before` and `id`
# are the last row of the page shown, 0 and '' for the first page; ordered by
# `started` (an intrinsic integer, so the SQL sort is fine) and the id where two
# flights share a start. The client formats dates and maps mode/reason to labels.
PAGE = 50
def match_list(a):
	if not a.user:
		a.error.label(401, "errors.not_logged_in")
		return
	before = whole(a, "before")
	id = a.input("id", "")[:64]
	matches = mochi.db.rows("select id, world, title, session, mode, team, started, ended, reason, players, kills, deaths, cheated, grade, remarks, wire, recording, size from matches where ?=0 or started<? or (started=? and id<?) order by started desc, id desc limit ?", before, before, before, id, PAGE + 1) or []
	more = len(matches) > PAGE
	# Totals span every row, not the page listed, and include cheated flights (a
	# logbook, not a leaderboard). started/ended are epoch milliseconds, hence /
	# 1000.
	totals = mochi.db.row("select count(*) as flights, sum(ended - started) / 1000 as seconds, sum(kills) as kills, sum(deaths) as deaths, sum(cheated) as cheated from matches")
	return {"data": {"matches": matches[:PAGE], "more": more, "totals": totals}}

# servers() -> {"data": {"servers": [...]}}: the public world servers hosting
# air, straight from core's world listing. The client sorts and filters - only
# it knows its own flight version.
def servers(a):
	return {"data": {"servers": mochi.world.list("air")}}

# ---- flight recordings (#213) ---- Stored gzipped (~3:1 on ACMI) in file
# storage at "recordings/<match id>" via multipart upload; the client inflates
# on download so the player gets a plain .acmi.

# Every recording is kept (#57): nothing prunes them.

# recording_save() -> {"data": {"saved": bool}}: store the gzipped ACMI for one
# of this player's own matches. Multipart, so the field carries megabytes.
def recording_save(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	session = a.input("session", "")[:64]
	started = whole(a, "started")
	if not session:
		a.error.label(400, "errors.missing_field")
		return
	row = mochi.db.row("select id from matches where session = ? and started = ?", session, started)
	if not row:
		a.error.label(404, "errors.not_found")   # a recording with no flight to hang on is an orphan by construction
		return
	# A match has exactly one recording, so it needs no attachment machinery:
	# the bytes go straight to file storage at "recordings/<match id>", and the
	# match row's own recording/size columns are the metadata. recording
	# holds the match id as the "present" marker.
	size = a.upload("recording", "recordings/" + row["id"])
	if not size:
		return {"data": {"saved": False}}
	mochi.db.execute("update matches set recording = ?, size = ? where id = ?", row["id"], size, row["id"])
	return {"data": {"saved": True}}

# recording_fetch: serve a stored recording's bytes. This action is the gate
# (a.write.file checks nothing): authorise on a.user and require the match in
# this per-user DB. The recording id is the match id.
def recording_fetch(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	match = a.input("id", "")
	if not mochi.db.exists("select 1 from matches where id = ? and recording != ''", match):
		a.error.label(404, "errors.not_found")   # not one of my flights, or no recording: indistinguishable from absent, deliberately
		return
	a.write.file("recordings/" + match)

# ---- feedback ---- The main menu's Feedback posts to the Mochi users
# forum as the player, through the player's own forums app, the way the Help
# app's questions go (help.star): tagged "air" so the forum can group them. A
# self-hosted server that wants its own forum edits FORUM.
FORUM = "126YM4PAEioT47rkAionhLKowZw6kWugijf9AAF6jFtxwRbo1Mo"

# Help's limits, which mirror the forum's, in bytes: the menu counts bytes too,
# so its gate and these agree.
LONGEST = {"title": 500, "body": 50000}
SHORTEST = 20   # the body: stops a one-letter post, lets a short report through

# feedback_check() -> {"data": {"available": bool, "message": str}}: whether the
# forum can take a post, before the player writes a word. app/check is
# read-only: joining the forum waits for a post, so a cancelled dialog leaves
# nothing behind.
def feedback_check(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	result = mochi.remote.request(a.user.identity.id, "forums", "app/check", {"forum": FORUM})
	# The far end's decoded JSON comes back as-is: anything but a dict is a
	# failure to report, not a reply to read.
	if type(result) != "dict":
		return {"data": {"available": False, "message": mochi.app.label("errors.remote_failed")}}
	if result.get("error"):
		if result.get("code", 502) == 504:
			return {"data": {"available": False, "message": mochi.app.label("errors.service_unavailable")}}
		return {"data": {"available": False, "message": mochi.app.label(feedback_error(result))}}
	return {"data": {"available": True}}

# feedback_post() -> {"data": {"redirect": "/forums/<fingerprint>/"}}: post the
# player's feedback, and where the forum is, for the dialog's "Go to forum". The
# post id is minted here, so a retried delivery is one post. It goes to
# moderation before anyone sees it, so the link is to the forum, not the post.
def feedback_post(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	title = a.input("title", "").strip()
	body = a.input("body", "").strip()
	if len(body) < SHORTEST:
		a.error.label(400, "errors.body_is_required")
		return
	if len(body) > LONGEST["body"]:
		a.error.label(400, "errors.body_too_long")
		return
	if not title:
		a.error.label(400, "errors.title_is_required")
		return
	if len(title) > LONGEST["title"]:
		a.error.label(400, "errors.title_too_long")
		return
	result = mochi.remote.request(a.user.identity.id, "forums", "app/post", {
		"id": mochi.uid(),
		"forum": FORUM,
		"title": title,
		"body": body,
		"tags": ["air"],
	})
	if type(result) != "dict":
		a.error.label(502, "errors.remote_failed")
		return
	if result.get("error"):
		code = result.get("code", 502)
		if code == 504:
			a.error.label(503, "errors.service_unavailable")
			return
		# The code is the far end's: held to 4xx/5xx so it cannot make this answer
		# a success or a redirect. JSON numbers decode as floats.
		if type(code) == "float":
			code = int(code)
		if type(code) != "int" or code < 400 or code > 599:
			code = 502
		a.error.label(code, feedback_error(result))
		return
	# The fingerprint is the far end's decoded JSON: mochi.text.valid raises on a
	# non-string, and a bad one must not reach a URL, so it falls back to the
	# forums root as help's does.
	fingerprint = result.get("fingerprint")
	if type(fingerprint) != "string" or not mochi.text.valid(fingerprint, "fingerprint"):
		fingerprint = ""
	return {"data": {"redirect": ("/forums/" + fingerprint + "/") if fingerprint else "/forums/"}}

# feedback_error is the label key to show for the forum's refusal: its own key
# when this app carries a translation of it, else the generic one. A key that
# is not a string, not a safe constant, or unknown here would reach the player
# raw (a label lookup answers a missing key with the key itself).
def feedback_error(result):
	key = result.get("error", "")
	if type(key) != "string" or not mochi.text.valid(key, "constant") or not key.startswith("errors."):
		return "errors.remote_failed"
	if mochi.app.label(key) == key:
		mochi.log.debug("air: no label for the forum's error " + key + ", showing the generic message")
		return "errors.remote_failed"
	return key
