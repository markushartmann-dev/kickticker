'use strict';

/* ============================== State ============================== */
const state = {
  config: null,
  user: null,
  leagues: [],
  league: null,        // aktive Liga {shortcut, season, name, zones}
  team: '',            // Team-Filter (id als String)
  teams: [],
  tab: 'live',
  matchday: null,
  matchdays: [],
  favorites: [],
  tableView: 'standings', // 'standings' | 'scorers'
  newsFavOnly: false,
  pollTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

/* ============================== Theme ============================== */
const THEMES = [
  { id: 'dark', name: 'Dunkel', colors: ['#0f1420', '#4d9fff', '#1c2438'] },
  { id: 'light', name: 'Hell', colors: ['#f4f6fb', '#1d6ff2', '#ffffff'] },
  { id: 'pitch', name: 'Rasen', colors: ['#0c2415', '#ffd23f', '#16402a'] },
  { id: 'retro', name: 'Retro', colors: ['#14100b', '#ff9f1c', '#262017'] },
];

function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('theme', id);
  const meta = $('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}
applyTheme(localStorage.getItem('theme') || 'dark');

/* ============================== Filter-Leiste ============================== */
function renderLeagueChips() {
  const wrap = $('#league-chips');
  wrap.innerHTML =
    `<button class="chip ${!state.league ? 'active' : ''}" data-all="1">Alle</button>` +
    state.leagues
      .map(
        (l) => `<button class="chip ${state.league && l.shortcut === state.league.shortcut && l.season === state.league.season ? 'active' : ''}"
          data-shortcut="${esc(l.shortcut)}" data-season="${esc(l.season)}">${esc(l.name)}</button>`
      )
      .join('');
  wrap.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = async () => {
      state.league = chip.dataset.all
        ? null
        : state.leagues.find((l) => l.shortcut === chip.dataset.shortcut && l.season === chip.dataset.season);
      localStorage.setItem('selectedLeague', state.league ? `${state.league.shortcut}|${state.league.season}` : '');
      state.team = '';
      state.matchday = null;
      state.tableView = 'standings';
      renderLeagueChips();
      await loadTeams();
      renderTab();
    };
  });
}

