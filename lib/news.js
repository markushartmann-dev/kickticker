'use strict';

// News-Modul: liest offizielle RSS-Feeds (Standard: kicker.de) und stellt sie
// gefiltert nach Liga bzw. Favoriten-Teams bereit. Es werden nur Titel,
// Beschreibung und Link angezeigt - der Artikel selbst wird beim Anbieter
// geoeffnet (dafuer sind RSS-Feeds gedacht).
//
// Die Feed-Liste ist im Adminportal (Einstellungen) als JSON anpassbar,
// Zuordnung ueber das Liga-Kuerzel ("league": null = allgemeine News).

const { getSetting } = require('./db');

const DEFAULT_FEEDS = [
  { league: null, name: 'kicker – Fußball', url: 'https://newsfeed.kicker.de/news/fussball' },
  { league: 'bl1', name: 'kicker – Bundesliga', url: 'https://newsfeed.kicker.de/news/bundesliga' },
  { league: 'bl2', name: 'kicker – 2. Bundesliga', url: 'https://newsfeed.kicker.de/news/2bundesliga' },
  { league: 'bl3', name: 'kicker – 3. Liga', url: 'https://newsfeed.kicker.de/news/3liga' },
  { league: 'dfb', name: 'kicker – DFB-Pokal', url: 'https://newsfeed.kicker.de/news/dfbpokal' },
  { league: 'em', name: 'kicker – EM', url: 'https://newsfeed.kicker.de/news/em' },
  { league: 'wm', name: 'kicker – WM', url: 'https://newsfeed.kicker.de/news/wm' },
];

function getFeeds() {
  try {
    const stored = getSetting('news_feeds');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length) {
        // Migration: der fruehere Standard-Feed "Topthemen" enthaelt alle
        // Sportarten (auch Darts etc.) -> auf den reinen Fussball-Feed umbiegen
        for (const f of parsed) {
          if (f && f.url === 'https://newsfeed.kicker.de/news/aktuell' && !f.league) {
            f.url = 'https://newsfeed.kicker.de/news/fussball';
            f.name = 'kicker – Fußball';
          }
        }
        return parsed;
      }
    }
  } catch { /* defekte Konfiguration -> Standard verwenden */ }
  return DEFAULT_FEEDS;
}

// ------------------------------------------------------------- RSS-Parsing

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseRss(xml) {
  const items = [];
  // RSS 2.0 <item> und Atom <entry> unterstuetzen
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = stripTags(tag(block, 'title'));
    let link = stripTags(tag(block, 'link'));
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      link = href ? decodeEntities(href[1]) : '';
    }
    const dateRaw = tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published') || tag(block, 'dc:date');
    const parsed = dateRaw ? new Date(stripTags(dateRaw)) : null;
    const description = stripTags(tag(block, 'description') || tag(block, 'summary')).slice(0, 300);
    if (title && link) {
      items.push({
        title,
        link,
        description,
        date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      });
    }
  }
  return items;
}

// ------------------------------------------------------------- Feed-Cache

const CACHE_MS = 15 * 60 * 1000;
const cache = new Map(); // url -> { at, items, error }

async function fetchFeed(feed) {
  const cached = cache.get(feed.url);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const entry = { at: Date.now(), items: [], error: null };
  try {
    const res = await fetch(feed.url, {
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entry.items = parseRss(await res.text()).map((i) => ({
      ...i,
      source: feed.name,
      league: feed.league || null,
    }));
  } catch (err) {
    entry.error = err.message;
    console.error(`[news] Feed "${feed.name}" (${feed.url}): ${err.message}`);
  }
  cache.set(feed.url, entry);
  return entry;
}

// ------------------------------------------------------------- Abfrage

// league: Kuerzel oder null (= alle Feeds der aktivierten Ligen)
// allowedLeagues: Kuerzel-Liste der aktivierten Ligen; Feeds deaktivierter
// Ligen (z. B. WM nach dem Turnier) werden komplett ausgeblendet
// favoriteNames: Team-Namen; wenn gesetzt, nur Meldungen, die eines der
// Teams im Titel/Text als eigenes Wort erwaehnen
async function getNews({ league = null, favoriteNames = null, allowedLeagues = null } = {}) {
  let feeds = getFeeds();
  const warnings = [];
  if (Array.isArray(allowedLeagues)) {
    feeds = feeds.filter((f) => !f.league || allowedLeagues.includes(f.league));
  }
  if (league) {
    const leagueFeeds = feeds.filter((f) => f.league === league);
    if (leagueFeeds.length) {
      feeds = leagueFeeds;
    } else {
      warnings.push('Für diese Liga ist keine eigene News-Quelle hinterlegt – allgemeine Fußball-News werden angezeigt.');
    }
  }

  const results = await Promise.all(feeds.map((f) => fetchFeed(f)));
  let items = results.flatMap((r) => r.items);
  for (const [i, r] of results.entries()) {
    if (r.error) warnings.push(`Feed "${feeds[i].name}" nicht erreichbar`);
  }

  if (favoriteNames && favoriteNames.length) {
    // Teamnamen nur als ganze Woerter matchen ("Union" trifft nicht "Reunion");
    // sonst tauchen Spieltags-Zusammenfassungen mit vielen Teams ueberall auf
    const seen = new Set();
    const needles = [];
    for (const raw of favoriteNames.flatMap((n) => String(n || '').split('/'))) {
      const n = raw.trim();
      if (n.length < 3 || seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // optionales "s" fuer den Genitiv ("Herthas Trainer", "Bayerns Sturm")
      needles.push(new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}s?(?=$|[^\\p{L}\\p{N}])`, 'iu'));
    }
    items = items.filter((item) => {
      const text = `${item.title} ${item.description}`;
      return needles.some((re) => re.test(text));
    });
  }

  // Duplikate (gleicher Link ueber mehrere Feeds) entfernen, neueste zuerst
  const seen = new Set();
  items = items.filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)));
  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return { items: items.slice(0, 50), warnings };
}

module.exports = { getNews, getFeeds, DEFAULT_FEEDS };
