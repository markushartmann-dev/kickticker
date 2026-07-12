'use strict';

const { db, getSetting, setSetting } = require('./db');
const olb = require('./openligadb');
const { notifyFavorites } = require('./push');

const LIVE_WINDOW_MS = 2.5 * 60 * 60 * 1000; // Spiel gilt max. 2,5h als "live"

const upsertTeam = db.prepare(`
  INSERT INTO teams (id, name, short_name, icon_url) VALUES (@id, @name, @shortName, @iconUrl)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name,
    short_name = COALESCE(excluded.short_name, teams.short_name),
    icon_url   = COALESCE(excluded.icon_url, teams.icon_url)
`);

const upsertMatch = db.prepare(`
  INSERT INTO matches (id, league_shortcut, season, matchday, group_name, team1_id, team2_id,
                       kickoff_utc, is_finished, is_live, score1, score2, ht_score1, ht_score2, location, last_update)
  VALUES (@id, @leagueShortcut, @season, @matchday, @groupName, @team1Id, @team2Id,
          @kickoffUtc, @isFinished, @isLive, @score1, @score2, @htScore1, @htScore2, @location, @lastUpdate)
  ON CONFLICT(id) DO UPDATE SET
    matchday = excluded.matchday, group_name = excluded.group_name,
    kickoff_utc = excluded.kickoff_utc, is_finished = excluded.is_finished, is_live = excluded.is_live,
    score1 = excluded.score1, score2 = excluded.score2,
    ht_score1 = excluded.ht_score1, ht_score2 = excluded.ht_score2,
    location = excluded.location, last_update = excluded.last_update
`);

const upsertGoal = db.prepare(`
  INSERT INTO goals (id, match_id, minute, scorer, score1, score2, is_penalty, is_own_goal, is_overtime)
  VALUES (@id, @matchId, @minute, @scorer, @score1, @score2, @isPenalty, @isOwnGoal, @isOvertime)
  ON CONFLICT(id) DO NOTHING
`);

const insertEvent = db.prepare(
  'INSERT INTO events (match_id, type, minute, text) VALUES (?, ?, ?, ?)'
);

function isLiveNow(match) {
  if (match.isFinished || !match.kickoffUtc) return false;
  const kickoff = new Date(match.kickoffUtc).getTime();
  const now = Date.now();
  return now >= kickoff && now - kickoff < LIVE_WINDOW_MS;
}

// Vergleicht den neuen API-Stand mit der DB und erzeugt Ereignisse + Push.
// Rueckgabe: Anzahl neuer Ereignisse.
async function processMatch(match, { silent = false } = {}) {
  const prev = db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id);
  const prevGoalIds = new Set(
    db.prepare('SELECT id FROM goals WHERE match_id = ?').all(match.id).map((r) => r.id)
  );

  if (match.team1) upsertTeam.run(match.team1);
  if (match.team2) upsertTeam.run(match.team2);

  const live = isLiveNow(match) ? 1 : 0;
  upsertMatch.run({
    id: match.id,
    leagueShortcut: match.leagueShortcut,
    season: match.season,
    matchday: match.matchday,
    groupName: match.groupName,
    team1Id: match.team1 ? match.team1.id : null,
    team2Id: match.team2 ? match.team2.id : null,
    kickoffUtc: match.kickoffUtc,
    isFinished: match.isFinished,
    isLive: live,
    score1: match.score1,
    score2: match.score2,
    htScore1: match.htScore1,
    htScore2: match.htScore2,
    location: match.location,
    lastUpdate: match.lastUpdate,
  });

  // Beim allerersten Import (prev == null) keine Events/Pushes ausloesen,
  // sonst wuerde jede historische Partie Benachrichtigungen erzeugen.
  const first = !prev || silent;
  const t1 = match.team1 ? match.team1.name : '?';
  const t2 = match.team2 ? match.team2.name : '?';
  const vs = `${t1} – ${t2}`;
  const pending = []; // { type, minute, text, title, body }

  if (!first && !prev.is_live && live && !match.isFinished) {
    pending.push({
      type: 'kickoff', minute: 1,
      text: `Anpfiff: ${vs}`,
      title: '⚽ Anpfiff', body: vs,
    });
  }

  for (const g of match.goals) {
    upsertGoal.run({ ...g, matchId: match.id });
    if (!first && !prevGoalIds.has(g.id)) {
      const score = `${g.score1 ?? '?'}:${g.score2 ?? '?'}`;
      const extra = g.isPenalty ? ' (Elfmeter)' : g.isOwnGoal ? ' (Eigentor)' : '';
      const minute = g.minute != null ? `${g.minute}.'` : '';
      pending.push({
        type: 'goal', minute: g.minute,
        text: `Tor! ${score} ${g.scorer ? 'durch ' + g.scorer : ''}${extra} ${minute}`.trim(),
        title: `⚽ Tor! ${t1} ${score} ${t2}`,
        body: `${g.scorer || 'Torschuetze unbekannt'}${extra}${minute ? ', ' + minute : ''}`,
      });
    }
  }

  if (!first && prev.ht_score1 == null && match.htScore1 != null && !match.isFinished) {
    pending.push({
      type: 'halftime', minute: 45,
      text: `Halbzeit: ${match.htScore1}:${match.htScore2}`,
      title: `⏸️ Halbzeit: ${vs}`, body: `Stand ${match.htScore1}:${match.htScore2}`,
    });
  }

  if (!first && !prev.is_finished && match.isFinished) {
    const score = match.score1 != null ? `${match.score1}:${match.score2}` : '-:-';
    pending.push({
      type: 'fulltime', minute: 90,
      text: `Abpfiff: Endstand ${score}`,
      title: `🏁 Abpfiff: ${vs}`, body: `Endstand ${score}`,
    });
  }

  for (const ev of pending) {
    insertEvent.run(match.id, ev.type, ev.minute ?? null, ev.text);
    await notifyFavorites(
      match.team1 ? match.team1.id : null,
      match.team2 ? match.team2.id : null,
      {
        title: ev.title,
        body: ev.body,
        tag: `match-${match.id}-${ev.type}-${ev.minute ?? 0}`,
        url: `/?match=${match.id}`,
      }
    );
  }
  return pending.length;
}