async function loadTeams() {
  state.teams = state.league
    ? await api(`/api/teams?league=${state.league.shortcut}&season=${state.league.season}`)
    : await api('/api/teams');
  const sel = $('#team-filter');
  sel.innerHTML =
    '<option value="">Alle Mannschaften</option>' +
    state.teams.map((t) => `<option value="${t.id}" ${String(t.id) === state.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}

$('#team-filter').onchange = (e) => {
  state.team = e.target.value;
  renderTab();
};

/* ============================== Spiel-Karte ============================== */
function isFav(teamId) {
  return state.favorites.some((f) => f.id === teamId);
}

function matchCard(m, { showLeague = false } = {}) {
  const live = m.is_live === 1;
  const finished = m.is_finished === 1;
  const score = m.score1 != null ? `${m.score1}:${m.score2}` : '–:–';
  const ht = m.ht_score1 != null ? `(${m.ht_score1}:${m.ht_score2})` : '';
  const status = live
    ? '<span class="badge-live">LIVE</span>'
    : finished ? 'Beendet' : fmtDate(m.kickoff_utc);
  const league = state.leagues.find((l) => l.shortcut === m.league_shortcut);
  return `
  <div class="card match" data-match="${m.id}">
    ${showLeague ? `<div class="match-league-tag" style="grid-column:1/-1">${esc(league ? league.name : m.league_shortcut)} · ${esc(m.group_name || '')}</div>` : ''}
    <div class="match-team">
      ${m.team1_icon ? `<img src="${esc(m.team1_icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span class="team-name">${esc(m.team1_name || 'N.N.')}${isFav(m.team1_id) ? '<span class="fav-star">⭐</span>' : ''}</span>
    </div>
    <div class="match-score">
      <div class="score ${live ? 'live' : ''}">${score}</div>
      <div class="match-meta">${ht} ${status}</div>
    </div>
    <div class="match-team right">
      ${m.team2_icon ? `<img src="${esc(m.team2_icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span class="team-name">${esc(m.team2_name || 'N.N.')}${isFav(m.team2_id) ? '<span class="fav-star">⭐</span>' : ''}</span>
    </div>
  </div>`;
}

function bindMatchCards(root) {
  root.querySelectorAll('[data-match]').forEach((el) => {
    el.onclick = () => openMatchDetail(Number(el.dataset.match));
  });
}

/* ============================== Tab: Live ============================== */
async function renderLive() {
  const params = new URLSearchParams();
  if (state.league) params.set('league', state.league.shortcut);
  if (state.team) params.set('team', state.team);
  const { matches, events } = await api(`/api/live?${params}`);

  $('#live-indicator').classList.toggle('hidden', !matches.some((m) => m.is_live));

  const liveMatches = matches.filter((m) => m.is_live);
  const todayMatches = matches.filter((m) => !m.is_live);

  let html = '';
  if (liveMatches.length) {
    html += '<div class="section-title">🔴 Jetzt live</div>' + liveMatches.map((m) => matchCard(m, { showLeague: true })).join('');
  }
  if (todayMatches.length) {
    html += '<div class="section-title">Heute</div>' + todayMatches.map((m) => matchCard(m, { showLeague: true })).join('');
  }
  if (events.length) {
    html += '<div class="section-title">Ticker</div><div class="card">' +
      events.slice(0, 40).map((e) => eventRow(e)).join('') + '</div>';
  }
  if (!html) {
    html = '<div class="empty">Heute keine Spiele.<br>Schau bei den Spieltagen vorbei 📅</div>';
  }
  view.innerHTML = html;
  bindMatchCards(view);
}

const EVENT_ICONS = { kickoff: '🟢', goal: '⚽', halftime: '⏸️', fulltime: '🏁', yellow_card: '🟨', red_card: '🟥', info: 'ℹ️' };

function eventRow(e) {
  const time = new Date(e.created_at + (e.created_at.includes('Z') ? '' : 'Z'))
    .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `<div class="event-row">
    <span class="event-time">${time}</span>
    <span class="event-ico">${EVENT_ICONS[e.type] || '•'}</span>
    <span class="event-text">${esc(e.text)}</span>
  </div>`;
}

/* ============================== Tab: Spieltage ============================== */
async function renderMatchdays() {
  if (!state.league) { view.innerHTML = '<div class="empty">Bitte oben eine Liga auswählen,<br>um deren Spieltage zu sehen.</div>'; return; }
  const { matchdays, current } = await api(`/api/matchdays?league=${state.league.shortcut}&season=${state.league.season}`);
  state.matchdays = matchdays;
  if (state.matchday == null) state.matchday = current;

  const idx = matchdays.findIndex((d) => d.matchday === state.matchday);
  const day = matchdays[idx];

  const params = new URLSearchParams({ league: state.league.shortcut, season: state.league.season, matchday: state.matchday });
  if (state.team) params.set('team', state.team);
  const matches = await api(`/api/matches?${params}`);

  view.innerHTML = `
    <div class="matchday-nav">
      <button id="md-prev" ${idx <= 0 ? 'disabled' : ''}>‹</button>
      <div class="matchday-label">
        ${esc(day ? day.group_name || `${day.matchday}. Spieltag` : `${state.matchday}. Spieltag`)}
        <small>${day && day.first_kickoff ? fmtDate(day.first_kickoff).split(' ').slice(0, 2).join(' ') : ''} · ${day ? `${day.finished}/${day.total} gespielt` : ''}</small>
      </div>
      <button id="md-next" ${idx >= matchdays.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    ${matches.length ? matches.map((m) => matchCard(m)).join('') : '<div class="empty">Keine Spiele für diesen Spieltag/Filter.</div>'}
  `;
  $('#md-prev').onclick = () => { state.matchday = matchdays[idx - 1].matchday; renderMatchdays(); };
  $('#md-next').onclick = () => { state.matchday = matchdays[idx + 1].matchday; renderMatchdays(); };
  bindMatchCards(view);
}

/* ============================== Tab: Tabelle ============================== */
function tableViewSwitcher() {
  return `<div class="chips" style="margin-bottom:10px">
    <button class="chip ${state.tableView === 'standings' ? 'active' : ''}" data-tv="standings">Tabelle</button>
    <button class="chip ${state.tableView === 'scorers' ? 'active' : ''}" data-tv="scorers">⚽ Torschützen</button>
  </div>`;
}

function bindTableViewSwitcher() {
  view.querySelectorAll('[data-tv]').forEach((b) => {
    b.onclick = () => { state.tableView = b.dataset.tv; renderTable(); };
  });
}

async function renderTable() {
  if (!state.league) { view.innerHTML = '<div class="empty">Bitte oben eine Liga auswählen,<br>um Tabelle und Torschützen zu sehen.</div>'; return; }
  if (state.tableView === 'scorers') return renderScorers();
  const { standings, zones } = await api(`/api/standings?league=${state.league.shortcut}&season=${state.league.season}`);
  if (!standings.length) {
    view.innerHTML = tableViewSwitcher() + '<div class="empty">Noch keine Tabellendaten.<br>Die Tabelle wird nach dem ersten Datenabgleich berechnet.</div>';
    bindTableViewSwitcher();
    return;
  }
  const rows = standings
    .map((s) => `
    <tr class="${s.zone ? 'zone-' + s.zone.type : ''}" data-team="${s.team_id}">
      <td><span class="pos-marker"></span>${s.position}</td>
      <td class="team-cell">${s.team_icon ? `<img src="${esc(s.team_icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${esc(s.team_name)}${isFav(s.team_id) ? ' ⭐' : ''}</td>
      <td>${s.played}</td><td>${s.won}</td><td>${s.draw}</td><td>${s.lost}</td>
      <td>${s.goals_for}:${s.goals_against}</td>
      <td>${s.goal_diff > 0 ? '+' : ''}${s.goal_diff}</td>
      <td class="pts">${s.points}</td>
    </tr>`)
    .join('');
  const legend = zones
    .map((z) => `<div><span class="legend-swatch zone-${esc(z.type)}"></span>${esc(z.label)} (Platz ${z.from}${z.to !== z.from ? '–' + z.to : ''})</div>`)
    .join('');
  view.innerHTML = `
    ${tableViewSwitcher()}
    <div class="table-wrap">
      <table class="standings">
        <thead><tr><th>#</th><th style="text-align:left">Team</th><th>Sp</th><th>S</th><th>U</th><th>N</th><th>Tore</th><th>Diff</th><th>Pkt</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${legend ? `<div class="zone-legend">${legend}</div>` : ''}
  `;
  bindTableViewSwitcher();
  view.querySelectorAll('tr[data-team]').forEach((tr) => {
    tr.onclick = () => openTeamStats(Number(tr.dataset.team));
  });
}

async function renderScorers() {
  const scorers = await api(`/api/scorers?league=${state.league.shortcut}&season=${state.league.season}`);
  if (!scorers.length) {
    view.innerHTML = tableViewSwitcher() + '<div class="empty">Noch keine Torschützen erfasst.</div>';
    bindTableViewSwitcher();
    return;
  }
  const rows = scorers
    .map(
      (s) => `<tr>
      <td>${s.position}</td>
      <td class="team-cell">${esc(s.name)}</td>
      <td class="team-cell">${esc(s.team || '')}</td>
      <td class="pts">${s.goals}</td>
      <td>${s.penalties || ''}</td>
    </tr>`
    )
    .join('');
  view.innerHTML = `
    ${tableViewSwitcher()}
    <div class="table-wrap">
      <table class="standings">
        <thead><tr><th>#</th><th style="text-align:left">Spieler</th><th style="text-align:left">Team</th><th>Tore</th><th>Elfm.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="muted" style="margin-top:8px;padding:0 4px">Eigentore zählen nicht. Quelle: erfasste Tore der Liga in der App-Datenbank.</div>
  `;
  bindTableViewSwitcher();
}

/* ============================== Tab: Favoriten ============================== */
async function renderFavorites() {
  if (!state.user) {
    view.innerHTML = `<div class="empty">Bitte melde dich an, um Favoriten zu speichern und Push-Nachrichten zu erhalten.<br><br>
      <button class="btn" id="fav-login">Anmelden</button></div>`;
    $('#fav-login').onclick = openLoginModal;
    return;
  }
  await refreshFavorites();
  let html = '';
  if (state.favorites.length) {
    html += '<div class="section-title">⭐ Meine Mannschaften</div>';
    html += state.favorites
      .map(
        (t) => `<div class="setting-row">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            ${t.icon_url ? `<img src="${esc(t.icon_url)}" width="24" height="24" onerror="this.remove()">` : '⚽'}
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn secondary" data-stats="${t.id}">📊</button>
            <button class="btn danger" data-unfav="${t.id}">✕</button>
          </div>
        </div>`
      )
      .join('');
  } else {
    html += '<div class="empty">Noch keine Favoriten.<br>Füge unten Mannschaften hinzu – du bekommst dann Push-Nachrichten zu Anpfiff, Toren, Halbzeit und Abpfiff.</div>';
  }
  html += `<div class="section-title">Mannschaft hinzufügen</div>
    <div class="card">
      <select id="fav-add-select" class="team-select">
        <option value="">– Mannschaft wählen –</option>
        ${state.teams.filter((t) => !isFav(t.id)).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
      </select>
      <div class="muted" style="margin-top:8px">Zeigt Mannschaften der aktuell gewählten Liga. Liga oben wechseln, um andere Teams zu finden.</div>
    </div>`;
  view.innerHTML = html;

  $('#fav-add-select').onchange = async (e) => {
    if (!e.target.value) return;
    await api(`/api/favorites/${e.target.value}`, { method: 'POST' });
    toast('Als Favorit gespeichert ⭐');
    renderFavorites();
  };
  view.querySelectorAll('[data-unfav]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/favorites/${b.dataset.unfav}`, { method: 'DELETE' });
      renderFavorites();
    };
  });
  view.querySelectorAll('[data-stats]').forEach((b) => {
    b.onclick = () => openTeamStats(Number(b.dataset.stats));
  });
}

async function refreshFavorites() {
  state.favorites = state.user ? await api('/api/favorites').catch(() => []) : [];
}

/* ============================== Tab: News ============================== */
function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `vor ${Math.max(1, mins)} Min.`;
  if (mins < 1440) return `vor ${Math.round(mins / 60)} Std.`;
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

async function renderNews() {
  const params = new URLSearchParams();
  if (state.league) params.set('league', state.league.shortcut);
  if (state.newsFavOnly && state.user) params.set('favorites', '1');
  const { items, warnings } = await api(`/api/news?${params}`);

  let html = `<div class="chips" style="margin-bottom:10px">
    <button class="chip ${!state.newsFavOnly ? 'active' : ''}" data-nf="0">Alle News</button>
    <button class="chip ${state.newsFavOnly ? 'active' : ''}" data-nf="1" ${!state.user ? 'disabled' : ''}>⭐ Nur Favoriten</button>
  </div>`;
  if (!state.user) html += '<div class="muted" style="margin:0 4px 10px">Für den Favoriten-Filter bitte anmelden.</div>';
  for (const w of warnings || []) html += `<div class="muted" style="margin:0 4px 10px">ℹ️ ${esc(w)}</div>`;

  if (items.length) {
    html += items
      .map(
        (n) => `<a class="card" style="display:block;text-decoration:none;color:inherit" href="${esc(n.link)}" target="_blank" rel="noopener">
        <div style="font-weight:600;line-height:1.35">${esc(n.title)}</div>
        ${n.description ? `<div class="muted" style="margin-top:4px;line-height:1.4">${esc(n.description.slice(0, 140))}${n.description.length > 140 ? '…' : ''}</div>` : ''}
        <div class="muted" style="margin-top:6px;font-size:.7rem">${esc(n.source)} · ${timeAgo(n.date)}</div>
      </a>`
      )
      .join('');
  } else {
    html += '<div class="empty">Keine Meldungen gefunden.</div>';
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-nf]').forEach((b) => {
    b.onclick = () => { state.newsFavOnly = b.dataset.nf === '1'; renderNews(); };
  });
}

