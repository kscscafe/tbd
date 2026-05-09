import bcrypt from 'bcryptjs';
import {
  getSql, setCors, readJson,
  issueSessionToken, requireSession, checkRateLimit,
} from './_lib.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_DISPLAY_NAME = 100;

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let sql;
  try { sql = getSql(); } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }

  // GET /api/auth → 現在のユーザー情報
  if (req.method === 'GET') {
    const userId = requireSession(req, res);
    if (!userId) return;
    const rows = await sql`
      SELECT id, email, display_name, created_at
      FROM users WHERE id = ${userId}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.status(200).json(rows[0]);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ブルートフォース対策に IP レート制限
  const rl = checkRateLimit(req, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: 'Too Many Requests' });
  }

  const action = req.query?.action;
  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });

  try {
    if (action === 'signup') {
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} chars` });
      }
      const display_name = clean(body?.display_name, MAX_DISPLAY_NAME);
      const password_hash = bcrypt.hashSync(password, 10);

      let rows;
      try {
        rows = await sql`
          INSERT INTO users (email, password_hash, display_name)
          VALUES (${email}, ${password_hash}, ${display_name})
          RETURNING id, email, display_name, created_at
        `;
      } catch (e) {
        if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message || ''))) {
          return res.status(409).json({ error: 'Email already registered' });
        }
        throw e;
      }
      const user = rows[0];
      const { token, expires_at } = issueSessionToken(user.id);
      return res.status(201).json({ user, token, expires_at });
    }

    if (action === 'login') {
      const rows = await sql`
        SELECT id, email, display_name, password_hash
        FROM users WHERE lower(email) = ${email}
      `;
      const user = rows[0];
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const { token, expires_at } = issueSessionToken(user.id);
      const { password_hash, ...safe } = user;
      return res.status(200).json({ user: safe, token, expires_at });
    }

    return res.status(400).json({ error: 'action must be signup or login' });
  } catch (e) {
    return res.status(500).json({ error: 'DB error', detail: String(e.message || e) });
  }
}
