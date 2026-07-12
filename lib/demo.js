'use strict';

// Demo-Modus (DEMO=1): erzeugt eine Beispiel-Liga mit Teams, gespielten
// Spieltagen und einem simulierten Live-Spiel. Nutzt exakt dieselbe
// Verarbeitungskette wie der echte OpenLigaDB-Sync – damit lassen sich
// Ticker, Tabelle und Push-Benachrichtigungen ohne Internet testen.

const { db } = require('./db');
const { processMatch, computeStandings } = require('./sync');

const TEAMS = [
  { id: 900001, name: 'FC Demo Muenchen', shortName: 'FCD' },
  { id: 900002, name: 'Borussia Beispiel', shortName: 'BOR' },
  { id: 900003, name: 'SV Testhausen', shortName: 'SVT' },
  { id: 900004, name: 'Eintracht Probe', shortName: 'EPR' },
  { id: 900005, name: 'VfL Musterstadt', shortName: 'VFL' },
  { id: 900006, name: '1. FC Platzhalter', shortName: 'FCP' },
];

const SCORERS = ['M. Muster', 'T. Beispiel', 'K. Probe', 'L. Demo', 'J. Vorlage'];
const SEASON = String(new Date().getFullYear());

function baseMatch(id, matchday, team1, team2, kickoff) {
  return {
    id,
    leagueShortcut: 'demo',
    season: SEASON,
    matchday,
    groupName: `${matchday}. Spieltag`,
    team1: { id: team1.id, name: team1.name, shortName: team1.shortName, iconUrl: null },
    team2: { id: team2.id, name: team2.name, shortName: team2.shortName, iconUrl: null },
    kickoffUtc: kickoff.toISOString(),
    isFinished: 0,
    score1: null, score2: null, htScore1: null, htScore2: null,
    goals: [],
    location: 'Demo-Arena',
    lastUpdate: new Date().toISOString(),
  };
}

async function seed() {
  db.prepare(
    `INSERT INTO leagues (shortcut, season, name, enabled, zones, sort_order)
     VALUES ('demo', ?, 'Demo-Liga', 1, ?, 99)
     ON CONFLICT(shortcut, season) DO NOTHING`
  ).run(
    SEASON,
    JSON.stringify([
      { from: 1, to: 2, type: 'promotion', label: 'Direkter Aufstieg' },
      { from: 3, to: 3, type: 'promotion_playoff', label: 'Relegation (Aufstieg)' },
      { from: 4, to: 4, type: 'relegation_playoff', label: 'Relegation (Abstieg)' },
      { from: 5, to: 6, type: 'relegation', label: 'Direkter Abstieg' },
    ])
  );

  // Zwei abgeschlossene Spieltage + ein kommender
  let id = 990001;
  const rng = (n) => Math.floor(Math.random() * n);
  for (let day = 1; day <= 2; day++) {
    const kickoff = new Date(Date.now() - (3 - day) * 7 * 864e5);
    for (let i = 0; i < 3; i++) {
      const m = baseMatch(id++, day, TEAMS[i * 2], TEAMS[i * 2 + 1], kickoff);
      m.isFinished = 1;
      m.score1 = rng(4); m.score2 = rng(4);
      m.htScore1 = Math.min(m.score1, rng(2)); m.htScore2 = Math.min(m.score2, rng(2));
      let s1 = 0, s2 = 0, gid = id * 10;
      while (s1 < m.score1 || s2 < m.score2) {
        if (s1 < m.score1 && (s2 >= m.score2 || rng(2))) s1++; else s2++;
        m.goals.push({
          id: gid++, minute: 5 + rng(85), scorer: SCORERS[rng(SCORERS.length)],
          score1: s1, score2: s2, isPenalty: rng(8) === 0 ? 1 : 0, isOwnGoal: 0, isOvertime: 0,
        });
      }
      m.goals.sort((a, b) => a.minute - b.minute);
      await processMatch(m, { silent: true });
    }
  }

  // Kommender Spieltag (naechste Woche)
  const future = new Date(Date.now() + 7 * 864e5);
  for (let i = 0; i < 3; i++) {
    await processMatch(baseMatch(id++, 4, TEAMS[i], TEAMS[5 - i], future), { silent: true });
  }

  computeStandings('demo', SEASON);
}

// Simuliertes Live-Spiel: Anpfiff kurz nach dem Start, danach regelmaessig
// Tore/Halbzeit/Abpfiff -> loest echte Events & Pushes aus.
function startLiveSimulation() {
  const live = baseMatch(999999, 3, TEAMS[0], TEAMS[1], new Date(Date.now() - 30 * 1000));
  let minute = 0;
  let s1 = 0, s2 = 0, gid = 9999900;
  let halftimeSent = false;

  processMatch(live, { silent: true }).catch(() => {});

  const timer = setInterval(async () => {
    minute += 5;
    live.lastUpdate = new Date().toISOString();
    try {
      if (minute >= 90) {
        live.isFinished = 1;
        live.score1 = s1; live.score2 = s2;
        await processMatch(live);
        clearInterval(timer);
        console.log('[demo] Live-Simulation beendet');
        return;
      }
      if (minute >= 45 && !halftimeSent) {
        halftimeSent = true;
        live.htScore1 = s1; live.htScore2 = s2;
      } else if (Math.random() < 0.45) {
        if (Math.random() < 0.55) s1++; else s2++;
        live.goals.push({
          id: gid++, minute, scorer: SCORERS[Math.floor(Math.random() * SCORERS.length)],
          score1: s1, score2: s2, isPenalty: 0, isOwnGoal: 0, isOvertime: 0,
        });
        live.score1 = s1; live.score2 = s2;
      }
      await processMatch(live);
    } catch (err) {
      console.error('[demo]', err.message);
    }
  }, 20 * 1000);
}

async function initDemo() {
  console.log('[demo] Demo-Modus aktiv: Beispieldaten werden erzeugt');
  await seed();
  startLiveSimulation();
}

module.exports = { initDemo };