/* ============================== Tab: Einstellungen ============================== */
async function renderSettings() {
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
  let pushActive = false;
  if (pushSupported) {
    const reg = await navigator.serviceWorker.getRegistration();
    pushActive = !!(reg && (await reg.pushManager.getSubscription()));
  }

  view.innerHTML = `
    <div class="settings-group">
      <div class="section-title">Konto</div>
      ${state.user
        ? `<div class="setting-row"><div>Angemeldet als <b>${esc(state.user.username)}</b>${state.user.isAdmin ? ' (Admin)' : ''}</div>
             <button class="btn secondary" id="btn-logout">Abmelden</button></div>
           <div class="setting-row"><div>Passwort ändern</div><button class="btn secondary" id="btn-pw">Ändern</button></div>
           ${state.user.isAdmin ? '<div class="setting-row"><div>Adminportal<div class="desc">Benutzer, Ligen & Ereignisse verwalten</div></div><a class="btn" href="/admin">Öffnen</a></div>' : ''}`
        : '<div class="setting-row"><div>Nicht angemeldet<div class="desc">Für Favoriten & Push-Nachrichten</div></div><button class="btn" id="btn-login">Anmelden</button></div>'}
    </div>

    <div class="settings-group">
      <div class="section-title">Push-Benachrichtigungen</div>
      <div class="setting-row">
        <div>Push aktivieren<div class="desc">Tore, Karten, Anpfiff, Halbzeit & Abpfiff deiner Favoriten</div></div>
        <label class="switch"><input type="checkbox" id="push-toggle" ${pushActive ? 'checked' : ''} ${!pushSupported || !state.user ? 'disabled' : ''}><span class="slider"></span></label>
      </div>
      ${!pushSupported ? (location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? '<div class="error-note">Die App läuft über HTTP – Push-Nachrichten und Homescreen-Installation erfordern HTTPS (Reverse Proxy mit Zertifikat, siehe README).</div>'
        : '<div class="error-note">Dieser Browser unterstützt keine Web-Push-Nachrichten. Auf iOS: App zuerst zum Homescreen hinzufügen (iOS 16.4+).</div>') : ''}
      ${pushSupported && !state.user ? '<div class="muted">Zum Aktivieren bitte zuerst anmelden.</div>' : ''}
      ${pushActive ? '<div class="btn-row"><button class="btn secondary" id="push-test">Testnachricht senden</button></div>' : ''}
    </div>

    <div class="settings-group">
      <div class="section-title">Farbschema</div>
      <div class="theme-grid">
        ${THEMES.map(
          (t) => `<button class="theme-tile ${document.documentElement.dataset.theme === t.id ? 'active' : ''}" data-theme-id="${t.id}">
            <div class="theme-preview">${t.colors.map((c) => `<span style="background:${c}"></span>`).join('')}</div>${t.name}</button>`
        ).join('')}
      </div>
    </div>

    <div class="settings-group">
      <div class="section-title">App</div>
      <div class="setting-row"><div>Zum Homescreen hinzufügen<div class="desc">Android: Menü → „App installieren“ · iOS: Teilen → „Zum Home-Bildschirm“</div></div></div>
      <div class="muted" style="padding:0 4px">Letzter Datenabgleich: ${state.config && state.config.lastSync ? fmtDate(state.config.lastSync) : 'unbekannt'} · Datenquelle${state.config && state.config.dataSources && state.config.dataSources.length > 1 ? 'n' : ''}: ${state.config && state.config.dataSources ? state.config.dataSources.join(', ') : 'OpenLigaDB'}</div>
    </div>
  `;

  const loginBtn = $('#btn-login');
  if (loginBtn) loginBtn.onclick = openLoginModal;
  const logoutBtn = $('#btn-logout');
  if (logoutBtn) logoutBtn.onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.favorites = [];
    toast('Abgemeldet');
    renderSettings();
  };
  const pwBtn = $('#btn-pw');
  if (pwBtn) pwBtn.onclick = openPasswordModal;

  view.querySelectorAll('[data-theme-id]').forEach((b) => {
    b.onclick = () => { applyTheme(b.dataset.themeId); renderSettings(); };
  });

  const pushToggle = $('#push-toggle');
  if (pushToggle) pushToggle.onchange = async () => {
    try {
      if (pushToggle.checked) await enablePush();
      else await disablePush();
    } catch (err) {
      toast(err.message, 9000);
    }
    renderSettings();
  };
  const pushTest = $('#push-test');
  if (pushTest) pushTest.onclick = async () => {
    const r = await api('/api/push/test', { method: 'POST' });
    toast(r.sent ? 'Testnachricht gesendet 🔔' : 'Kein aktives Push-Abo gefunden');
  };
}

