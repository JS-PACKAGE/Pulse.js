import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { OS_FAMILIES } from '../shared/types.ts';

export type Db = Database.Database;

const SYSTEM_GROUP_NAMES: Record<(typeof OS_FAMILIES)[number], string> = {
  'linux-deb': 'Linux-Deb',
  'linux-rpm': 'Linux-RPM',
  macos: 'macOS',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
  -- AUTOINCREMENT: a deleted host's id is never handed out again, so a still-running agent of a
  -- deleted host gets 404 and re-registers instead of reporting into someone else's row.
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname       TEXT    NOT NULL,
  os_family      TEXT    NOT NULL CHECK (os_family IN ('linux-deb','linux-rpm','macos')),
  os_version     TEXT    NOT NULL,
  arch           TEXT    NOT NULL,
  cpu_model      TEXT    NOT NULL,
  gpu_count      INTEGER NOT NULL,
  agent_version  TEXT    NOT NULL,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('ok','alert','offline')),
  status_since   INTEGER NOT NULL,
  last_sample_ts INTEGER,
  UNIQUE (hostname, os_family)
);

CREATE TABLE IF NOT EXISTS metric_samples (
  id               INTEGER PRIMARY KEY,
  host_id          INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  ts               INTEGER NOT NULL,
  cpu_load_percent REAL,
  mem_used_mb      REAL,
  mem_total_mb     REAL,
  disk_used_gb     REAL,
  disk_total_gb    REAL,
  net_rx_kbps      REAL,
  net_tx_kbps      REAL
);
CREATE INDEX IF NOT EXISTS metric_samples_host_ts ON metric_samples (host_id, ts);
CREATE INDEX IF NOT EXISTS metric_samples_ts ON metric_samples (ts);

CREATE TABLE IF NOT EXISTS gpu_samples (
  id           INTEGER PRIMARY KEY,
  host_id      INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  gpu_index    INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  vendor       TEXT    NOT NULL CHECK (vendor IN ('nvidia','amd','apple')),
  util_percent REAL,
  mem_used_mb  REAL,
  mem_total_mb REAL
);
CREATE INDEX IF NOT EXISTS gpu_samples_host_ts ON gpu_samples (host_id, ts);
CREATE INDEX IF NOT EXISTS gpu_samples_ts ON gpu_samples (ts);

-- Latest OS update check per host (reminder only). Its own table so existing databases gain it
-- through CREATE TABLE IF NOT EXISTS without migrating "hosts".
CREATE TABLE IF NOT EXISTS host_updates (
  host_id    INTEGER PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  pending    INTEGER NOT NULL CHECK (pending >= 0),
  security   INTEGER CHECK (security IS NULL OR security BETWEEN 0 AND pending)
);

-- User-chosen display name per host. Its own table so existing databases gain it without migrating
-- "hosts"; re-registration only updates "hosts", so an alias survives agent restarts and upgrades.
CREATE TABLE IF NOT EXISTS host_aliases (
  host_id INTEGER PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  alias   TEXT    NOT NULL
);

-- Group / HostGroup of the data model. "groups" is an SQL keyword, hence the prefix.
CREATE TABLE IF NOT EXISTS host_groups (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('system','custom')),
  os_family TEXT UNIQUE CHECK (os_family IN ('linux-deb','linux-rpm','macos')),
  CHECK ((kind = 'system') = (os_family IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS host_groups_custom_name ON host_groups (name COLLATE NOCASE) WHERE kind = 'custom';

CREATE TABLE IF NOT EXISTS host_group_members (
  host_id  INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES host_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (host_id, group_id)
);
CREATE INDEX IF NOT EXISTS host_group_members_group ON host_group_members (group_id);
`;

export function openDatabase(path: string, busyTimeoutMs: number): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  // `timeout` sets SQLite's busy_timeout (rule 10) without string-built SQL.
  const db = new Database(path, { timeout: busyTimeoutMs });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  // System groups are derived from Host.osFamily and never edited by users.
  const insert = db.prepare(
    `INSERT INTO host_groups (name, kind, os_family) VALUES (?, 'system', ?) ON CONFLICT (os_family) DO NOTHING`,
  );
  for (const family of OS_FAMILIES) insert.run(SYSTEM_GROUP_NAMES[family], family);
  return db;
}
