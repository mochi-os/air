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
	mochi.db.execute("create table if not exists matches (id text not null primary key, world text not null, session text not null, mode text not null, team text not null default '', started integer not null, ended integer not null, reason text not null, players text not null, kills integer not null, deaths integer not null, cheated integer not null default 0, created integer not null, recording text not null default '', recorded integer not null default 0, pinned integer not null default 0)")
	# A match is identified by where and when it ran; the unique index makes the
	# dedup atomic (insert ... on conflict do nothing) instead of a racy check-
	# then-insert.
	mochi.db.execute("create unique index if not exists matches_replay on matches(world, session, started)")

# database_upgrade(version): schema migrations run on demand at the first
# request after the version bump (app.json "schema").
def database_upgrade(version):
	if version == 8 or version == 9:
		# Recordings live in plain file storage at "recordings/<match id>", with
		# the match's own recording/recorded columns as metadata. Relocate any
		# recording still held by the transition bridge and rewrite the marker to
		# the match id; one whose bytes are already gone just clears its marker
		# (recordings are transient). A match already carrying its own id as the
		# marker is skipped, so the step runs at either version.
		rows = mochi.db.rows("select id, recording from matches where recording != ''") or []
		for row in rows:
			if row["recording"] == row["id"]:
				continue
			old = mochi.attachment.path(row["recording"])
			if old:
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
		# Atomic match dedup (#191 review): the check-then-insert could let two
		# concurrent retries both pass the existence check and insert duplicates.
		# Collapse any existing (world, session, started) collisions to the
		# lowest id, then a unique index makes future inserts conflict-safe.
		mochi.db.execute("delete from matches where id not in (select min(id) from matches group by world, session, started)")
		mochi.db.execute("create unique index if not exists matches_replay on matches(world, session, started)")
	if version == 4:
		# Telemetry out of the settings store (#161 review): the CSV rows rode
		# into config_load's wholesale dump, failed json.decode into None, and
		# the next config_save wrote them back as the literal string "null" —
		# destroying the telemetry and junking the config. Surviving rows
		# (still raw CSV) move to their own table; the "null" corpses drop.
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
	# Require a matching identity. A debounced client save that fires after an
	# in-place account switch - or before config/load established the identity -
	# would otherwise write the previous/unknown account's edits into this user's
	# config. Empty is refused too (not just a mismatch): the client always sends
	# its loaded identity and defers saves until it is known, so a missing one is
	# a stale or pre-load save, not a legitimate one.
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

# match_record() -> {"data": {"recorded": bool}}: store this player's own view of a finished multiplayer match.
def match_record(a):
	if not a.user:
		return {"data": {"recorded": False}}
	world = a.input("world", "")[:256]
	session = a.input("session", "")[:64]
	if not world or not session:
		return {"data": {"recorded": False}}
	# Atomic dedup on the (world, session, started) unique index (#191): the old
	# check-then-insert let two concurrent retries both pass and duplicate the
	# row. `on conflict do nothing` is the single, race-free write; whether our
	# own id landed then tells the caller if this was the first record.
	started = whole(a, "started")
	id = mochi.uid()
	mochi.db.execute("insert into matches (id, world, session, mode, team, started, ended, reason, players, kills, deaths, cheated, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(world, session, started) do nothing",
		id, world, session, a.input("mode", "")[:32], a.input("team", "")[:16], started, whole(a, "ended"), a.input("reason", "")[:32],
		a.input("players", "")[:1024], whole(a, "kills"), whole(a, "deaths"), whole(a, "cheated"), mochi.time.now())
	recorded = mochi.db.exists("select 1 from matches where world = ? and session = ? and started = ? and id = ?", world, session, started, id)
	return {"data": {"recorded": recorded}}

