'use strict';

// Minimaler Client fuer https://api.openligadb.de
// Die API liefert camelCase-Felder; einzelne Feldnamen variieren historisch
// leicht (matchID vs. matchId), daher wird defensiv gelesen.

const BASE = process.env.OPENLIGADB_BASE || 'https://api.openligadb.de';

async function apiGet(pathname) {
  const url = `${BASE}${pathname}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`OpenLigaDB ${res.status} fuer ${pathname}`);
  return res.json();
}

// liest ein Feld unabhaengig von der Gross-/Kleinschreibung der API-Version
function pick(obj, ...names) {
  if (!obj) return undefined;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
    const lower = n.toLowerCase();
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === lower && obj[key] !== undefined && obj[key] !== null) {
        return obj[key];
      }
    }
  }
  return undefined;
}

function normalizeTeam(t) {
  if (!t) return null;
  return {
    id: pick(t, 'teamId', 'teamID'),
    name: pick(t, 'teamName') || '',
    shortName: pick(t, 'shortName') || null,
    iconUrl: pick(t, 'teamIconUrl') || null,
  };
}

function normalizeMatch(m) {
  const group = pick(m, 'group') || {};
  const results = pick(m, 'matchResults') || [];
  const goalsRaw = pick(m, 'goals') || [];

  let final = null;
  let halftime = null;
  for (const r of results) {
    const typeId = pick(r, 'resultTypeID', 'resultTypeId');
    const entry = { score1: pick(r, 'pointsTeam1'), score2: pick(r, 'pointsTeam2') };
    if (typeId === 2) final = entry;
    else if (typeId === 1) halftime = entry;
  }

  const goals = goalsRaw
    .map((g) => ({
      id: pick(g, 'goalID', 'goalId'),
      minute: pick(g, 'matchMinute'),
      scorer: pick(g, 'goalGetterName') || null,
      score1: pick(g, 'scoreTeam1'),
      score2: pick(g, 'scoreTeam2'),
      isPenalty: pick(g, 'isPenalty') ? 1 : 0,
      isOwnGoal: pick(g, 'isOwnGoal') ? 1 : 0,
      isOvertime: pick(g, 'isOvertime') ? 1 : 0,
    }))
    .filter((g) => g.id !== undefined);

  // Ohne Endergebnis-Eintrag ergibt sich der Spielstand aus dem letzten Tor
  const lastGoal = goals.length ? goals[goals.length - 1] : null;
  const location = pick(m, 'location');

  return {
    id: pick(m, 'matchID', 'matchId'),
    leagueShortcut: pick(m, 'leagueShortcut') || '',
    season: String(pick(m, 'leagueSeason') || ''),
    matchday: pick(group, 'groupOrderID', 'groupOrderId') ?? null,
    groupName: pick(group, 'groupName') || null,
    team1: normalizeTeam(pick(m, 'team1')),
    team2: normalizeTeam(pick(m, 'team2')),
    kickoffUtc: pick(m, 'matchDateTimeUTC') || pick(m, 'matchDateTime') || null,
    isFinished: pick(m, 'matchIsFinished') ? 1 : 0,
    score1: final ? final.score1 : lastGoal ? lastGoal.score1 : null,
    score2: final ? final.score2 : lastGoal ? lastGoal.score2 : null,
    htScore1: halftime ? halftime.score1 : null,
    htScore2: halftime ? halftime.score2 : null,
    goals,
    location: location ? [pick(location, 'locationCity'), pick(location, 'locationStadium')].filter(Boolean).join(', ') || null : null,
    lastUpdate: pick(m, 'lastUpdateDateTime') || null,
  };
}

async function getMatchdata(league, season, matchday) {
  const suffix = matchday ? `/${matchday}` : '';
  const raw = await apiGet(`/getmatchdata/${encodeURIComponent(league)}/${encodeURIComponent(season)}${suffix}`);
  return (Array.isArray(raw) ? raw : []).map(normalizeMatch).filter((m) => m.id);
}

async function getCurrentGroup(league) {
  const raw = await apiGet(`/getcurrentgroup/${encodeURIComponent(league)}`);
  return pick(raw, 'groupOrderID', 'groupOrderId') ?? null;
}

// Zeitstempel der letzten Datenaenderung eines Spieltags - sehr billiger
// Request, um haeufiges Polling ohne volle Datenabfrage zu ermoeglichen
async function getLastChangeDate(league, season, matchday) {
  const raw = await apiGet(
    `/getlastchangedate/${encodeURIComponent(league)}/${encodeURIComponent(season)}/${encodeURIComponent(matchday)}`
  );
  return typeof raw === 'string' ? raw : String(raw ?? '');
}

// Offizielle Torjaegerliste von OpenLigaDB
async function getGoalGetters(league, season) {
  const raw = await apiGet(`/getgoalgetters/${encodeURIComponent(league)}/${encodeURIComponent(season)}`);
  return (Array.isArray(raw) ? raw : [])
    .map((g) => ({
      name: pick(g, 'goalGetterName') || '',
      team: null,
      goals: pick(g, 'goalCount') || 0,
      penalties: null,
    }))
    .filter((g) => g.name);
}

async function getAvailableLeagues() {
  const raw = await apiGet('/getavailableleagues');
  return (Array.isArray(raw) ? raw : []).map((l) => ({
    id: pick(l, 'leagueId', 'leagueID'),
    name: pick(l, 'leagueName') || '',
    shortcut: pick(l, 'leagueShortcut') || '',
    season: String(pick(l, 'leagueSeason') || ''),
  }));
}

module.exports = { getMatchdata, getCurrentGroup, getLastChangeDate, getAvailableLeagues, getGoalGetters, normalizeMatch };
