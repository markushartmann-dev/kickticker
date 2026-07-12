'use strict';

const path = require('path');
const express = require('express');

const { db, getSetting, setSetting } = require('./lib/db');
const auth = require('./lib/auth');
const { initVapid, notifyUser } = require('./lib/push');
const sync = require('./lib/sync');
const olb = require('./lib/openligadb');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------- Bootstrap

auth.ensureAdminUser();
const vapidPublicKey = initVapid();

// Standard-Ligen beim ersten Start anlegen (Saison = Jahr des Saisonbeginns)
function currentSeason() {
  const now = new Date();
  return String(now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1);
}

function seedDefaultLeagues() {
  if (getSetting('leagues_seeded')) return;
  const season = currentSeason();
  const bl1Zones = JSON.stringify([
    { from: 1, to: 1, type: 'champion', label: 'Deutscher Meister / Champions League' },
    { from: 2, to: 4, type: 'promotion', label: 'Champions League' },
    { from: 5, to: 6, type: 'promotion_playoff', label: 'Europa League / Conference League' },
    { from: 16, to: 16, type: 'relegation_playoff', label: 'Relegation' },
    { from: 17, to: 18, type: 'relegation', label: 'Direkter Abstieg' },
  ]);
  // Regel laut Anforderung: Platz 1+2 direkter Aufstieg, Platz 3 Relegation;
  // letzte zwei direkter Abstieg, drittletzter Relegation.
  const lowerZones = (teams) => JSON.stringify([
    { from: 1, to: 2, type: 'promotion', label: 'Direkter Aufstieg' },
    { from: 3, to: 3, type: 'promotion_playoff', label: 'Relegation (Aufstieg)' },
    { from: teams - 2, to: teams - 2, type: 'relegation_playoff', label: 'Relegation (Abstieg)' },
    { from: teams - 1, to: teams, type: 'relegation', label: 'Direkter Abstieg' },
  ]);
  const ins = db.prepare(
    `INSERT INTO leagues (shortcut, season, name, enabled, zones, sort_order)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shortcut, season) DO NOTHING`
  );
  ins.run('bl1', season, '1. Bundesliga', 1, bl1Zones, 1);
  ins.run('bl2', season, '2. Bundesliga', 1, lowerZones(18), 2);
  ins.run('bl3', season, '3. Liga', 1, lowerZones(20), 3);
  setSetting('leagues_seeded', '1');
  console.log(`[init] Standard-Ligen angelegt (Saison ${season})`);
}
seedDefaultLeagues();

// ---------------------------------------------------------------- Public API

app.get('/api/config', (req, res) => {
  const user = auth.getSessionUser(req);
  res.json({
    vapidPublicKey,
    user: user ? { id: user.id, username: user.username, isAdmin: !!user.is_admin } : null,
    lastSync: getSetting('last_sync'),
  });
});

app.get('/api/leagues', (req, res) => {
  const rows = db
    .prepare('SELECT shortcut, season, name, zones, sort_order FROM leagues WHERE enabled = 1 ORDER BY sort_order, shortcut')
    .all();
  res.json(rows.map((r) => ({ ...r, zones: JSON.parse(r.zones || '[]') })));
});

app.get('/api/teams', (req, res) => {
  const { league, season } = req.query;
  let rows;
  if (league && season) {
    rows = db
      .prepare(
        `SELECT DISTINCT t.* FROM teams t
         JOIN matches m ON t.id IN (m.team1_id, m.team2_id)
         WHERE m.league_shortcut = ? AND m.season = ? ORDER BY t.name`
      )
      .all(league, season);
  } else {
    rows = db.prepare('SELECT * FROM teams ORDER BY name').all();
  }
  res.json(rows);
});

const MATCH_SELECT = `
  SELECT m.*, t1.name AS team1_name, t1.short_name AS team1_short, t1.icon_url AS team1_icon,
         t2.name AS team2_name, t2.short_name AS team2_short, t2.icon_url AS team2_icon
  FROM matches m
  LEFT JOIN teams t1 ON t1.id = m.team1_id
  LEFT JOIN teams t2 ON t2.id = m.team2_id`;

