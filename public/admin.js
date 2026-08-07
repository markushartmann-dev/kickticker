'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let tab = 'users';
let me = null;

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

document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'dark');

/* ============================== Benutzer ============================== */
async function renderUsers() {
  const users = await api('/api/admin/users');
  view.innerHTML = `
    <div class="section-title">Benutzer (${users.length})</div>
    ${users
      .map(
        (u) => `<div class="setting-row">
        <div>
          <b>${esc(u.username)}</b> ${u.is_admin ? '🛡️' : ''}
          <div class="desc">Seit ${new Date(u.created_at + 'Z').toLocaleDateString('de-DE')} · ${u.favorites} Favoriten · ${u.subscriptions} Push-Geräte</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn secondary" data-pw="${u.id}">🔑</button>
          <button class="btn secondary" data-admin="${u.id}" data-state="${u.is_admin}">${u.is_admin ? 'Admin entziehen' : 'Zum Admin'}</button>
          <button class="btn danger" data-del="${u.id}" data-name="${esc(u.username)}">🗑️</button>
        </div>
      </div>`
      )
      .join('')}
    <div class="section-title">Neuen Benutzer anlegen</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <input type="text" id="nu-name" placeholder="Benutzername">
      <input type="password" id="nu-pass" placeholder="Passwort">
      <label style="display:flex;align-items:center;gap:8px;font-size:.9rem">
        <input type="checkbox" id="nu-admin"> Admin-Rechte
      </label>
      <button class="btn" id="nu-create">Anlegen</button>
    </div>`;

  $('#nu-create').onclick = async () => {
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: { username: $('#nu-name').value, password: $('#nu-pass').value, isAdmin: $('#nu-admin').checked },
      });
      toast('Benutzer angelegt ✅');
      renderUsers();
    } catch (err) { toast(err.message); }
  };
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Benutzer "${b.dataset.name}" wirklich löschen?`)) return;
      try { await api(`/api/admin/users/${b.dataset.del}`, { method: 'DELETE' }); renderUsers(); }
      catch (err) { toast(err.message); }
    };
  });
  view.querySelectorAll('[data-admin]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/admin/users/${b.dataset.admin}`, { method: 'PATCH', body: { isAdmin: b.dataset.state !== '1' } });
        renderUsers();
      } catch (err) { toast(err.message); }
    };
  });
  view.querySelectorAll('[data-pw]').forEach((b) => {
    b.onclick = async () => {
      const pw = prompt('Neues Passwort:');
      if (!pw) return;
      try { await api(`/api/admin/users/${b.dataset.pw}`, { method: 'PATCH', body: { password: pw } }); toast('Passwort gesetzt ✅'); }
      catch (err) { toast(err.message); }
    };
  });
}

