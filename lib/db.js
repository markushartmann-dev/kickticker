'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'liveticker.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  shortcut   TEXT NOT NULL,
  season     TEXT NOT NULL,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  -- Auf-/Abstiegszonen als JSON, z.B.
  -- [{"from":1,"to":2,"type":"promotion","label":"Direkter Aufstieg"}, ...]
  zones      TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shortcut, season)
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  short_name TEXT,
  icon_url   TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id              INTEGER PRIMARY KEY,
  league_shortcut TEXT NOT NULL,
  season          TEXT NOT NULL,
  matchday        INTEGER,
  group_name      TEXT,
  team1_id        INTEGER REFERENCES teams(id),
  team2_id        INTEGER REFERENCES teams(id),
  kickoff_utc     TEXT,
  is_finished     INTEGER NOT NULL DEFAULT 0,
  is_live         INTEGER NOT NULL DEFAULT 0,
  score1          INTEGER,
  score2          INTEGER,
  ht_score1       INTEGER,
  ht_score2       INTEGER,
  location        TEXT,
  last_update     TEXT
);
CREATE INDEX IF NOT EXISTS idx_matches_league ON matches(league_shortcut, season, matchday);
CREATE INDEX IF NOT EXISTS idx_matches_teams  ON matches(team1_id, team2_id);

CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  minute      INTEGER,
  scorer      TEXT,
  score1      INTEGER,
  score2      INTEGER,
  is_penalty  INTEGER NOT NULL DEFAULT 0,
  is_own_goal INTEGER NOT NULL DEFAULT 0,
  is_overtime INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_goals_match ON goals(match_id);

-- Ereignis-Feed: Anpfiff, Tor, Halbzeit, Abpfiff, (Karten sofern Datenquelle sie liefert)
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type       TEXT NOT NULL, -- kickoff | goal | halftime | fulltime | yellow_card | red_card | info
  minute     INTEGER,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id);
CREATE INDEX IF NOT EXISTS idx_events_time  ON events(created_at);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  keys_json  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Im Hintergrund berechnete Team-Statistik / Tabelle
CREATE TABLE IF NOT EXISTS standings (
  league_shortcut TEXT NOT NULL,
  season          TEXT NOT NULL,
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  position        INTEGER NOT NULL,
  played          INTEGER NOT NULL,
  won             INTEGER NOT NULL,
  draw            INTEGER NOT NULL,
  lost            INTEGER NOT NULL,
  goals_for       INTEGER NOT NULL,
  goals_against   INTEGER NOT NULL,
  goal_diff       INTEGER NOT NULL,
  points          INTEGER NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_shortcut, season, team_id)
);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

module.exports = { db, getSetting, setSetting, DATA_DIR };
