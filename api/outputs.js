import { getSql, setCors, readJson, isUuid, requireSession } from './_lib.js';

const MAX_TITLE = 200;
const MAX_CONTENT = 50000;
const ALLOWED_TYPES = new Set(['proposal', 'email', 'minutes', 'spec', 'free']);

const SELECT_COLS = `
  id, user_id, node_id, type, title, content,
  source_fragment_ids, version, parent_output_id, created_at
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
          `SELECT ${SELECT_COLS} FROM outputs WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }
      const node_id = req.query?.node_id;
      if (!isUuid(node_id)) return res.status(400).json({ error: 'node_id (uuid) is required' });
      const rows = await sql.query(
        `SELECT ${SELECT_COLS} FROM outputs
         WHERE user_id = $1 AND node_id = $2
         ORDER BY created_at DESC`,
        [userId, node_id]
      );
      return res.status(200).json({ outputs: rows });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const node_id = body?.node_id;
      if (!isUuid(node_id)) return res.status(400).json({ error: 'node_id (uuid) is required' });
      const node = await sql`SELECT id FROM nodes WHERE id = ${node_id} AND user_id = ${userId}`;
      if (!node[0]) return res.status(404).json({ error: 'node not found' });

      const title = clean(body?.title, MAX_TITLE) || '無題';
      const content = typeof body?.content === 'string' ? body.content.slice(0, MAX_CONTENT) : '';
      const type = ALLOWED_TYPES.has(body?.type) ? body.type : 'free';
      const source_fragment_ids = Array.isArray(body?.source_fragment_ids)
        ? body.source_fragment_ids.filter((x) => typeof x === 'string' && isUuid(x))
        : [];

      // parent_output_id があれば再生成として系譜を辿り version をインクリメント
      let version = 1;
      let parent_output_id = null;
      if (typeof body?.parent_output_id === 'string' && isUuid(body.parent_output_id)) {
        const parent = await sql`
          SELECT version FROM outputs
          WHERE id = ${body.parent_output_id} AND user_id = ${userId}
        `;
        if (parent[0]) {
          version = (parent[0].version || 1) + 1;
          parent_output_id = body.parent_output_id;
        }
      }

      const rows = await sql.query(
        `INSERT INTO outputs
           (user_id, node_id, type, title, content, source_fragment_ids, version, parent_output_id)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8)
         RETURNING ${SELECT_COLS}`,
        [userId, node_id, type, title, content, source_fragment_ids, version, parent_output_id]
      );
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      if (!isUuid(id)) return res.status(400).json({ error: 'valid uuid id is required' });
      const body = await readJson(req);
      const fields = {};
      const title = clean(body?.title, MAX_TITLE);
      if (title !== null) fields.title = title;
      if (typeof body?.content === 'string') fields.content = body.content.slice(0, MAX_CONTENT);
      if (ALLOWED_TYPES.has(body?.type)) fields.type = body.type;

      const cols = Object.keys(fields);
      if (cols.length === 0) {
        const rows = await sql.query(
          `SELECT ${SELECT_COLS} FROM outputs WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }
      const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map((c) => fields[c]);
      const rows = await sql.query(
        `UPDATE outputs SET ${setClauses}
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
        DELETE FROM outputs WHERE id = ${id} AND user_id = ${userId}
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