// Spieltag-Uebersicht: /api/matches?league=bl1&season=2025&matchday=3&team=40
app.get('/api/matches', (req, res) => {
  const { league, season, matchday, team } = req.query;
  const cond = [];
  const params = [];
  if (league) { cond.push('m.league_shortcut = ?'); params.push(league); }
  if (season) { cond.push('m.season = ?'); params.push(season); }
  if (matchday) { cond.push('m.matchday = ?'); params.push(Number(matchday)); }
  if (team) { cond.push('(m.team1_id = ? OR m.team2_id = ?)'); params.push(Number(team), Number(team)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db
    .prepare(`${MATCH_SELECT} ${where} ORDER BY m.kickoff_utc, m.id LIMIT 500`)
    .all(...params);
  res.json(rows);
});

// Liste der Spieltage einer Liga inkl. kommender
app.get('/api/matchdays', (req, res) => {
  const { league, season } = req.query;
  if (!league || !season) return res.status(400).json({ error: 'league und season erforderlich' });
  const rows = db
    .prepare(
      `SELECT matchday, group_name,
              MIN(kickoff_utc) AS first_kickoff, MAX(kickoff_utc) AS last_kickoff,
              SUM(is_finished) AS finished, COUNT(*) AS total
       FROM matches WHERE league_shortcut = ? AND season = ? AND matchday IS NOT NULL
       GROUP BY matchday, group_name ORDER BY matchday`
    )
    .all(league, season);
  // aktueller Spieltag = erster mit unbeendeten Spielen, sonst letzter
  let current = rows.length ? rows[rows.length - 1].matchday : 1;
  for (const r of rows) {
    if (r.finished < r.total) { current = r.matchday; break; }
  }
  res.json({ matchdays: rows, current });
});

// Live-Ticker: laufende Spiele + Spiele des Tages + juengste Ereignisse
app.get('/api/live', (req, res) => {
  const { league, team } = req.query;
  const cond = ["(m.is_live = 1 OR (date(m.kickoff_utc) = date('now') ))"];
  const params = [];
  if (league) { cond.push('m.league_shortcut = ?'); params.push(league); }
  if (team) { cond.push('(m.team1_id = ? OR m.team2_id = ?)'); params.push(Number(team), Number(team)); }
  const matches = db
    .prepare(`${MATCH_SELECT} WHERE ${cond.join(' AND ')} ORDER BY m.is_live DESC, m.kickoff_utc LIMIT 100`)
    .all(...params);
  const ids = matches.map((m) => m.id);
  let events = [];
  if (ids.length) {
    events = db
      .prepare(
        `SELECT e.*, m.team1_id, m.team2_id FROM events e JOIN matches m ON m.id = e.match_id
         WHERE e.match_id IN (${ids.map(() => '?').join(',')})
         ORDER BY e.created_at DESC, e.id DESC LIMIT 200`
      )
      .all(...ids);
  }
  res.json({ matches, events });
});

app.get('/api/matches/:id', (req, res) => {
  const match = db.prepare(`${MATCH_SELECT} WHERE m.id = ?`).get(Number(req.params.id));
  if (!match) return res.status(404).json({ error: 'Spiel nicht gefunden' });
  const goals = db.prepare('SELECT * FROM goals WHERE match_id = ? ORDER BY minute, id').all(match.id);
  const events = db.prepare('SELECT * FROM events WHERE match_id = ? ORDER BY id').all(match.id);
  res.json({ match, goals, events });
});

// Tabelle inkl. Zonen-Markierung (Aufstieg/Relegation/Abstieg)
app.get('/api/standings', (req, res) => {
  const { league, season } = req.query;
  if (!league || !season) return res.status(400).json({ error: 'league und season erforderlich' });
  const leagueRow = db.prepare('SELECT * FROM leagues WHERE shortcut = ? AND season = ?').get(league, season);
  const rows = db
    .prepare(
      `SELECT s.*, t.name AS team_name, t.short_name AS team_short, t.icon_url AS team_icon
       FROM standings s JOIN teams t ON t.id = s.team_id
       WHERE s.league_shortcut = ? AND s.season = ? ORDER BY s.position`
    )
    .all(league, season);
  const zones = leagueRow ? JSON.parse(leagueRow.zones || '[]') : [];
  const withZone = rows.map((r) => {
    const zone = zones.find((z) => r.position >= z.from && r.position <= z.to) || null;
    return { ...r, zone: zone ? { type: zone.type, label: zone.label } : null };
  });
  res.json({ standings: withZone, zones });
});

// Torschuetzentabelle einer Liga: aus den gespeicherten Toren berechnet.
// Das Team wird pro Tor aus der Spielstand-Aenderung abgeleitet.
app.get('/api/scorers', (req, res) => {
  const { league, season } = req.query;
  if (!league || !season) return res.status(400).json({ error: 'league und season erforderlich' });
  const rows = db
    .prepare(
      `SELECT g.match_id, g.id, g.scorer, g.score1, g.score2, g.is_penalty, g.is_own_goal,
              t1.name AS team1_name, t2.name AS team2_name
       FROM goals g
       JOIN matches m ON m.id = g.match_id
       LEFT JOIN teams t1 ON t1.id = m.team1_id
       LEFT JOIN teams t2 ON t2.id = m.team2_id
       WHERE m.league_shortcut = ? AND m.season = ?
       ORDER BY g.match_id, g.id`
    )
    .all(league, season);

  const byScorer = new Map();
  let prevMatch = null;
  let prev1 = 0;
  let prev2 = 0;
  for (const g of rows) {
    if (g.match_id !== prevMatch) { prevMatch = g.match_id; prev1 = 0; prev2 = 0; }
    const scoredByTeam1 = (g.score1 ?? 0) > prev1;
    prev1 = g.score1 ?? prev1;
    prev2 = g.score2 ?? prev2;
    if (!g.scorer || g.is_own_goal) continue; // Eigentore zaehlen nicht fuer den Schuetzen
    const entry = byScorer.get(g.scorer) || { name: g.scorer, goals: 0, penalties: 0, teams: new Map() };
    entry.goals++;
    if (g.is_penalty) entry.penalties++;
    const teamName = scoredByTeam1 ? g.team1_name : g.team2_name;
    if (teamName) entry.teams.set(teamName, (entry.teams.get(teamName) || 0) + 1);
    byScorer.set(g.scorer, entry);
  }

  const scorers = [...byScorer.values()]
    .map((e) => ({
      name: e.name,
      goals: e.goals,
      penalties: e.penalties,
      team: e.teams.size ? [...e.teams.entries()].sort((a, b) => b[1] - a[1])[0][0] : null,
    }))
    .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name))
    .slice(0, 30)
    .map((e, i) => ({ position: i + 1, ...e }));
  res.json(scorers);
});

