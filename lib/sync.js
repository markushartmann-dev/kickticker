'use strict';

const { db, getSetting, setSetting } = require('./db');
const olb = require('./openligadb');
const fd = require('./footballdata');
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
// Rueckgabe: Liste der neu erzeugten Ereignisse.
async function processMatch(match, { silent = false } = {}) {
  const prev = db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id);
  const prevGoalIds = new Set(
    db.prepare('SELECT id FROM goals WHERE match_id = ?').all(match.id).map((r) => r.id)
  );

  // Teams ohne ID (K.o.-Spiele mit noch unbekannter Paarung) nicht anlegen
  if (match.team1 && match.team1.id != null) upsertTeam.run(match.team1);
  if (match.team2 && match.team2.id != null) upsertTeam.run(match.team2);

  const live = (match.isLive !== undefined ? !!match.isLive : isLiveNow(match)) ? 1 : 0;
  upsertMatch.run({
    id: match.id,
    leagueShortcut: match.leagueShortcut,
    season: match.season,
    matchday: match.matchday,
    groupName: match.groupName,
    team1Id: match.team1 && match.team1.id != null ? match.team1.id : null,
    team2Id: match.team2 && match.team2.id != null ? match.team2.id : null,
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
  // Ebenso stumm: Spiele, deren Anpfiff Stunden zurueckliegt - dort sind
  // "neue" Tore/Ergebnisse nachtraegliche Datenkorrekturen des Anbieters
  // (sonst gibt es naechtliche Pushes zu laengst beendeten Partien).
  const LONG_OVER_MS = 5 * 3600 * 1000;
  const kickoffMs = match.kickoffUtc ? new Date(match.kickoffUtc).getTime() : null;
  const longOver = kickoffMs != null && Date.now() - kickoffMs > LONG_OVER_MS;
  const first = !prev || silent || longOver;
  const t1 = match.team1 && match.team1.name ? match.team1.name : 'N.N.';
  const t2 = match.team2 && match.team2.name ? match.team2.name : 'N.N.';
  const vs = `${t1} – ${t2}`;
  const pending = []; // { type, minute, text, title, body, noPush }

  if (!first && !prev.is_live && live && !match.isFinished) {
    // Wird der Anpfiff verspaetet bemerkt (Neustart, Ausfall der Quelle),
    // waere eine Erinnerung an ein laengst laufendes Spiel nur stoerend:
    // Ereignis eintragen, aber keine Push-Nachricht mehr verschicken.
    const lateBy = kickoffMs != null ? Date.now() - kickoffMs : 0;
    pending.push({
      type: 'kickoff', minute: 1,
      text: `Anpfiff: ${vs}`,
      title: '⚽ Anpfiff', body: vs,
      noPush: lateBy > 20 * 60 * 1000,
    });
  }

  if (!first && match.synthesizeGoals && !match.goals.length && live) {
    const p1 = prev.score1 ?? 0;
    const p2 = prev.score2 ?? 0;
    if ((match.score1 ?? 0) > p1 || (match.score2 ?? 0) > p2) {
      const score = `${match.score1 ?? 0}:${match.score2 ?? 0}`;
      pending.push({
        type: 'goal', minute: null,
        text: `Tor! Neuer Spielstand ${score}`,
        title: `⚽ Tor! ${t1} ${score} ${t2}`,
        body: `Neuer Spielstand ${score}`,
      });
    }
  }

  // Tor -> Mannschaft zuordnen: das Team, dessen Spalte im Spielstand
  // hochzaehlt (bei Eigentoren die Mannschaft, fuer die das Tor zaehlt)
  const goalSides = new Map();
  {
    let p1 = 0;
    let p2 = 0;
    for (const g of [...match.goals].sort((a, b) => ((a.score1 ?? 0) + (a.score2 ?? 0)) - ((b.score1 ?? 0) + (b.score2 ?? 0)))) {
      let side = null;
      if ((g.score1 ?? 0) > p1) side = 1;
      else if ((g.score2 ?? 0) > p2) side = 2;
      if (g.score1 != null) p1 = g.score1;
      if (g.score2 != null) p2 = g.score2;
      goalSides.set(g.id, side);
    }
  }

  for (const g of match.goals) {
    upsertGoal.run({ ...g, matchId: match.id });
    if (!first && !prevGoalIds.has(g.id)) {
      const score = `${g.score1 ?? '?'}:${g.score2 ?? '?'}`;
      const extra = g.isPenalty ? ' (Elfmeter)' : g.isOwnGoal ? ' (Eigentor)' : '';
      const minute = g.minute != null ? `${g.minute}.'` : '';
      const side = goalSides.get(g.id);
      const forTeam = side === 1 ? t1 : side === 2 ? t2 : null;
      pending.push({
        type: 'goal', minute: g.minute,
        text: `Tor${forTeam ? ' für ' + forTeam : ''}! ${score} ${g.scorer ? 'durch ' + g.scorer : ''}${extra} ${minute}`.trim(),
        title: `⚽ Tor${forTeam ? ' für ' + forTeam : ''}! ${t1} ${score} ${t2}`,
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
    if (ev.noPush) continue;
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
  return pending;
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


const replaceTopScorers = db.transaction((shortcut, season, scorers) => {
  db.prepare('DELETE FROM top_scorers WHERE league_shortcut = ? AND season = ?').run(shortcut, season);
  const ins = db.prepare(
    `INSERT INTO top_scorers (league_shortcut, season, name, team, goals, penalties, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  for (const s of scorers) ins.run(shortcut, season, s.name, s.team, s.goals, s.penalties);
});

async function syncTopScorers(league) {
  try {
    const scorers = league.provider === 'footballdata'
      ? await fd.getTopScorers(league.provider_league_id, league.season)
      : await olb.getGoalGetters(league.shortcut, league.season);
    if (scorers.length) replaceTopScorers(league.shortcut, league.season, scorers);
  } catch (err) {
    console.error(`[sync] Torjaegerliste ${league.shortcut}/${league.season}: ${err.message}`);
  }
}

// Vollsync einer Liga (ganze Saison). silent unterdrueckt Events/Pushes.
async function fullSyncLeague(league, { silent = false } = {}) {
  const matches = league.provider === 'footballdata'
    ? await fd.getSeasonMatches(league.provider_league_id, league.season, league.shortcut)
    : await olb.getMatchdata(league.shortcut, league.season);
  let events = 0;
  for (const m of matches) events += (await processMatch(m, { silent })).length;
  computeStandings(league.shortcut, league.season);
  await syncTopScorers(league);
  return { matches: matches.length, events };
}

// Schnellsync OpenLigaDB: nur Spieltage mit Live-/heute-anstehenden Spielen.
// Vor der vollen Datenabfrage wird per getlastchangedate (sehr billiger
// Request) geprueft, ob sich ueberhaupt etwas geaendert hat - so bleibt auch
// haeufiges Polling waehrend Livespielen API-freundlich.
async function liveSyncLeague(shortcut, season) {
  const rows = db
    .prepare(
      `SELECT DISTINCT matchday FROM matches
       WHERE league_shortcut = ? AND season = ? AND is_finished = 0
         AND kickoff_utc IS NOT NULL
         AND datetime(kickoff_utc) <= datetime('now', '+15 minutes')
         AND datetime(kickoff_utc) >= datetime('now', '-4 hours')`
    )
    .all(shortcut, season);
  let events = 0;
  let touched = 0;
  let anyFinished = false;
  for (const { matchday } of rows) {
    // Zeitgesteuerte Uebergaenge (Anpfiff erreicht, Live-Fenster abgelaufen)
    // brauchen eine Verarbeitung auch ohne neue Daten beim Anbieter
    const pendingTransition = db
      .prepare(
        `SELECT COUNT(*) AS c FROM matches
         WHERE league_shortcut = ? AND season = ? AND matchday = ? AND is_finished = 0
           AND ((is_live = 0 AND datetime(kickoff_utc) <= datetime('now') AND datetime(kickoff_utc) >= datetime('now', '-4 hours'))
             OR (is_live = 1 AND datetime(kickoff_utc) < datetime('now', '-150 minutes')))`
      )
      .get(shortcut, season, matchday).c;

    const changeKey = `lastchange_${shortcut}_${season}_${matchday}`;
    let changed = true;
    let lastChange = null;
    if (!pendingTransition) {
      try {
        lastChange = await olb.getLastChangeDate(shortcut, season, matchday);
        changed = !lastChange || lastChange !== getSetting(changeKey, '');
      } catch { /* Endpoint nicht erreichbar -> normal weiter abfragen */ }
    }
    if (!changed) continue;

    const matches = await olb.getMatchdata(shortcut, season, matchday);
    for (const m of matches) {
      const created = await processMatch(m);
      events += created.length;
      if (created.some((e) => e.type === 'fulltime')) anyFinished = true;
    }
    touched += matches.length;
    if (lastChange) setSetting(changeKey, lastChange);
  }
  if (touched) computeStandings(shortcut, season);
  return { matches: touched, events, anyFinished };
}


// Schnellsync football-data.org: ein Sammelrequest fuer alle fd-Ligen
// (Gratis-Limit: 10 Anfragen/Minute)
async function fdLiveSync(leagues) {
  if (!leagues.length) return { matches: 0, events: 0, finishedLeagues: [] };
  const shortcuts = leagues.map((l) => l.shortcut);
  const ph = shortcuts.map(() => '?').join(',');
  const pendingCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM matches
       WHERE league_shortcut IN (${ph})
         AND (is_live = 1 OR (is_finished = 0 AND kickoff_utc IS NOT NULL
              AND datetime(kickoff_utc) <= datetime('now', '+15 minutes')
              AND datetime(kickoff_utc) >= datetime('now', '-4 hours')))`
    )
    .get(...shortcuts).c;
  if (!pendingCount) return { matches: 0, events: 0, finishedLeagues: [] };

  const matches = await fd.getMatchesAround(
    leagues.map((l) => ({ code: l.provider_league_id, shortcut: l.shortcut, season: l.season }))
  );
  let events = 0;
  const finishedLeagues = new Set();
  const touchedLeagues = new Set();
  for (const m of matches) {
    const created = await processMatch(m);
    events += created.length;
    touchedLeagues.add(m.leagueShortcut);
    if (created.some((e) => e.type === 'fulltime')) finishedLeagues.add(m.leagueShortcut);
  }
  for (const shortcut of touchedLeagues) {
    const league = leagues.find((l) => l.shortcut === shortcut);
    if (league) computeStandings(league.shortcut, league.season);
  }
  return { matches: matches.length, events, finishedLeagues: [...finishedLeagues] };
}

function getEnabledLeagues() {
  return db.prepare('SELECT * FROM leagues WHERE enabled = 1 ORDER BY sort_order, shortcut').all();
}

// Saisonwechsel-Automatik (OpenLigaDB): Ist die konfigurierte Saison komplett
// gespielt (oder leer) und die Folgesaison beim Anbieter schon verfuegbar,
// wird die Liga automatisch umgestellt - sonst "verschwinden" beim
// Saisonstart alle aktuellen Spiele, weil noch die Vorsaison abgefragt wird.
async function maybeAdvanceSeason(league) {
  if (league.provider === 'footballdata') return league;
  if (!/^\d{4}$/.test(String(league.season))) return league;

  const { total, unfinished } = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(is_finished = 0) AS unfinished
       FROM matches WHERE league_shortcut = ? AND season = ?`
    )
    .get(league.shortcut, league.season);
  if (total > 0 && unfinished > 0) return league; // Saison laeuft noch

  const next = String(Number(league.season) + 1);
  let nextMatches = [];
  try {
    nextMatches = await olb.getMatchdata(league.shortcut, next);
  } catch { return league; }
  if (!nextMatches.length) return league;

  const existing = db.prepare('SELECT * FROM leagues WHERE shortcut = ? AND season = ?').get(league.shortcut, next);
  if (existing) {
    // Folgesaison wurde schon manuell angelegt -> alte nur deaktivieren
    db.prepare('UPDATE leagues SET enabled = 0 WHERE shortcut = ? AND season = ?').run(league.shortcut, league.season);
    console.log(`[sync] Saison ${league.shortcut}/${league.season} beendet, ${next} ist bereits angelegt`);
    return existing.enabled ? { ...existing } : league;
  }
  db.prepare('UPDATE leagues SET season = ? WHERE shortcut = ? AND season = ?').run(next, league.shortcut, league.season);
  console.log(`[sync] Saisonwechsel: ${league.shortcut} ${league.season} -> ${next} (${nextMatches.length} Spiele verfuegbar)`);
  return { ...league, season: next };
}

let syncRunning = false;

// Vollsync pro Liga alle 2h: holt auch neu angesetzte Spiele (z.B. K.o.-Runden
// bei EM/WM, Nachholspiele), die der Livesync nicht kennen kann.
const FULL_SYNC_MS = 2 * 3600 * 1000;

async function tick(force = false) {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const now = Date.now();
    const leagues = getEnabledLeagues();
    const fdLeagues = leagues.filter((l) => l.provider === 'footballdata');

    for (const league of leagues) {
      const key = `full_sync_${league.shortcut}_${league.season}`;
      const fullDue = force || now - Number(getSetting(key, '0')) > FULL_SYNC_MS;
      try {
        if (fullDue) {
          const current = await maybeAdvanceSeason(league);
          const r = await fullSyncLeague(current);
          setSetting(`full_sync_${current.shortcut}_${current.season}`, String(now));
          console.log(`[sync] Vollsync ${current.shortcut}/${current.season}: ${r.matches} Spiele, ${r.events} Ereignisse`);
        } else if (league.provider !== 'footballdata') {
          const r = await liveSyncLeague(league.shortcut, league.season);
          if (r.matches) {
            console.log(`[sync] Livesync ${league.shortcut}/${league.season}: ${r.matches} Spiele, ${r.events} Ereignisse`);
          }
          if (r.anyFinished) {
            // Nach Abpfiff sofort nachladen: bei Turnieren stehen dann
            // neue Paarungen (Achtelfinale, Viertelfinale, ...) bereit
            const rf = await fullSyncLeague(league);
            setSetting(key, String(now));
            console.log(`[sync] Nachsync ${league.shortcut}/${league.season} nach Spielende: ${rf.matches} Spiele`);
          }
        }
      } catch (err) {
        console.error(`[sync] Fehler bei ${league.shortcut}/${league.season}: ${err.message}`);
      }
    }

    // football-data-Ligen: gemeinsamer Livesync (1 Request)
    try {
      const r = await fdLiveSync(fdLeagues);
      if (r.matches) {
        console.log(`[sync] Livesync football-data: ${r.matches} Spiele, ${r.events} Ereignisse`);
      }
      for (const shortcut of r.finishedLeagues) {
        const league = fdLeagues.find((l) => l.shortcut === shortcut);
        if (league) {
          await fullSyncLeague(league);
          setSetting(`full_sync_${league.shortcut}_${league.season}`, String(Date.now()));
        }
      }
    } catch (err) {
      console.error(`[sync] Fehler football-data-Livesync: ${err.message}`);
    }

    setSetting('last_sync', new Date().toISOString());
  } finally {
    syncRunning = false;
  }
}

// Laufen gerade Spiele (oder stehen kurz bevor)? Dann schneller pollen.
function hasLiveWindow() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM matches
       WHERE is_finished = 0 AND kickoff_utc IS NOT NULL
         AND datetime(kickoff_utc) <= datetime('now', '+15 minutes')
         AND datetime(kickoff_utc) >= datetime('now', '-4 hours')`
    )
    .get().c > 0;
}

function startScheduler() {
  const baseMs = Math.max(15, Number(process.env.SYNC_INTERVAL_SECONDS || 60)) * 1000;
  const liveMs = Math.max(15, Number(process.env.LIVE_SYNC_INTERVAL_SECONDS || 20)) * 1000;
  let fastMode = null;
  let first = true; // beim Start immer Vollsync: zieht u.a. den Saison-Check sofort
  const loop = async () => {
    try {
      await tick(first);
      first = false;
    } catch (e) {
      console.error('[sync]', e.message);
    }
    const fast = hasLiveWindow();
    if (fast !== fastMode) {
      fastMode = fast;
      console.log(fast
        ? `[sync] Livespiele erkannt - schnelles Polling alle ${liveMs / 1000}s`
        : `[sync] Keine Livespiele - normales Intervall alle ${baseMs / 1000}s`);
    }
    setTimeout(loop, fast ? liveMs : baseMs);
  };
  loop();
  console.log(`[sync] Scheduler laeuft (alle ${baseMs / 1000}s, bei Livespielen alle ${liveMs / 1000}s, Vollsync je Liga alle 2h)`);
}

module.exports = { startScheduler, tick, fullSyncLeague, computeStandings, processMatch, syncTopScorers };
