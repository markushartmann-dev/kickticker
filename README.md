# ⚽ KickTicker – Fußball-Liveticker als selbst gehostete PWA

Selbst gehostete Fußball-App mit Liveticker, Ergebnissen, Spieltags-Übersicht,
Tabelle und **Push-Benachrichtigungen** für favorisierte Mannschaften.
Läuft als Docker-Container und lässt sich vom Handy aus als App auf den
Homescreen legen (PWA).

## Funktionen

- **Liveticker**: laufende Spiele, Spielstände, Tore, Ereignis-Feed —
  standardmäßig über **alle Ligen**, per Filter auf eine Liga einschränkbar
  (die Auswahl wird auf dem Gerät gemerkt)
- **Push-Benachrichtigungen** für Favoriten-Teams: Anpfiff, Tor (inkl. Torschütze,
  Elfmeter/Eigentor), Halbzeit, Abpfiff *(Karten: siehe „Datenquellen“ unten)*
- **Spieltage**: alle Spieltage der Saison durchblättern – auch kommende
- **Tabelle** mit farbigen Auf-/Abstiegszonen:
  - Platz 1–2: direkter Aufstieg, Platz 3: Relegation
  - letzte zwei Plätze: direkter Abstieg, drittletzter: Relegation
  - (pro Liga im Adminportal frei konfigurierbar, z. B. CL-Plätze für die 1. Bundesliga)
- **Team-Statistik** in der Datenbank: Heim/Auswärts-Bilanz, Form der letzten 5 Spiele
- **Torschützentabelle** je Liga: aus den erfassten Toren berechnet (Eigentore
  ausgenommen); Fallback auf die offizielle Torjägerliste des Datenanbieters,
  z. B. bei Turnieren ohne gepflegte Schützennamen
- **Filter** nach Liga und Mannschaft
- **News-Rubrik**: Meldungen aus offiziellen RSS-Feeds (Standard: kicker.de),
  filterbar nach Liga oder nur Favoriten-Teams; Feeds im Adminportal anpassbar
- **Favoriten** pro Benutzer (Stern-Markierung + Push)
- **4 Farbschemata**: Dunkel, Hell, Rasen, Retro
- **Benutzerverwaltung + Adminportal** (`/admin`): Benutzer, Ligen, Tabellenzonen,
  Ereignis-Log, manueller Sync
- **PWA**: Homescreen-Installation, Offline-Cache der Oberfläche

## Schnellstart

```bash
cd football-liveticker
docker compose up -d --build
```

App: `http://<server>:2233` · Adminportal: `http://<server>:2233/admin`

(Host-Port in `docker-compose.yml` unter `ports` anpassbar; im Container läuft die App weiter auf 3000.)

Erster Login: Benutzer **admin**, Passwort aus `ADMIN_PASSWORD` in der
`docker-compose.yml` (Standard ohne Variable: `admin`). **Bitte sofort ändern.**

Beim ersten Start werden **1. Bundesliga, 2. Bundesliga und 3. Liga** der
aktuellen Saison angelegt und automatisch von OpenLigaDB geladen.

### EM / WM hinzufügen

Adminportal → *Ligen* → im Suchfeld z. B. `em` oder `wm` eingeben, Treffer
anklicken, „Hinzufügen & Daten laden“. Die Suche fragt live die bei OpenLigaDB
verfügbaren Wettbewerbe ab. Genauso lassen sich weitere Ligen ergänzen.

### Demo-Modus (ohne Internet testen)

In `docker-compose.yml` `DEMO=1` einkommentieren und Container neu starten.
Es entstehen eine Beispiel-Liga mit Tabelle und ein **simuliertes Livespiel**,
das alle paar Sekunden Tore/Halbzeit/Abpfiff erzeugt – ideal, um Ticker und
Push-Nachrichten zu testen.

## ⚠️ HTTPS – Voraussetzung für PWA & Push

Service Worker (und damit Homescreen-Installation und Push) funktionieren im
Browser **nur über HTTPS** (Ausnahme: `localhost`). Für den Zugriff vom Handy
brauchst du also einen Reverse Proxy mit TLS vor dem Container, z. B.:

