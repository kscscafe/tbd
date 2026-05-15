import { getSql, setCors, readJson, isUuid, requireSession } from './_lib.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const ALLOWED_STATUS = new Set(['open', 'in_progress', 'done', 'wontfix']);

const SELECT_COLS = `
  id, user_id, node_id, title, description, status, priority,
  to_char(due_date, 'YYYY-MM-DD') AS due_date,
  source_fragment_ids, created_at, updated_at
`;

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function parseDueDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return undefined; // 不正
  // YYYY-MM-DD のみ受ける
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return v;
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
          `SELECT ${SELECT_COLS} FROM issues WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }
      const node_id = req.query?.node_id;
      if (node_id) {
        if (!isUuid(node_id)) return res.status(400).json({ error: 'invalid node_id' });
        const rows = await sql.query(
          `SELECT ${SELECT_COLS} FROM issues
           WHERE user_id = $1 AND node_id = $2
           ORDER BY
             CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1
                          WHEN 'done' THEN 2 WHEN 'wontfix' THEN 3 ELSE 4 END,
             priority DESC, created_at DESC`,
          [userId, node_id]
        );
        return res.status(200).json({ issues: rows });
      }
      // 全件（ユーザー単位）
      const rows = await sql.query(
        `SELECT ${SELECT_COLS} FROM issues
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 500`,
        [userId]
      );
      return res.status(200).json({ issues: rows });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const node_id = (typeof body?.node_id === 'string' && isUuid(body.node_id)) ? body.node_id : null;
      if (node_id) {
        const n = await sql`SELECT id FROM nodes WHERE id = ${node_id} AND user_id = ${userId}`;
        if (!n[0]) return res.status(404).json({ error: 'node not found' });
      }
      const title = clean(body?.title, MAX_TITLE);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const description = typeof body?.description === 'string' ? body.description.slice(0, MAX_DESCRIPTION) : '';
      const status = ALLOWED_STATUS.has(body?.status) ? body.status : 'open';
      const priority = (typeof body?.priority === 'number' && Number.isFinite(body.priority))
        ? Math.max(0, Math.min(2, Math.floor(body.priority))) : 0;
      const due = parseDueDate(body?.due_date);
      if (due === undefined && body?.due_date != null && body?.due_date !== '') {
        return res.status(400).json({ error: 'due_date must be YYYY-MM-DD or null' });
      }
      const source_fragment_ids = Array.isArray(body?.source_fragment_ids)
        ? body.source_fragment_ids.filter((x) => typeof x === 'string' && isUuid(x))
        : [];

      const rows = await sql.query(
        `INSERT INTO issues (user_id, node_id, title, description, status, priority, due_date, source_fragment_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[])
         RETURNING ${SELECT_COLS}`,
        [userId, node_id, title, description, status, priority, due, source_fragment_ids]
      );
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      if (!isUuid(id)) return res.status(400).json({ error: 'valid uuid id is required' });
      const body = await readJson(req);
      const fields = {};

      const title = clean(body?.title, MAX_TITLE);
      if (title !== null) fields.title = title;
      if (typeof body?.description === 'string') fields.description = body.description.slice(0, MAX_DESCRIPTION);
      if (typeof body?.status === 'string' && ALLOWED_STATUS.has(body.status)) fields.status = body.status;
      if (typeof body?.priority === 'number' && Number.isFinite(body.priority)) {
        fields.priority = Math.max(0, Math.min(2, Math.floor(body.priority)));
      }
      if ('due_date' in (body || {})) {
        const due = parseDueDate(body.due_date);
        if (due === undefined && body.due_date != null && body.due_date !== '') {
          return res.status(400).json({ error: 'due_date must be YYYY-MM-DD or null' });
        }
        fields.due_date = due ?? null;
      }
      if ('node_id' in (body || {})) {
        const v = body.node_id;
        if (v === null) fields.node_id = null;
        else if (typeof v === 'string' && isUuid(v)) {
          const n = await sql`SELECT id FROM nodes WHERE id = ${v} AND user_id = ${userId}`;
          if (!n[0]) return res.status(404).json({ error: 'node not found' });
          fields.node_id = v;
        }
      }

      const cols = Object.keys(fields);
      if (cols.length === 0) {
        const rows = await sql.query(
          `SELECT ${SELECT_COLS} FROM issues WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }
      const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map((c) => fields[c]);
      const rows = await sql.query(
        `UPDATE issues SET ${setClauses}, updated_at = now()
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
        DELETE FROM issues WHERE id = ${id} AND user_id = ${userId}
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