// Team-Statistik (Heim/Auswaerts, Form der letzten 5 Spiele)
app.get('/api/teams/:id/stats', (req, res) => {
  const teamId = Number(req.params.id);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Team nicht gefunden' });
  const finished = db
    .prepare(
      `${MATCH_SELECT} WHERE (m.team1_id = ? OR m.team2_id = ?) AND m.is_finished = 1
       AND m.score1 IS NOT NULL ORDER BY m.kickoff_utc DESC LIMIT 50`
    )
    .all(teamId, teamId);
  let home = { played: 0, won: 0, draw: 0, lost: 0, gf: 0, ga: 0 };
  let away = { played: 0, won: 0, draw: 0, lost: 0, gf: 0, ga: 0 };
  const form = [];
  for (const m of finished) {
    const isHome = m.team1_id === teamId;
    const gf = isHome ? m.score1 : m.score2;
    const ga = isHome ? m.score2 : m.score1;
    const bucket = isHome ? home : away;
    bucket.played++; bucket.gf += gf; bucket.ga += ga;
    const result = gf > ga ? 'S' : gf < ga ? 'N' : 'U';
    if (result === 'S') bucket.won++; else if (result === 'N') bucket.lost++; else bucket.draw++;
    if (form.length < 5) form.push(result);
  }
  const standing = db
    .prepare('SELECT * FROM standings WHERE team_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(teamId);
  res.json({ team, home, away, form, standing, recentMatches: finished.slice(0, 10) });
});

// ---------------------------------------------------------------- Auth

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  const user = auth.verifyLogin(username, password);
  if (!user) return res.status(401).json({ error: 'Anmeldung fehlgeschlagen' });
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({ id: user.id, username: user.username, isAdmin: !!user.is_admin });
});

app.post('/api/auth/logout', (req, res) => {
  const user = auth.getSessionUser(req);
  if (user) auth.destroySession(user.token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/password', auth.requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Passwort zu kurz (min. 4 Zeichen)' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Favoriten

app.get('/api/favorites', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.* FROM favorites f JOIN teams t ON t.id = f.team_id
       WHERE f.user_id = ? ORDER BY t.name`
    )
    .all(req.user.id);
  res.json(rows);
});

app.post('/api/favorites/:teamId', auth.requireAuth, (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)) {
    return res.status(404).json({ error: 'Team nicht gefunden' });
  }
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, team_id) VALUES (?, ?)').run(req.user.id, teamId);
  res.json({ ok: true });
});

app.delete('/api/favorites/:teamId', auth.requireAuth, (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND team_id = ?').run(req.user.id, Number(req.params.teamId));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Push

app.post('/api/push/subscribe', auth.requireAuth, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys) return res.status(400).json({ error: 'Ungueltiges Push-Abo' });
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, keys_json) VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json`
  ).run(req.user.id, endpoint, JSON.stringify(keys));
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth.requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

app.post('/api/push/test', auth.requireAuth, async (req, res) => {
  const sent = await notifyUser(req.user.id, {
    title: '🔔 Test-Benachrichtigung',
    body: 'Push funktioniert! Du erhaeltst Meldungen zu deinen Favoriten.',
    tag: 'test',
    url: '/',
  });
  res.json({ ok: true, sent });
});

// ---------------------------------------------------------------- Admin

app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS favorites,
              (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS subscriptions
       FROM users u ORDER BY u.username`
    )
    .all();
  res.json(rows);
});

app.post('/api/admin/users', auth.requireAdmin, (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  try {
    db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(
      username.trim(),
      auth.hashPassword(password),
      isAdmin ? 1 : 0
    );
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }
});

app.patch('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { password, isAdmin } = req.body || {};
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), id);
  if (isAdmin !== undefined) {
    if (!isAdmin && id === req.user.id) return res.status(400).json({ error: 'Eigene Admin-Rechte koennen nicht entzogen werden' });
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Eigener Benutzer kann nicht geloescht werden' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Ereignisanzeige fuer das Adminportal
app.get('/api/admin/events', auth.requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.*, m.league_shortcut, t1.name AS team1_name, t2.name AS team2_name
       FROM events e
       JOIN matches m ON m.id = e.match_id
       LEFT JOIN teams t1 ON t1.id = m.team1_id
       LEFT JOIN teams t2 ON t2.id = m.team2_id
       ORDER BY e.id DESC LIMIT 300`
    )
    .all();
  res.json(rows);
});

app.get('/api/admin/leagues', auth.requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM leagues ORDER BY sort_order, shortcut').all());
});

