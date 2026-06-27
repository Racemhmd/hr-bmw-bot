#!/usr/bin/env node
// Test polling Green API — diagnostic
const https = require('https');

const ID = '7107665040';
const TOKEN = 'c550d04c1dde4c11af75f8a7fd04a0bb633108512ec34e8bba';
const BASE = `https://7107.api.greenapi.com/waInstance${ID}`;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function deleteNotif(receiptId) {
  return new Promise((resolve) => {
    const req = https.request(
      `${BASE}/deleteNotification/${TOKEN}/${receiptId}`,
      { method: 'DELETE' },
      res => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve);
    req.end();
  });
}

async function main() {
  console.log('🔍 Test polling Green API...\n');

  // 1. Vérifier statut instance
  console.log('1️⃣  Statut instance:');
  const state = await get(`${BASE}/getStateInstance/${TOKEN}`);
  console.log('   →', JSON.stringify(state));
  console.log();

  // 2. Recevoir notification
  console.log('2️⃣  Recevoir notification:');
  const notif = await get(`${BASE}/receiveNotification/${TOKEN}`);
  console.log('   →', JSON.stringify(notif));
  console.log();

  if (notif && notif.receiptId) {
    console.log('✅ MESSAGE TROUVÉ !');
    console.log('   receiptId:', notif.receiptId);
    console.log('   typeWebhook:', notif.body?.typeWebhook);
    console.log('   sender:', notif.body?.senderData?.sender);
    console.log('   message:', notif.body?.messageData?.textMessageData?.textMessage);

    // Supprimer la notification
    await deleteNotif(notif.receiptId);
    console.log('   ✓ Notification supprimée');
  } else if (notif === null) {
    console.log('ℹ️  File vide (null) — mode polling actif mais aucun message en attente');
    console.log('   → Envoyez un message WhatsApp au +216 28 995 222 depuis un autre numéro');
    console.log('   → Relancez: node test_polling.js');
  } else {
    console.log('⚠️  Réponse inattendue:', notif);
  }
}

main().catch(console.error);
