// ================================================================
// Baileys Auth State stocké dans Neon PostgreSQL
// Permet de déployer sur Koyeb/cloud sans perte de session WhatsApp
// ================================================================

const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { Client } = require('pg');

const NEON_URL = process.env.NEON_DATABASE_URL ||
  'postgresql://neondb_owner:npg_8aJpEbywQ6ZT@ep-tiny-glade-at3efk9k-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

async function createAuthTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function useNeonAuthState() {
  const client = new Client({ connectionString: NEON_URL });
  await client.connect();
  await createAuthTable(client);

  async function readData(key) {
    const res = await client.query(
      'SELECT value FROM whatsapp_auth_state WHERE key = $1', [key]
    );
    if (!res.rows.length) return null;
    try { return JSON.parse(res.rows[0].value, BufferJSON.reviver); }
    catch { return null; }
  }

  async function writeData(key, value) {
    if (value == null) {
      await client.query('DELETE FROM whatsapp_auth_state WHERE key = $1', [key]);
    } else {
      const json = JSON.stringify(value, BufferJSON.replacer);
      await client.query(`
        INSERT INTO whatsapp_auth_state (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [key, json]);
    }
  }

  // Charger ou créer les credentials
  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData('creds', creds);
    console.log('🔑 Nouveaux credentials créés dans Neon');
  } else {
    console.log('✅ Credentials WhatsApp chargés depuis Neon');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            const val = await readData(`key:${type}:${id}`);
            if (val) data[id] = val;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids)) {
              tasks.push(writeData(`key:${type}:${id}`, value));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    }
  };
}

module.exports = { useNeonAuthState };