// Tabelle/Statistik aus beendeten Spielen berechnen (3-Punkte-Regel,
// Sortierung: Punkte, Tordifferenz, geschossene Tore)
function computeStandings(shortcut, season) {
  const rows = db
    .prepare(
      `SELECT team1_id, team2_id, score1, score2 FROM matches
       WHERE league_shortcut = ? AND season = ? AND is_finished = 1
         AND score1 IS NOT NULL AND score2 IS NOT NULL
         AND team1_id IS NOT NULL AND team2_id IS NOT NULL`
    )
    .all(shortcut, season);

  const stats = new Map();
  const get = (teamId) => {
    if (!stats.has(teamId)) {
      stats.set(teamId, { played: 0, won: 0, draw: 0, lost: 0, gf: 0, ga: 0, points: 0 });
    }
    return stats.get(teamId);
  };

  for (const m of rows) {
    const a = get(m.team1_id);
    const b = get(m.team2_id);
    a.played++; b.played++;
    a.gf += m.score1; a.ga += m.score2;
    b.gf += m.score2; b.ga += m.score1;
    if (m.score1 > m.score2) { a.won++; a.points += 3; b.lost++; }
    else if (m.score1 < m.score2) { b.won++; b.points += 3; a.lost++; }
    else { a.draw++; b.draw++; a.points++; b.points++; }
  }

  const table = [...stats.entries()]
    .map(([teamId, s]) => ({ teamId, ...s, diff: s.gf - s.ga }))
    .sort((x, y) => y.points - x.points || y.diff - x.diff || y.gf - x.gf);

  const write = db.transaction(() => {
    db.prepare('DELETE FROM standings WHERE league_shortcut = ? AND season = ?').run(shortcut, season);
    const ins = db.prepare(
      `INSERT INTO standings (league_shortcut, season, team_id, position, played, won, draw, lost,
                              goals_for, goals_against, goal_diff, points, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    table.forEach((t, i) => {
      ins.run(shortcut, season, t.teamId, i + 1, t.played, t.won, t.draw, t.lost, t.gf, t.ga, t.diff, t.points);
    });
  });
  write();
}

// Vollsync einer Liga (ganze Saison). silent unterdrueckt Events/Pushes.
async function fullSyncLeague(shortcut, season, { silent = false } = {}) {
  const matches = await olb.getMatchdata(shortcut, season);
  let events = 0;
  for (const m of matches) events += await processMatch(m, { silent });
  computeStandings(shortcut, season);
  return { matches: matches.length, events };
}

// Schnellsync: nur Spieltage mit Live-/heute-anstehenden Spielen
async function liveSyncLeague(shortcut, season) {
  const rows = db
    .prepare(
      `SELECT DISTINCT matchday FROM matches
       WHERE league_shortcut = ? AND season = ? AND is_finished = 0
         AND kickoff_utc IS NOT NULL
         AND kickoff_utc <= datetime('now', '+15 minutes')
         AND kickoff_utc >= datetime('now', '-4 hours')`
    )
    .all(shortcut, season);
  let events = 0;
  let touched = 0;
  for (const { matchday } of rows) {
    const matches = await olb.getMatchdata(shortcut, season, matchday);
    for (const m of matches) events += await processMatch(m);
    touched += matches.length;
  }
  if (touched) computeStandings(shortcut, season);
  return { matches: touched, events };
}

function getEnabledLeagues() {
  return db.prepare('SELECT * FROM leagues WHERE enabled = 1 ORDER BY sort_order, shortcut').all();
}

let syncRunning = false;

async function tick() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const now = Date.now();
    const lastFull = Number(getSetting('last_full_sync', '0'));
    const fullDue = now - lastFull > 6 * 3600 * 1000;

    for (const league of getEnabledLeagues()) {
      try {
        if (fullDue) {
          const r = await fullSyncLeague(league.shortcut, league.season);
          console.log(`[sync] Vollsync ${league.shortcut}/${league.season}: ${r.matches} Spiele, ${r.events} Ereignisse`);
        } else {
          const r = await liveSyncLeague(league.shortcut, league.season);
          if (r.matches) {
            console.log(`[sync] Livesync ${league.shortcut}/${league.season}: ${r.matches} Spiele, ${r.events} Ereignisse`);
          }
        }
      } catch (err) {
        console.error(`[sync] Fehler bei ${league.shortcut}/${league.season}: ${err.message}`);
      }
    }
    if (fullDue) setSetting('last_full_sync', String(now));
    setSetting('last_sync', new Date().toISOString());
  } finally {
    syncRunning = false;
  }
}

function startScheduler() {
  const interval = Math.max(15, Number(process.env.SYNC_INTERVAL_SECONDS || 60)) * 1000;
  tick().catch((e) => console.error('[sync] Initialer Sync fehlgeschlagen:', e.message));
  setInterval(() => tick().catch((e) => console.error('[sync]', e.message)), interval);
  console.log(`[sync] Scheduler laeuft (alle ${interval / 1000}s, Vollsync alle 6h)`);
}

module.exports = { startScheduler, tick, fullSyncLeague, computeStandings, processMatch };
