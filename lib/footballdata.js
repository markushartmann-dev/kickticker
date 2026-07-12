'use strict';

// Client fuer football-data.org (v4). Zweite Datenquelle neben OpenLigaDB:
// bringt die internationalen Top-Wettbewerbe (Premier League, La Liga,
// Serie A, Ligue 1, Champions League, WM, EM, ...) in der Gratis-Stufe.
//
// Gratis-Limits: 12 Wettbewerbe, 10 Anfragen/Minute, Live-Staende leicht
// verzoegert, keine Einzeltor-/Kartendaten (nur Spielstaende + Torjaegerliste).
//
// IDs erhalten Offsets, damit sie nicht mit OpenLigaDB-IDs kollidieren.

const { getSetting } = require('./db');

const BASE = process.env.FOOTBALL_DATA_BASE || 'https://api.football-data.org/v4';
const MATCH_OFFSET = 20_000_000_000;
const TEAM_OFFSET = 2_000_000_000;

function apiKey() {
  // Umgebungsvariable hat Vorrang, sonst der im Adminportal hinterlegte Key
  return process.env.FOOTBALL_DATA_API_KEY || getSetting('football_data_api_key', '') || '';
}

function isConfigured() {
  return !!apiKey();
}

async function apiGet(pathname, params = {}) {
  const url = new URL(`${BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': apiKey(), accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) throw new Error('football-data.org: Anfragelimit erreicht (10/Minute im Gratis-Plan)');
  if (!res.ok) throw new Error(`football-data.org HTTP ${res.status} fuer ${pathname}`);
  return res.json();
}

const LIVE_STATUS = new Set(['IN_PLAY', 'PAUSED']);
const FINISHED_STATUS = new Set(['FINISHED', 'AWARDED']);

// K.o.-Runden hinter den regulaeren Spieltagen einsortieren
const STAGE_ORDER = {
  PLAYOFFS: 93, PLAY_OFFS: 93, LAST_32: 94, LAST_16: 96, ROUND_OF_16: 96,
  QUARTER_FINALS: 97, SEMI_FINALS: 98, THIRD_PLACE: 99, FINAL: 100,
};
const STAGE_NAMES = {
  LAST_32: 'Sechzehntelfinale', LAST_16: 'Achtelfinale', ROUND_OF_16: 'Achtelfinale',
  QUARTER_FINALS: 'Viertelfinale', SEMI_FINALS: 'Halbfinale',
  THIRD_PLACE: 'Spiel um Platz 3', FINAL: 'Finale',
  PLAYOFFS: 'Playoffs', PLAY_OFFS: 'Playoffs',
};

function normalizeTeamRef(t) {
  if (!t || t.id == null) return null;
  return {
    id: TEAM_OFFSET + t.id,
    name: t.name || t.shortName || 'N.N.',
    shortName: t.shortName || t.tla || null,
    iconUrl: t.crest || null,
  };
}

function groupLabel(m) {
  if (m.stage && STAGE_NAMES[m.stage]) return STAGE_NAMES[m.stage];
  if (m.group) return m.group.replace('GROUP_', 'Gruppe ') + (m.matchday ? ` – ${m.matchday}. Spieltag` : '');
  return m.matchday ? `${m.matchday}. Spieltag` : null;
}

function normalizeMatch(m, leagueShortcut, season) {
  const st = m.status || 'SCHEDULED';
  const score = m.score || {};
  const full = score.fullTime || {};
  const half = score.halfTime || {};
  const isKo = m.stage && m.stage !== 'GROUP_STAGE' && m.stage !== 'REGULAR_SEASON';
  return {
    id: MATCH_OFFSET + m.id,
    leagueShortcut,
    season: String(season),
    matchday: isKo ? (STAGE_ORDER[m.stage] || 92) : (m.matchday ?? null),
    groupName: groupLabel(m),
    team1: normalizeTeamRef(m.homeTeam),
    team2: normalizeTeamRef(m.awayTeam),
    kickoffUtc: m.utcDate || null,
    isFinished: FINISHED_STATUS.has(st) ? 1 : 0,
    isLive: LIVE_STATUS.has(st),
    score1: full.home ?? null,
    score2: full.away ?? null,
    htScore1: half.home ?? null,
    htScore2: half.away ?? null,
    goals: [],            // Einzeltore liefert der Gratis-Plan nicht
    synthesizeGoals: true, // -> Tor-Events aus Spielstands-Aenderung ableiten
    location: m.venue || null,
    lastUpdate: m.lastUpdated || null,
  };
}

// Wettbewerbssuche fuers Adminportal (nur die im Gratis-Plan enthaltenen).
async function searchCompetitions(q) {
  const data = await apiGet('/competitions');
  const list = (data.competitions || []).filter((c) => (c.plan || 'TIER_ONE') === 'TIER_ONE');
  const lower = (q || '').toLowerCase();
  return list
    .filter((c) => !lower || c.name.toLowerCase().includes(lower) || (c.code || '').toLowerCase().includes(lower))
    .map((c) => ({
      name: `${c.name}${c.area && c.area.name && c.area.name !== 'World' && c.area.name !== 'Europe' ? ' (' + c.area.name + ')' : ''} [football-data.org]`,
      shortcut: `fd${c.code || c.id}`,
      season: String(c.currentSeason && c.currentSeason.startDate ? c.currentSeason.startDate.slice(0, 4) : new Date().getFullYear()),
    }));
}

async function getSeasonMatches(code, season, leagueShortcut) {
  const data = await apiGet(`/competitions/${encodeURIComponent(code)}/matches`, { season });
  return (data.matches || []).map((m) => normalizeMatch(m, leagueShortcut, season));
}

// Alle heutigen Spiele der freigeschalteten Wettbewerbe in EINEM Request.
// Rueckgabe: Map competitionCode -> normalisierte Spiele.
async function getMatchesAround(codes) {
  const day = 24 * 3600 * 1000;
  const from = new Date(Date.now() - day).toISOString().slice(0, 10);
  const to = new Date(Date.now() + day).toISOString().slice(0, 10);
  const data = await apiGet('/matches', { dateFrom: from, dateTo: to });
  const wanted = new Map(codes.map((c) => [c.code, c]));
  const result = [];
  for (const m of data.matches || []) {
    const code = m.competition && m.competition.code;
    const league = wanted.get(code);
    if (!league) continue;
    result.push(normalizeMatch(m, league.shortcut, league.season));
  }
  return result;
}

async function getTopScorers(code, season) {
  const data = await apiGet(`/competitions/${encodeURIComponent(code)}/scorers`, { season, limit: 30 });
  return (data.scorers || []).map((s) => ({
    name: (s.player && s.player.name) || 'Unbekannt',
    team: (s.team && s.team.name) || null,
    goals: s.goals || 0,
    penalties: s.penalties ?? null,
  }));
}

module.exports = {
  isConfigured,
  searchCompetitions,
  getSeasonMatches,
  getMatchesAround,
  getTopScorers,
  MATCH_OFFSET,
  TEAM_OFFSET,
};
