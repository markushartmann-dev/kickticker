'use strict';

const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');

// VAPID-Schluessel werden beim ersten Start erzeugt und in der DB abgelegt,
// damit Push-Abos Container-Neustarts ueberleben.
function initVapid() {
  let publicKey = getSetting('vapid_public');
  let privateKey = getSetting('vapid_private');
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    setSetting('vapid_public', publicKey);
    setSetting('vapid_private', privateKey);
    console.log('[push] Neue VAPID-Schluessel erzeugt');
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return publicKey;
}

const getSubsForUsers = (userIds) => {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT id, user_id, endpoint, keys_json FROM push_subscriptions WHERE user_id IN (${placeholders})`)
    .all(...userIds);
};

async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) },
      JSON.stringify(payload),
      { TTL: 900 }
    );
    return true;
  } catch (err) {
    // 404/410 = Abo abgelaufen -> aufraeumen
    if (err.statusCode === 404 || err.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
    } else {
      console.error(`[push] Senden fehlgeschlagen (${err.statusCode || err.message})`);
    }
    return false;
  }
}

// Benachrichtigt alle Nutzer, die team1 oder team2 favorisiert haben.
async function notifyFavorites(team1Id, team2Id, payload) {
  const rows = db
    .prepare('SELECT DISTINCT user_id FROM favorites WHERE team_id IN (?, ?)')
    .all(team1Id ?? -1, team2Id ?? -1);
  const subs = getSubsForUsers(rows.map((r) => r.user_id));
  await Promise.allSettled(subs.map((s) => sendToSubscription(s, payload)));
  return subs.length;
}

async function notifyUser(userId, payload) {
  const subs = getSubsForUsers([userId]);
  await Promise.allSettled(subs.map((s) => sendToSubscription(s, payload)));
  return subs.length;
}

module.exports = { initVapid, notifyFavorites, notifyUser };