/* ============================== Push ============================== */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!('Notification' in window)) {
    throw new Error('Dieser Browser unterstützt keine Benachrichtigungen.');
  }
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isIos && !standalone) {
    throw new Error('iPhone: Bitte die App zuerst über Teilen → „Zum Home-Bildschirm“ installieren und vom Homescreen öffnen – erst dann erlaubt iOS Push-Nachrichten (ab iOS 16.4).');
  }
  const perm = await Notification.requestPermission();
  if (perm === 'denied') {
    throw new Error('Benachrichtigungen sind für diese Seite blockiert. Android/Chrome: Schloss-Symbol neben der Adresse → Berechtigungen → Benachrichtigungen → Zulassen, dann Seite neu laden. Zusätzlich prüfen: Systemeinstellungen → Apps → Browser → Benachrichtigungen erlaubt.');
  }
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt – die Abfrage wurde geschlossen. Bitte erneut versuchen und „Zulassen“ antippen.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey),
  });
  const json = sub.toJSON();
  await api('/api/push/subscribe', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
  toast('Push aktiviert 🔔');
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  toast('Push deaktiviert');
}

/* ============================== Modals ============================== */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-backdrop').onclick = (e) => {
    if (e.target === e.currentTarget) closeModal();
  };
  const closeBtn = root.querySelector('.modal-close');
  if (closeBtn) closeBtn.onclick = closeModal;
  return root.querySelector('.modal');
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function openLoginModal() {
  const modal = openModal(`
    <button class="modal-close">✕</button>
    <h2>Anmelden</h2>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input type="text" id="li-user" placeholder="Benutzername" autocomplete="username">
      <input type="password" id="li-pass" placeholder="Passwort" autocomplete="current-password">
      <div class="error-note hidden" id="li-err"></div>
      <button class="btn" id="li-submit">Anmelden</button>
      <div class="muted">Konten werden vom Administrator im Adminportal angelegt.</div>
    </div>
  `);
  const submit = async () => {
    try {
      const user = await api('/api/auth/login', {
        method: 'POST',
        body: { username: $('#li-user', modal).value.trim(), password: $('#li-pass', modal).value },
      });
      state.user = user;
      await refreshFavorites();
      closeModal();
      toast(`Willkommen, ${user.username}! ⚽`);
      renderTab();
    } catch (err) {
      const el = $('#li-err', modal);
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  };
  $('#li-submit', modal).onclick = submit;
  $('#li-pass', modal).onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

function openPasswordModal() {
  const modal = openModal(`
    <button class="modal-close">✕</button>
    <h2>Passwort ändern</h2>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input type="password" id="pw-new" placeholder="Neues Passwort" autocomplete="new-password">
      <button class="btn" id="pw-submit">Speichern</button>
    </div>
  `);
  $('#pw-submit', modal).onclick = async () => {
    try {
      await api('/api/auth/password', { method: 'POST', body: { password: $('#pw-new', modal).value } });
      closeModal();
      toast('Passwort geändert ✅');
    } catch (err) { toast(err.message); }
  };
}

async function openMatchDetail(matchId) {
  const { match, goals, events } = await api(`/api/matches/${matchId}`);
  const score = match.score1 != null ? `${match.score1}:${match.score2}` : '–:–';
  openModal(`
    <button class="modal-close">✕</button>
    <h2 style="text-align:center">${esc(match.team1_name)} ${score} ${esc(match.team2_name)}</h2>
    <div class="muted" style="text-align:center;margin-bottom:12px">
      ${esc(match.group_name || '')} · ${fmtDate(match.kickoff_utc)}
      ${match.ht_score1 != null ? `· HZ ${match.ht_score1}:${match.ht_score2}` : ''}
      ${match.location ? `<br>${esc(match.location)}` : ''}
      ${match.is_live ? '<br><span class="badge-live">LIVE</span>' : ''}
    </div>
    ${goals.length ? `<div class="section-title">Tore</div><div class="card">${goals
      .map((g) => `<div class="event-row"><span class="event-time">${g.minute != null ? g.minute + "'" : ''}</span><span class="event-ico">⚽</span>
        <span class="event-text">${g.score1}:${g.score2} ${esc(g.scorer || '')}${g.is_penalty ? ' (Elfmeter)' : ''}${g.is_own_goal ? ' (Eigentor)' : ''}</span></div>`)
      .join('')}</div>` : ''}
    ${events.length ? `<div class="section-title">Ticker</div><div class="card">${events.slice().reverse().map((e) => eventRow(e)).join('')}</div>` : ''}
    ${!goals.length && !events.length ? '<div class="empty">Noch keine Ereignisse.</div>' : ''}
  `);
}

async function openTeamStats(teamId) {
  const { team, home, away, form, standing, recentMatches } = await api(`/api/teams/${teamId}/stats`);
  const statRow = (label, s) =>
    `<tr><td style="text-align:left">${label}</td><td>${s.played}</td><td>${s.won}</td><td>${s.draw}</td><td>${s.lost}</td><td>${s.gf}:${s.ga}</td></tr>`;
  openModal(`
    <button class="modal-close">✕</button>
    <h2>${team.icon_url ? `<img src="${esc(team.icon_url)}" width="26" height="26" style="vertical-align:-5px" onerror="this.remove()"> ` : ''}${esc(team.name)}</h2>
    ${standing ? `<div class="muted" style="margin-bottom:10px">Platz ${standing.position} · ${standing.points} Punkte</div>` : ''}
    <div class="section-title">Form (letzte 5)</div>
    <div class="form-badges" style="margin-bottom:14px">${form.length ? form.map((f) => `<span class="form-b form-${f}">${f}</span>`).join('') : '<span class="muted">Keine Spiele</span>'}</div>
    <div class="section-title">Statistik</div>
    <div class="table-wrap"><table class="standings">
      <thead><tr><th style="text-align:left"></th><th>Sp</th><th>S</th><th>U</th><th>N</th><th>Tore</th></tr></thead>
      <tbody>${statRow('Heim', home)}${statRow('Auswärts', away)}</tbody>
    </table></div>
    ${recentMatches.length ? `<div class="section-title" style="margin-top:14px">Letzte Spiele</div>${recentMatches.map((m) => matchCard(m)).join('')}` : ''}
  `);
}

/* ============================== Tabs & Init ============================== */
const TAB_RENDERERS = {
  live: renderLive,
  matchdays: renderMatchdays,
  table: renderTable,
  news: renderNews,
  favorites: renderFavorites,
  settings: renderSettings,
};

async function renderTab() {
  document.querySelectorAll('.bottombar .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  view.innerHTML = '<div class="empty">Lädt…</div>';
  try {
    await TAB_RENDERERS[state.tab]();
  } catch (err) {
    view.innerHTML = `<div class="empty">Fehler: ${esc(err.message)}</div>`;
  }
}

document.querySelectorAll('.bottombar .tab').forEach((btn) => {
  btn.onclick = () => { state.tab = btn.dataset.tab; renderTab(); };
});
$('#btn-user').onclick = () => {
  if (state.user) { state.tab = 'settings'; renderTab(); }
  else openLoginModal();
};

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && (state.tab === 'live' || state.tab === 'matchdays')) {
      renderTab();
    }
  }, 30000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.tab === 'live') renderTab();
});

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
  }
  state.config = await api('/api/config');
  state.user = state.config.user;
  state.leagues = await api('/api/leagues');
  const saved = localStorage.getItem('selectedLeague');
  state.league = saved
    ? state.leagues.find((l) => `${l.shortcut}|${l.season}` === saved) || null
    : null; // Standard: alle Ligen
  renderLeagueChips();
  await loadTeams();
  await refreshFavorites();

  // Deep-Link aus Push-Nachricht: /?match=123
  const matchParam = new URLSearchParams(location.search).get('match');
  await renderTab();
  if (matchParam) openMatchDetail(Number(matchParam)).catch(() => {});
  startPolling();
}

init().catch((err) => {
  view.innerHTML = `<div class="empty">App konnte nicht geladen werden:<br>${esc(err.message)}</div>`;
});
