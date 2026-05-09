#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Node < 22 has no native WebSocket; required by the Pool driver.
neonConfig.webSocketConstructor = ws;

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = resolve(__dirname, '..', '.env.local');
  let raw;
  try { raw = readFileSync(envPath, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL is not set (check .env.local).');
    process.exit(1);
  }

  const schemaPath = resolve(__dirname, 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');

  console.log('Applying db/schema.sql to Neon...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(schemaSql);
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('Done. public schema tables:', rows.map((r) => r.table_name).join(', ') || '(none)');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e?.message || e);
  process.exit(1);
});