# match_list() -> {"data": {"matches": [...]}}: this player's recorded multiplayer
# matches, most recent first (capped). The reader the history view was missing.
# Ordered by `started` (an intrinsic integer, so the SQL sort is fine); the
# client formats dates and maps mode/reason to labels.
def match_list(a):
	if not a.user:
		return {"data": {"matches": []}}
	matches = mochi.db.rows("select world, session, mode, team, started, ended, reason, players, kills, deaths, cheated, recording, recorded, pinned from matches order by started desc limit 50")
	# Totals are aggregated over EVERY row, not the fifty listed: the table is a
	# recent-flights view, the summary is a career. Cheated flights count too —
	# this is the player's own logbook, not a leaderboard, and excluding them
	# just made the summary disagree with the table above it.
	# started/ended are epoch MILLISECONDS (the client stamps them with
	# Date.now), so the duration divides by 1000: summed raw it read 125 hours
	# for an evening's flying.
	totals = mochi.db.row("select count(*) as flights, sum(ended - started) / 1000 as seconds, sum(kills) as kills, sum(deaths) as deaths, sum(cheated) as cheated from matches")
	return {"data": {"matches": matches, "totals": totals}}

# servers() -> {"data": {"servers": [...]}}: the public world servers hosting
# air, for the join page's server list. Pure read of the core world listing
# table (mochi.world.list), which core keeps fresh from local pushes and
# network gossip; this action just forwards it. The client sorts and filters -
# the version compatibility check and players-descending order are its job,
# since only it knows its own flight version.
def servers(a):
	return {"data": {"servers": mochi.world.list("air")}}

# ---- flight recordings (#213) ----
# Recordings are ATTACHMENTS bound to their match row, not rows in a table of
# their own: the attachment system already owns bytes, and its multipart path
# sidesteps the 1 MB non-multipart body cap that a base64 field would hit.
# They are stored gzipped (~3:1 on ACMI, measured) and the client inflates on
# download, so the player still receives a plain .acmi TacView opens.

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
	# match row's own recording/recorded columns are the metadata. recording
	# holds the match id as the "present" marker.
	size = a.upload("recording", "recordings/" + row["id"])
	if not size:
		return {"data": {"saved": False}}
	mochi.db.execute("update matches set recording = ?, recorded = ? where id = ?", row["id"], size, row["id"])
	recordings_prune(row["id"])
	return {"data": {"saved": True}}

# recordings_prune drops the oldest unpinned recordings once either budget is
# exceeded. Called after each save, so the store is self-limiting.
#
# Ordered by `created`, the match's own timestamp - NOT by `recorded`, which is
# the recording's size in bytes and is what the budget below accumulates.
# Sorting by it kept the largest recordings rather than the newest, so the
# budget was spent on whatever happened to be biggest and every short match was
# deleted first. `created` is also the server's own clock, where started/ended
# are submitted by the client, so no client can order the queue in its favour.
def recordings_prune(keep):
	rows = mochi.db.rows("select id, recording, recorded, pinned from matches where recording != '' order by created desc")
	total = 0
	kept = 0
	for row in rows:
		if row["pinned"]:
			continue   # pinned recordings count against nothing and are never dropped
		kept = kept + 1
		total = total + row["recorded"]
		if row["id"] == keep:
			continue
		if kept > RECORDINGS_KEPT or total > RECORDINGS_BYTES:
			mochi.file.delete("recordings/" + row["id"])
			mochi.db.execute("update matches set recording = '', recorded = 0 where id = ?", row["id"])

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

# recording_fetch: serve a stored recording's bytes. The gate IS this action —
# a.write.file performs no access check of its own — so it authorises on a.user
# and binds the recording to a match this player actually owns. (The app DB is
# per-user, so "in my matches table" IS the ownership test.) The recording id is
# the match id; the bytes live at "recordings/<match id>".
def recording_fetch(a):
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	match = a.input("id", "")
	if not mochi.db.exists("select 1 from matches where id = ? and recording != ''", match):
		a.error.label(404, "errors.not_found")   # not one of my flights, or no recording: indistinguishable from absent, deliberately
		return
	a.write.file("recordings/" + match)