/* ============================== Ligen ============================== */
async function renderLeagues() {
  const leagues = await api('/api/admin/leagues');
  view.innerHTML = `
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn" id="sync-now">🔄 Jetzt synchronisieren</button>
    </div>
    <div class="section-title">Konfigurierte Ligen</div>
    ${leagues
      .map(
        (l) => `<div class="setting-row">
        <div>
          <b>${esc(l.name)}</b>
          <div class="desc">${esc(l.shortcut)} · Saison ${esc(l.season)} ${l.enabled ? '' : '· ⏸️ deaktiviert'}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn secondary" data-zones="${esc(l.shortcut)}|${esc(l.season)}">Zonen</button>
          <button class="btn secondary" data-toggle="${esc(l.shortcut)}|${esc(l.season)}" data-state="${l.enabled}">${l.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
          <button class="btn danger" data-del="${esc(l.shortcut)}|${esc(l.season)}">🗑️</button>
        </div>
      </div>`
      )
      .join('')}
    <div class="section-title">Liga hinzufügen (OpenLigaDB)</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <input type="text" id="lg-search" placeholder="Suchen: „em“, „wm“, „premier“, „champions“ …">
      <div id="lg-results"></div>
      <div class="muted">Oder manuell:</div>
      <input type="text" id="lg-shortcut" placeholder="Kürzel (OpenLigaDB: bl1, em, wm · football-data: fdPL, fdCL, fdWC)">
      <input type="text" id="lg-season" placeholder="Saison (z.B. 2026)">
      <input type="text" id="lg-name" placeholder="Anzeigename">
      <button class="btn" id="lg-add">Hinzufügen & Daten laden</button>
    </div>`;

  $('#sync-now').onclick = async () => {
    const btn = $('#sync-now');
    btn.disabled = true;
    btn.textContent = '⏳ Synchronisiere…';
    try {
      await api('/api/admin/sync', { method: 'POST' });
      toast('Synchronisierung abgeschlossen ✅');
    } catch (err) { toast(err.message); }
    renderLeagues();
  };

  let searchTimer;
  $('#lg-search').oninput = (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#lg-results').innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const results = await api(`/api/admin/available-leagues?q=${encodeURIComponent(q)}`);
        $('#lg-results').innerHTML = results
          .slice(0, 15)
          .map((r) => `<div class="event-row" style="cursor:pointer" data-pick='${esc(JSON.stringify(r))}'>
            <span class="event-text"><b>${esc(r.name)}</b> <span class="muted">(${esc(r.shortcut)} / ${esc(r.season)})</span></span></div>`)
          .join('') || '<div class="muted">Keine Treffer</div>';
        $('#lg-results').querySelectorAll('[data-pick]').forEach((row) => {
          row.onclick = () => {
            const r = JSON.parse(row.dataset.pick);
            $('#lg-shortcut').value = r.shortcut;
            $('#lg-season').value = r.season;
            $('#lg-name').value = r.name;
          };
        });
      } catch (err) {
        $('#lg-results').innerHTML = `<div class="error-note">${esc(err.message)}</div>`;
      }
    }, 400);
  };

  $('#lg-add').onclick = async () => {
    const btn = $('#lg-add');
    btn.disabled = true;
    btn.textContent = '⏳ Lade Daten…';
    try {
      const r = await api('/api/admin/leagues', {
        method: 'POST',
        body: { shortcut: $('#lg-shortcut').value, season: $('#lg-season').value, name: $('#lg-name').value },
      });
      toast(r.warning || `Liga angelegt, ${r.imported} Spiele importiert ✅`);
      renderLeagues();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Hinzufügen & Daten laden';
    }
  };

  view.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const [shortcut, season] = b.dataset.toggle.split('|');
      await api(`/api/admin/leagues/${encodeURIComponent(shortcut)}/${encodeURIComponent(season)}`, {
        method: 'PATCH', body: { enabled: b.dataset.state !== '1' },
      });
      renderLeagues();
    };
  });
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const [shortcut, season] = b.dataset.del.split('|');
      if (!confirm(`Liga ${shortcut}/${season} entfernen? (Spieldaten bleiben in der DB)`)) return;
      await api(`/api/admin/leagues/${encodeURIComponent(shortcut)}/${encodeURIComponent(season)}`, { method: 'DELETE' });
      renderLeagues();
    };
  });
  view.querySelectorAll('[data-zones]').forEach((b) => {
    b.onclick = () => {
      const [shortcut, season] = b.dataset.zones.split('|');
      openZonesModal(leagues.find((l) => l.shortcut === shortcut && l.season === season));
    };
  });
}

