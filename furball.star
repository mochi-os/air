# Mochi app: Furball
# Copyright © 2026 Mochi OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

def database_create():
	# Per-key mission/graphics settings for the signed-in user. The app DB is
	# already per-user, so no account column is needed. `updated` versions each
	# key as an LWW-register so writes converge under multi-host replication.
	mochi.db.execute("create table if not exists settings (name text not null primary key, value text not null, updated integer not null)")
	mochi.db.execute("create table if not exists matches (id text not null primary key, world text not null, session text not null, mode text not null, started integer not null, ended integer not null, reason text not null, players text not null, kills integer not null, deaths integer not null, created integer not null)")

def database_upgrade(to_version):
	if to_version == 2:
		# Self-recorded multiplayer match history: append-only, one row per
		# match from this player's own view (world servers are untrusted; each
		# participant records their own result). uid keys keep it replication-safe.
		mochi.db.execute("create table if not exists matches (id text not null primary key, world text not null, session text not null, mode text not null, started integer not null, ended integer not null, reason text not null, players text not null, kills integer not null, deaths integer not null, created integer not null)")

# config_load() -> {"data": {"config": {name: value, ...}}}: the signed-in user's saved settings.
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

# match_record() -> {"data": {"recorded": bool}}: store this player's own view of a finished multiplayer match.
def match_record(a):
	if not a.user:
		return {"data": {"recorded": False}}
	world = a.input("world", "")[:256]
	session = a.input("session", "")[:64]
	if not world or not session:
		return {"data": {"recorded": False}}
	mochi.db.execute("insert or ignore into matches (id, world, session, mode, started, ended, reason, players, kills, deaths, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		mochi.uid(), world, session, a.input("mode", "")[:32], int(a.input("started", "0") or "0"), int(a.input("ended", "0") or "0"), a.input("reason", "")[:32],
		a.input("players", "")[:1024], int(a.input("kills", "0") or "0"), int(a.input("deaths", "0") or "0"), mochi.time.now())
	return {"data": {"recorded": True}}
