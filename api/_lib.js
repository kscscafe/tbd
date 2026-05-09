import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import crypto from 'crypto';

neonConfig.webSocketConstructor = ws;

let _pool;
function getPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  _pool = new Pool({ connectionString: url });
  return _pool;
}

// Returns a function that can be used either as a tagged template
// (`sql\`SELECT ...\``) or via `.query(text, params)`. Both resolve to a rows
// array, matching the neon HTTP client shape.
export function getSql() {
  const pool = getPool();

  async function sql(strings, ...values) {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) {
      text += `$${i + 1}` + strings[i + 1];
    }
    const r = await pool.query(text, values);
    return r.rows;
  }

  sql.query = async (text, params) => {
    const r = await pool.query(text, params);
    return r.rows;
  };

  return sql;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// 自社画面用 CORS。許可リストに一致した Origin だけ echo back する。
// 本番ドメインが決まったら追加すること。
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
];

export function setCors(res, req) {
  const origin = req?.headers?.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
}

// ─────────────────────────────────────────────────────────────────
// Session token (HMAC-SHA256 署名のステートレストークン)
// 形式: "<user_id>.<exp_unix_sec>.<hmac_hex>"
// SESSION_SECRET を知らないと HMAC を作れないため偽造不可。
// ─────────────────────────────────────────────────────────────────
const DEFAULT_SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

function hmacSign(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function issueSessionToken(userId, ttlSec = DEFAULT_SESSION_TTL_SEC) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  const sig = hmacSign(payload);
  return { token: `${payload}.${sig}`, expires_at: exp };
}

export function verifySessionToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  if (!isUuid(userId)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  let expected;
  try {
    expected = hmacSign(`${userId}.${exp}`);
  } catch {
    return null;
  }
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { userId, exp };
}

// 各 API ハンドラ冒頭で呼ぶ。トークンが無効なら 401 を返して false。
// 戻り値の userId をそのまま使ってクエリすればよい。
export function requireSession(req, res) {
  if (!process.env.SESSION_SECRET) {
    res.status(500).json({ error: 'SESSION_SECRET is not configured' });
    return null;
  }
  const token = req.headers['x-session-token'];
  const claim = verifySessionToken(token);
  if (!claim) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return claim.userId;
}

// IP ごとの簡易レート制限。Vercel サーバーレスでは関数インスタンスが
// 複数走るので completeness は出ない（インスタンス間で共有されない）。
// MVP の濫用抑止としては十分機能する想定。
const rateLimitStore = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

export function checkRateLimit(req, { limit = 10, windowMs = 60_000 } = {}) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart >= windowMs) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    if (Math.random() < 0.01) {
      for (const [k, v] of rateLimitStore) {
        if (now - v.windowStart >= windowMs) rateLimitStore.delete(k);
      }
    }
    return { ok: true };
  }

  entry.count += 1;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
    return { ok: false, retryAfter: Math.max(retryAfter, 1) };
  }
  return { ok: true };
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