function openZonesModal(league) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">
    <button class="modal-close">✕</button>
    <h2>Zonen: ${esc(league.name)}</h2>
    <div class="muted" style="margin-bottom:10px">
      JSON-Liste der Tabellenzonen. Typen: <code>champion</code>, <code>promotion</code>,
      <code>promotion_playoff</code>, <code>relegation_playoff</code>, <code>relegation</code>.
    </div>
    <textarea id="zones-json" style="width:100%;min-height:220px;font-family:monospace;font-size:.8rem;
      background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px"></textarea>
    <div class="btn-row"><button class="btn" id="zones-save">Speichern</button></div>
  </div></div>`;
  $('#zones-json').value = JSON.stringify(JSON.parse(league.zones || '[]'), null, 2);
  root.querySelector('.modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) root.innerHTML = ''; };
  root.querySelector('.modal-close').onclick = () => (root.innerHTML = '');
  $('#zones-save').onclick = async () => {
    try {
      const zones = JSON.parse($('#zones-json').value);
      await api(`/api/admin/leagues/${encodeURIComponent(league.shortcut)}/${encodeURIComponent(league.season)}`, {
        method: 'PATCH', body: { zones },
      });
      root.innerHTML = '';
      toast('Zonen gespeichert ✅');
    } catch (err) { toast(`Ungültig: ${err.message}`); }
  };
}

/* ============================== Ereignisse ============================== */
const EVENT_ICONS = { kickoff: '🟢', goal: '⚽', halftime: '⏸️', fulltime: '🏁', yellow_card: '🟨', red_card: '🟥', info: 'ℹ️' };

async function renderEvents() {
  const events = await api('/api/admin/events');
  view.innerHTML = `
    <div class="section-title">Letzte Ereignisse (${events.length})</div>
    <div class="card">
      ${events.length ? events
        .map(
          (e) => `<div class="event-row">
          <span class="event-time">${new Date(e.created_at + 'Z').toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          <span class="event-ico">${EVENT_ICONS[e.type] || '•'}</span>
          <span class="event-text">${esc(e.text)}<div class="event-match">${esc(e.team1_name || '?')} – ${esc(e.team2_name || '?')} · ${esc(e.league_shortcut)}</div></span>
        </div>`
        )
        .join('') : '<div class="empty">Noch keine Ereignisse aufgezeichnet.</div>'}
    </div>`;
}


/* ============================== Einstellungen ============================== */
async function renderAdminSettings() {
  const s = await api('/api/admin/settings');
  const fdCfg = s.footballData || {};
  view.innerHTML = `
    <div class="section-title">Datenquelle: football-data.org</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="muted">
        Bringt internationale Top-Wettbewerbe (Premier League, La Liga, Serie A,
        Champions League, WM, EM …). Kostenlosen API-Key holen:
        <a href="https://www.football-data.org/client/register" target="_blank" rel="noopener" style="color:var(--accent)">football-data.org/client/register</a>
      </div>
      <div>
        Status: ${fdCfg.configured
          ? `✅ Key hinterlegt (${esc(fdCfg.masked || '')})${fdCfg.fromEnv ? ' – aus Umgebungsvariable, hat Vorrang' : ''}`
          : '❌ Kein Key hinterlegt'}
      </div>
      <input type="password" id="fd-key" placeholder="API-Key eintragen (X-Auth-Token)" ${fdCfg.fromEnv ? 'disabled' : ''}>
      <div class="btn-row">
        <button class="btn" id="fd-save" ${fdCfg.fromEnv ? 'disabled' : ''}>Speichern</button>
        <button class="btn secondary" id="fd-test" ${fdCfg.configured ? '' : 'disabled'}>Verbindung testen</button>
        ${fdCfg.configured && !fdCfg.fromEnv ? '<button class="btn danger" id="fd-clear">Key entfernen</button>' : ''}
      </div>
      ${fdCfg.fromEnv ? '<div class="muted">Der Key kommt aktuell aus der Umgebungsvariable FOOTBALL_DATA_API_KEY. Zum Pflegen über dieses Formular die Variable aus der docker-compose.yml entfernen.</div>' : ''}
      <div class="muted">Nach dem Speichern sofort aktiv – kein Neustart nötig. Danach unter „Ligen“ z.&nbsp;B. nach „premier“ oder „champions“ suchen.</div>
    </div>
    <div class="section-title">Datenquelle: OpenLigaDB</div>
    <div class="card"><div class="muted">Immer aktiv, kein Key erforderlich (deutsche Ligen, DFB-Pokal, EM, WM).</div></div>
    <div class="section-title">News-Feeds (RSS)</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="muted">Quellen für die News-Rubrik. <code>league</code> = Liga-Kürzel für den Liga-Filter
        (<code>null</code> = allgemeine News). Standard: offizielle kicker.de-Feeds.</div>
      <textarea id="nf-json" style="width:100%;min-height:180px;font-family:monospace;font-size:.75rem;
        background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px"></textarea>
      <div class="btn-row"><button class="btn" id="nf-save">Feeds speichern</button></div>
    </div>
  `;
  $('#nf-json').value = JSON.stringify(s.newsFeeds || [], null, 2);
  $('#nf-save').onclick = async () => {
    try {
      const feeds = JSON.parse($('#nf-json').value);
      await api('/api/admin/settings', { method: 'POST', body: { newsFeeds: feeds } });
      toast('News-Feeds gespeichert ✅');
    } catch (err) { toast(`Ungültig: ${err.message}`, 4000); }
  };

  $('#fd-save').onclick = async () => {
    const key = $('#fd-key').value.trim();
    if (!key) return toast('Bitte einen API-Key eingeben');
    try {
      await api('/api/admin/settings', { method: 'POST', body: { footballDataApiKey: key } });
      toast('Key gespeichert ✅');
      renderAdminSettings();
    } catch (err) { toast(err.message); }
  };
  $('#fd-test').onclick = async () => {
    const btn = $('#fd-test');
    btn.disabled = true;
    btn.textContent = '⏳ Teste…';
    try {
      const r = await api('/api/admin/settings/test-football-data', { method: 'POST' });
      toast(`Verbindung OK – ${r.competitions} Wettbewerbe verfügbar ✅`, 4000);
    } catch (err) { toast(`Test fehlgeschlagen: ${err.message}`, 4000); }
    renderAdminSettings();
  };
  const clearBtn = $('#fd-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('football-data.org-Key wirklich entfernen?')) return;
    await api('/api/admin/settings', { method: 'POST', body: { footballDataApiKey: '' } });
    toast('Key entfernt');
    renderAdminSettings();
  };
}

/* ============================== Init ============================== */
const RENDERERS = { users: renderUsers, leagues: renderLeagues, events: renderEvents, settings: renderAdminSettings };

document.querySelectorAll('#admin-tabs .chip').forEach((chip) => {
  chip.onclick = () => {
    tab = chip.dataset.tab;
    document.querySelectorAll('#admin-tabs .chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  };
});

async function render() {
  view.innerHTML = '<div class="empty">Lädt…</div>';
  try {
    await RENDERERS[tab]();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

(async function init() {
  try {
    const cfg = await api('/api/config');
    me = cfg.user;
    if (!me || !me.isAdmin) {
      view.innerHTML = `<div class="empty">Kein Zugriff – bitte als Admin anmelden.<br><br>
        <input type="text" id="a-user" placeholder="Benutzername" style="max-width:280px;margin:4px auto"><br>
        <input type="password" id="a-pass" placeholder="Passwort" style="max-width:280px;margin:4px auto"><br>
        <button class="btn" id="a-login" style="margin-top:8px">Anmelden</button>
        <div class="error-note hidden" id="a-err"></div></div>`;
      $('#a-login').onclick = async () => {
        try {
          const user = await api('/api/auth/login', {
            method: 'POST',
            body: { username: $('#a-user').value.trim(), password: $('#a-pass').value },
          });
          if (!user.isAdmin) throw new Error('Dieser Benutzer hat keine Admin-Rechte');
          location.reload();
        } catch (err) {
          const el = $('#a-err');
          el.textContent = err.message;
          el.classList.remove('hidden');
        }
      };
      return;
    }
    render();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
})();
