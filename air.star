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
	mochi.db.execute("create table if not exists matches (id text not null primary key, world text not null, session text not null, mode text not null, team text not null default '', started integer not null, ended integer not null, reason text not null, players text not null, kills integer not null, deaths integer not null, cheated integer not null default 0, created integer not null, recording text not null default '', size integer not null default 0, pinned integer not null default 0)")
	# A match is identified by where and when it ran; the unique index makes the
	# dedup atomic (insert ... on conflict do nothing) instead of a racy check-
	# then-insert.
	mochi.db.execute("create unique index if not exists matches_replay on matches(world, session, started)")

# attachment_export() -> list | None: the rows core's attachment store held for
# this user and app, each with "file" (stored filename, "" for a remote row) -
# from the transition bridge if core still has one, else core's export file.
# None when the store cannot be read; a missing export file means no rows.
def attachment_export():
	if hasattr(mochi, "attachment") and hasattr(mochi.attachment, "export"):
		rows = mochi.attachment.export()
		if rows == None:
			return None
		result = []
		for row in rows:
			row = dict(row)
			row["file"] = mochi.attachment.path(row["id"]) or ""
			result.append(row)
		return result
	if not mochi.file.exists("attachments.json"):
		return []
	rows = json.decode(str(mochi.file.read("attachments.json") or ""), None)
	if type(rows) != "list":
		return None
	return rows

# database_upgrade(version): schema migrations run on demand at the first
# request after the version bump (app.json "schema").
def database_upgrade(version):
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
			if exported == None:
				mochi.db.abort("attachment store unavailable")
				return
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

def config_load(a):
	if not a.user:
		return {"data": {"config": {}}}
	config = {}
	for row in mochi.db.rows("select name, value from settings"):
		config[row["name"]] = json.decode(row["value"], None)
	return {"data": {"config": config, "name": a.user.identity.name, "identity": a.user.identity.id}}

# config_save() -> {"data": {"saved": bool}}: upsert each posted key (newer `updated` wins; stale writes rejected).
def config_save(a):
	if not a.user:
		return {"data": {"saved": False}}
	# Require a matching identity: a debounced client save firing after an in-place
	# account switch, or before config/load, would otherwise write another
	# account's edits here. Empty is refused too - the client always sends its
	# loaded identity.
	if a.input("identity", "") != a.user.identity.id:
		return {"data": {"saved": False}}
	config = json.decode(a.input("config", ""), None)
	if type(config) != "dict":
		return {"data": {"saved": False}}
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

# match_record() -> {"data": {"stored": bool}}: store this player's own view of a finished multiplayer match.
def match_record(a):
	if not a.user:
		return {"data": {"stored": False}}
	world = a.input("world", "")[:256]
	session = a.input("session", "")[:64]
	if not world or not session:
		return {"data": {"stored": False}}
	# `on conflict do nothing` on the (world, session, started) index is the
	# race-free dedup (#191); whether our own id landed tells the caller if this
	# was the first record.
	started = whole(a, "started")
	id = mochi.uid()
	mochi.db.execute("insert into matches (id, world, session, mode, team, started, ended, reason, players, kills, deaths, cheated, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(world, session, started) do nothing",
		id, world, session, a.input("mode", "")[:32], a.input("team", "")[:16], started, whole(a, "ended"), a.input("reason", "")[:32],
		a.input("players", "")[:1024], whole(a, "kills"), whole(a, "deaths"), whole(a, "cheated"), mochi.time.now())
	stored = mochi.db.exists("select 1 from matches where world = ? and session = ? and started = ? and id = ?", world, session, started, id)
	return {"data": {"stored": stored}}

# match_list() -> {"data": {"matches": [...]}}: this player's recorded multiplayer
# matches, most recent first (capped). The reader the history view was missing.
# Ordered by `started` (an intrinsic integer, so the SQL sort is fine); the
# client formats dates and maps mode/reason to labels.
def match_list(a):
	if not a.user:
		return {"data": {"matches": []}}
	matches = mochi.db.rows("select world, session, mode, team, started, ended, reason, players, kills, deaths, cheated, recording, size, pinned from matches order by started desc limit 50")
	# Totals span every row, not the fifty listed, and include cheated flights (a
	# logbook, not a leaderboard). started/ended are epoch milliseconds, hence /
	# 1000.
	totals = mochi.db.row("select count(*) as flights, sum(ended - started) / 1000 as seconds, sum(kills) as kills, sum(deaths) as deaths, sum(cheated) as cheated from matches")
	return {"data": {"matches": matches, "totals": totals}}

# servers() -> {"data": {"servers": [...]}}: the public world servers hosting
# air, straight from core's world listing. The client sorts and filters - only
# it knows its own flight version.
def servers(a):
	return {"data": {"servers": mochi.world.list("air")}}

# ---- flight recordings (#213) ---- Stored gzipped (~3:1 on ACMI) in file
# storage at "recordings/<match id>" via multipart upload; the client inflates
# on download so the player gets a plain .acmi.

# How many recordings a player keeps, and the byte budget, whichever binds
# first. Age-based expiry was rejected: someone who flies twice a month would
# lose their best fight to a 30-day rule. A pinned recording is exempt.
RECORDINGS_KEPT = 25
RECORDINGS_BYTES = 50 * 1024 * 1024

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
	recordings_prune(row["id"])
	return {"data": {"saved": True}}

# recordings_prune drops the oldest unpinned recordings once either budget is
# exceeded; called after each save. Ordered by `created`, the server's clock -
# started/ended are client-submitted.
def recordings_prune(keep):
	rows = mochi.db.rows("select id, recording, size, pinned from matches where recording != '' order by created desc")
	total = 0
	kept = 0
	for row in rows:
		if row["pinned"]:
			continue   # pinned recordings count against nothing and are never dropped
		kept = kept + 1
		total = total + row["size"]
		if row["id"] == keep:
			continue
		if kept > RECORDINGS_KEPT or total > RECORDINGS_BYTES:
			mochi.file.delete("recordings/" + row["id"])
			mochi.db.execute("update matches set recording = '', size = 0 where id = ?", row["id"])

# recording_pin() -> {"data": {"pinned": bool}}: mark a recording to survive
# pruning, or release it.
def recording_pin(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	session = a.input("session", "")[:64]
	started = whole(a, "started")
	pinned = 1 if a.input("pinned", "") == "true" else 0
	mochi.db.execute("update matches set pinned = ? where session = ? and started = ?", pinned, session, started)
	return {"data": {"pinned": pinned == 1}}

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
