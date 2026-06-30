# Mochi app: Furball
# Copyright © 2026 Mochi OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

def database_create():
	# Per-key mission/graphics settings for the signed-in user. The app DB is
	# already per-user, so no account column is needed. `updated` versions each
	# key as an LWW-register so writes converge under multi-host replication.
	mochi.db.execute("""create table if not exists setting (
		name text not null primary key,
		value text not null,
		updated integer not null
	)""")

def database_upgrade(to_version):
	pass

# config_load() -> {"data": {"config": {name: value, ...}}}: the signed-in user's saved settings.
def config_load(a):
	if not a.user:
		return {"data": {"config": {}}}
	config = {}
	for row in mochi.db.rows("select name, value from setting"):
		config[row["name"]] = json.decode(row["value"], None)
	return {"data": {"config": config}}

# config_save() -> {"data": {"saved": bool}}: upsert each posted key (newer `updated` wins; stale writes rejected).
def config_save(a):
	if not a.user:
		return {"data": {"saved": False}}
	config = json.decode(a.input("config", ""), None)
	if type(config) != "dict":
		return {"data": {"saved": False}}
	now = mochi.time.now()
	for name in config:
		mochi.db.execute("insert into setting (name, value, updated) values (?, ?, ?) on conflict(name) do update set value = excluded.value, updated = excluded.updated where excluded.updated >= setting.updated", name, json.encode(config[name]), now)
	return {"data": {"saved": True}}
