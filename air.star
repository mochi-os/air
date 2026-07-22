# Mochi app: Air
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

def database_create():
	# Per-key mission/graphics settings for the signed-in user. The app DB is
	# already per-user, so no account column is needed. `updated` versions each
	# key as an LWW-register so writes converge under multi-host replication.
	mochi.db.execute("create table if not exists settings (name text not null primary key, value text not null, updated integer not null)")
	mochi.db.execute("create table if not exists matches (id text not null primary key, world text not null, session text not null, mode text not null, team text not null default '', started integer not null, ended integer not null, reason text not null, players text not null, kills integer not null, deaths integer not null, cheated integer not null default 0, created integer not null)")
	# A match is identified by where and when it ran; the unique index makes the
	# dedup atomic (insert ... on conflict do nothing) instead of a racy check-
	# then-insert.
	mochi.db.execute("create unique index if not exists matches_replay on matches(world, session, started)")
	mochi.db.execute("create table if not exists telemetry (name text not null primary key, value text not null, created integer not null)")

# database_upgrade(version): schema migrations run on demand at the first
# request after the version bump (app.json "schema").
def database_upgrade(version):
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
	return {"data": {"config": config, "name": a.user.identity.name}}

# config_save() -> {"data": {"saved": bool}}: upsert each posted key (newer `updated` wins; stale writes rejected).
def config_save(a):
	if not a.user:
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
	return int(value) if value.isdigit() else 0

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

def telemetry_save(a):
	# Development telemetry sink (Shift+T): browser downloads don't work from
	# the sandboxed shell, so the client posts the CSV here instead.
	# Authenticated only — as a public class-level action this ran as the
	# app's FIRST ADMINISTRATOR, so any anonymous caller could write ~1MB
	# rows into the admin's settings table (the public-runs-as-owner trap).
	if not a.user or not a.user.identity.id:
		a.error.label(401, "errors.not_logged_in")
		return
	data = a.input("data", "")[:2000000]
	now = mochi.time.now()
	# A uid key, not "telemetry-" + timestamp: two saves within the same second
	# collided on the primary key and raised an unhandled DB error. `created`
	# still carries the time for ordering.
	name = mochi.uid()
	mochi.db.execute("insert into telemetry (name, value, created) values (?, ?, ?)", name, data, now)
	return {"data": {"name": name, "rows": len(data.split("\n"))}}
