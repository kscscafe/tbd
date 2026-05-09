import { getSql, setCors, readJson, isUuid, requireSession } from './_lib.js';

const MAX_NAME = 60;
const MAX_PROMPT = 4000;
const MAX_NEXT_ACTION = 500;
const ALLOWED_STATUS = new Set(['active', 'waiting', 'blocked', 'dormant', 'done']);

const SELECT_COLS = `
  id, user_id, parent_id, name, system_prompt,
  status, progress, priority, next_action,
  auto_named, sort_order, created_at, updated_at
`;

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const userId = requireSession(req, res);
  if (!userId) return;

  let sql;
  try { sql = getSql(); } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }

  const id = req.query?.id;

  try {
    if (req.method === 'GET') {
      if (id) {
        if (!isUuid(id)) return res.status(400).json({ error: 'invalid id' });
        const rows = await sql.query(
          `SELECT ${SELECT_COLS} FROM nodes WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }
      // 一覧 + 各ノードの fragment 数（クライアント側でツリー組み立て）
      const nodes = await sql.query(
        `SELECT ${SELECT_COLS} FROM nodes
         WHERE user_id = $1
         ORDER BY sort_order ASC, created_at ASC`,
        [userId]
      );
      const counts = await sql`
        SELECT node_id, COUNT(*)::int AS n
        FROM fragments
        WHERE user_id = ${userId} AND node_id IS NOT NULL
        GROUP BY node_id
      `;
      const countMap = new Map(counts.map((r) => [r.node_id, r.n]));
      const enriched = nodes.map((n) => ({ ...n, fragment_count: countMap.get(n.id) || 0 }));
      return res.status(200).json({ nodes: enriched });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const name = clean(body?.name, MAX_NAME);
      if (!name) return res.status(400).json({ error: 'name is required' });

      const parent_id = (typeof body?.parent_id === 'string' && isUuid(body.parent_id)) ? body.parent_id : null;
      if (parent_id) {
        const parent = await sql`SELECT id FROM nodes WHERE id = ${parent_id} AND user_id = ${userId}`;
        if (!parent[0]) return res.status(404).json({ error: 'parent not found' });
      }
      const system_prompt = typeof body?.system_prompt === 'string'
        ? body.system_prompt.slice(0, MAX_PROMPT)
        : '';

      const [maxRow] = await sql`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM nodes
        WHERE user_id = ${userId} AND parent_id IS NOT DISTINCT FROM ${parent_id}
      `;
      const nextOrder = maxRow?.next ?? 0;

      const rows = await sql.query(
        `INSERT INTO nodes (user_id, parent_id, name, system_prompt, auto_named, sort_order)
         VALUES ($1, $2, $3, $4, false, $5)
         RETURNING ${SELECT_COLS}`,
        [userId, parent_id, name, system_prompt, nextOrder]
      );
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      if (!isUuid(id)) return res.status(400).json({ error: 'valid uuid id is required' });
      const body = await readJson(req);
      const fields = {};

      const name = clean(body?.name, MAX_NAME);
      if (name !== null) {
        fields.name = name;
        fields.auto_named = false;
      }
      if (typeof body?.system_prompt === 'string') {
        fields.system_prompt = body.system_prompt.slice(0, MAX_PROMPT);
      }
      if (typeof body?.status === 'string' && ALLOWED_STATUS.has(body.status)) {
        fields.status = body.status;
      }
      if (typeof body?.progress === 'number' && Number.isFinite(body.progress)) {
        fields.progress = Math.max(0, Math.min(100, Math.floor(body.progress)));
      }
      if (typeof body?.priority === 'number' && Number.isFinite(body.priority)) {
        fields.priority = Math.max(0, Math.min(2, Math.floor(body.priority)));
      }
      if (typeof body?.next_action === 'string') {
        fields.next_action = body.next_action.slice(0, MAX_NEXT_ACTION);
      }
      if (typeof body?.sort_order === 'number' && Number.isFinite(body.sort_order)) {
        fields.sort_order = Math.floor(body.sort_order);
      }

      // parent_id 変更：cycle ガード（自分の子孫の下に潜らせない）
      if ('parent_id' in (body || {})) {
        const newParent = body.parent_id;
        if (newParent === null) {
          fields.parent_id = null;
        } else if (typeof newParent === 'string' && isUuid(newParent)) {
          if (newParent === id) return res.status(400).json({ error: 'cannot be own parent' });
          const descendants = await sql.query(
            `WITH RECURSIVE d AS (
               SELECT id FROM nodes WHERE id = $1 AND user_id = $2
               UNION
               SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id WHERE n.user_id = $2
             ) SELECT id FROM d`,
            [id, userId]
          );
          if (descendants.some((x) => x.id === newParent)) {
            return res.status(400).json({ error: 'cannot move under a descendant' });
          }
          const p = await sql`SELECT id FROM nodes WHERE id = ${newParent} AND user_id = ${userId}`;
          if (!p[0]) return res.status(404).json({ error: 'parent not found' });
          fields.parent_id = newParent;
        }
      }

      const cols = Object.keys(fields);
      if (cols.length === 0) {
        const rows = await sql.query(
          `SELECT ${SELECT_COLS} FROM nodes WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }
      const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map((c) => fields[c]);
      const rows = await sql.query(
        `UPDATE nodes SET ${setClauses}, updated_at = now()
         WHERE id = $${cols.length + 1} AND user_id = $${cols.length + 2}
         RETURNING ${SELECT_COLS}`,
        [...values, id, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      if (!isUuid(id)) return res.status(400).json({ error: 'valid uuid id is required' });
      const rows = await sql`
        DELETE FROM nodes WHERE id = ${id} AND user_id = ${userId}
        RETURNING id
      `;
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ ok: true, id });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'DB error', detail: String(e.message || e) });
  }
}
