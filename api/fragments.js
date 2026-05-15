import { getSql, setCors, readJson, isUuid, requireSession } from './_lib.js';

const MAX_RAW_TEXT = 4000;
const ALLOWED_SOURCES = new Set(['text', 'voice', 'file']);
const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

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

  try {
    if (req.method === 'GET') {
      const node_id = req.query?.node_id;
      const unassigned = req.query?.unassigned === '1';
      const rawLimit = Number(req.query?.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), LIST_LIMIT_MAX)
        : LIST_LIMIT_DEFAULT;

      let rows;
      if (unassigned) {
        rows = await sql`
          SELECT id, user_id, node_id, raw_text, source, source_meta, created_at
          FROM fragments
          WHERE user_id = ${userId} AND node_id IS NULL
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else if (node_id) {
        if (!isUuid(node_id)) return res.status(400).json({ error: 'invalid node_id' });
        rows = await sql`
          SELECT id, user_id, node_id, raw_text, source, source_meta, created_at
          FROM fragments
          WHERE user_id = ${userId} AND node_id = ${node_id}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else {
        rows = await sql`
          SELECT id, user_id, node_id, raw_text, source, source_meta, created_at
          FROM fragments
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      }
      return res.status(200).json({ fragments: rows });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const raw_text = clean(body?.raw_text, MAX_RAW_TEXT);
      if (!raw_text) return res.status(400).json({ error: 'raw_text is required' });
      const source = ALLOWED_SOURCES.has(body?.source) ? body.source : 'text';
      // jsonb は文字列で受けて ::jsonb キャスト（pg の object 直渡しは [object Object] 化する）
      const meta = (body?.source_meta && typeof body.source_meta === 'object')
        ? JSON.stringify(body.source_meta)
        : null;

      const rows = await sql`
        INSERT INTO fragments (user_id, raw_text, source, source_meta)
        VALUES (${userId}, ${raw_text}, ${source}, ${meta}::jsonb)
        RETURNING id, user_id, node_id, raw_text, source, source_meta, created_at
      `;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      const id = req.query?.id;
      if (!isUuid(id)) return res.status(400).json({ error: 'valid uuid id is required' });
      const body = await readJson(req);
      const fields = {};
      // 手動でノードに割り当て / 未分類に戻す
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
        return res.status(400).json({ error: 'no fields to update' });
      }
      const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = cols.map((c) => fields[c]);
      const rows = await sql.query(
        `UPDATE fragments SET ${setClauses}
         WHERE id = $${cols.length + 1} AND user_id = $${cols.length + 2}
         RETURNING id, user_id, node_id, raw_text, source, source_meta, created_at`,
        [...values, id, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!isUuid(id)) return res.status(400).json({ error: 'valid uuid id is required' });
      const rows = await sql`
        DELETE FROM fragments WHERE id = ${id} AND user_id = ${userId}
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