- **Caddy** (am einfachsten, automatisches Let's Encrypt):
  ```
  ticker.example.com {
      reverse_proxy kickticker:3000
  }
  ```
- Traefik, nginx + certbot oder Nginx Proxy Manager funktionieren genauso.
- Nur im Heimnetz ohne Domain: selbstsigniertes Zertifikat oder z. B. Tailscale
  (`tailscale serve`) verwenden.

**iPhone-Hinweis:** Web-Push gibt es auf iOS ab 16.4 – und nur, wenn die App
zuerst über *Teilen → „Zum Home-Bildschirm“* installiert wurde. Auf Android
funktioniert Push auch direkt im Browser.

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Beschreibung |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `DATA_DIR` | `/data` (im Container) | Ablage der SQLite-DB |
| `ADMIN_PASSWORD` | `admin` | Passwort des ersten Admin-Users (nur Erststart) |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Kontakt für den Push-Dienst |
| `SYNC_INTERVAL_SECONDS` | `60` | Abfrage-Intervall OpenLigaDB (min. 15) |
| `FOOTBALL_DATA_API_KEY` | – | Optionaler Override; normalerweise im Adminportal → Einstellungen pflegen |
| `DEMO` | – | `1` = Beispieldaten + simuliertes Livespiel |

VAPID-Schlüssel für Push werden beim ersten Start automatisch erzeugt und in
der Datenbank gespeichert.

## Datenquellen

**Primär: [OpenLigaDB](https://www.openligadb.de)** (`api.openligadb.de`):
kostenlos, ohne API-Key, community-gepflegt, mit 1.–3. Bundesliga, DFB-Pokal,
EM und WM. Ideal für den Fokus „deutsche Ligen zuerst“.

**Optional: [football-data.org](https://www.football-data.org)** für die
internationalen Top-Wettbewerbe (Premier League, La Liga, Serie A, Ligue 1,
Eredivisie, Primeira Liga, Championship, Brasilien, Champions League, WM, EM):

1. Kostenlosen API-Key holen: <https://www.football-data.org/client/register>
2. Key im **Adminportal → Einstellungen** eintragen (sofort aktiv, kein Neustart
   nötig; alternativ als Umgebungsvariable `FOOTBALL_DATA_API_KEY`, die hat Vorrang)
3. Im Adminportal → Ligen nach z. B. „premier“ oder „champions“ suchen —
   Treffer von football-data.org sind entsprechend markiert (Kürzel `fdPL`, `fdCL`, …)

Einschränkungen des Gratis-Plans: Live-Stände leicht verzögert, keine
Einzeltor-/Kartendaten (Tor-Push-Meldungen entstehen aus der
Spielstands-Änderung, ohne Torschützen-Name), Torschützentabelle kommt über
die offizielle Scorer-Liste. 10 Anfragen/Minute — die App bündelt deshalb
alle football-data-Ligen in einen einzigen Live-Request pro Abfragezyklus.

Bewertete Alternativen:

| Quelle | Kosten | Abdeckung | Anmerkung |
|---|---|---|---|
| **OpenLigaDB** (verwendet) | kostenlos, kein Key | DE-Ligen, EM, WM | Liefert Tore/Ergebnisse, aber **keine Karten** |
| **football-data.org** | Gratis-Tier (10 Req/min) | 12 Top-Wettbewerbe (BL1, CL, WM …) | keine 3. Liga im Gratis-Tier |
| **API-Football** (api-sports.io) | Gratis 100 Req/Tag, dann kostenpflichtig | weltweit ~1000 Ligen, **inkl. Karten & Aufstellungen** | beste Wahl für den späteren Ausbau „Ligen weltweit + Kartenevents“ |
| kicker.de / fussballdaten.de | – | – | keine öffentliche API; Scraping verstößt gegen die Nutzungsbedingungen und bricht ständig – nicht empfohlen |

**Gelbe/Rote Karten:** OpenLigaDB stellt keine Kartendaten bereit. Datenmodell
und Push-Pipeline unterstützen `yellow_card`/`red_card` bereits – für den
weltweiten Ausbau (und damit auch Karten) bietet sich API-Football als zweiter
Provider an.

## Architektur

```
football-liveticker/
├── server.js            Express-Server, REST-API, statische PWA
├── lib/
│   ├── db.js            SQLite-Schema (better-sqlite3)
│   ├── openligadb.js    OpenLigaDB-Client
│   ├── sync.js          Sync-Scheduler, Ereignis-Erkennung, Tabellenberechnung
│   ├── push.js          Web-Push (VAPID), Favoriten-Benachrichtigung
│   ├── auth.js          Sessions, Benutzer, Admin-Middleware
│   └── demo.js          Demo-Modus mit simuliertem Livespiel
├── public/              PWA-Frontend (Vanilla JS, ohne Framework)
│   ├── index.html / app.js / styles.css
│   ├── admin.html / admin.js
│   ├── sw.js            Service Worker (Cache + Push)
│   └── manifest.webmanifest
├── scripts/make-icons.js
├── Dockerfile
└── docker-compose.yml
```

Ablauf: Der Scheduler fragt OpenLigaDB zyklisch ab (Vollsync alle 6 h, dazwischen
nur Spieltage mit anstehenden/laufenden Spielen). Neue Tore, Anpfiff, Halbzeit
und Abpfiff werden als Ereignisse gespeichert und per Web-Push an alle Nutzer
geschickt, die eines der beiden Teams favorisiert haben. Nach jedem Sync wird
die Tabelle (Punkte, Tordifferenz) in der Datenbank neu berechnet.