app.post('/api/admin/leagues', auth.requireAdmin, async (req, res) => {
  const { shortcut, season, name, zones } = req.body || {};
  if (!shortcut || !season || !name) return res.status(400).json({ error: 'shortcut, season und name erforderlich' });
  db.prepare(
    `INSERT INTO leagues (shortcut, season, name, enabled, zones, sort_order)
     VALUES (?, ?, ?, 1, ?, 50)
     ON CONFLICT(shortcut, season) DO UPDATE SET name = excluded.name, enabled = 1`
  ).run(shortcut.trim(), String(season).trim(), name.trim(), JSON.stringify(zones || []));
  // Direkt erste Daten laden (ohne Push-Flut)
  try {
    const r = await sync.fullSyncLeague(shortcut.trim(), String(season).trim(), { silent: true });
    res.json({ ok: true, imported: r.matches });
  } catch (err) {
    res.json({ ok: true, imported: 0, warning: `Liga gespeichert, Erstimport fehlgeschlagen: ${err.message}` });
  }
});

app.patch('/api/admin/leagues/:shortcut/:season', auth.requireAdmin, (req, res) => {
  const { enabled, zones, name, sortOrder } = req.body || {};
  const { shortcut, season } = req.params;
  if (enabled !== undefined) db.prepare('UPDATE leagues SET enabled = ? WHERE shortcut = ? AND season = ?').run(enabled ? 1 : 0, shortcut, season);
  if (zones !== undefined) db.prepare('UPDATE leagues SET zones = ? WHERE shortcut = ? AND season = ?').run(JSON.stringify(zones), shortcut, season);
  if (name) db.prepare('UPDATE leagues SET name = ? WHERE shortcut = ? AND season = ?').run(name, shortcut, season);
  if (sortOrder !== undefined) db.prepare('UPDATE leagues SET sort_order = ? WHERE shortcut = ? AND season = ?').run(Number(sortOrder), shortcut, season);
  res.json({ ok: true });
});

app.delete('/api/admin/leagues/:shortcut/:season', auth.requireAdmin, (req, res) => {
  const { shortcut, season } = req.params;
  db.prepare('DELETE FROM leagues WHERE shortcut = ? AND season = ?').run(shortcut, season);
  res.json({ ok: true });
});

// Verfuegbare Ligen bei OpenLigaDB suchen (z.B. "em", "wm", "uefa")
app.get('/api/admin/available-leagues', auth.requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    let leagues = await olb.getAvailableLeagues();
    if (q) {
      leagues = leagues.filter(
        (l) => l.name.toLowerCase().includes(q) || l.shortcut.toLowerCase().includes(q)
      );
    }
    res.json(leagues.slice(0, 100));
  } catch (err) {
    res.status(502).json({ error: `OpenLigaDB nicht erreichbar: ${err.message}` });
  }
});

app.post('/api/admin/sync', auth.requireAdmin, async (req, res) => {
  try {
    await sync.tick(true); // Vollsync erzwingen
    res.json({ ok: true, lastSync: getSetting('last_sync') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- Static / PWA

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`[server] Fussball-Liveticker laeuft auf Port ${PORT}`);
  if (process.env.DEMO === '1') {
    require('./lib/demo').initDemo().catch((e) => console.error('[demo]', e));
  } else {
    sync.startScheduler();
  }
});
