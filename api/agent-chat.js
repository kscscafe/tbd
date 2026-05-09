import Anthropic from '@anthropic-ai/sdk';
import { getSql, setCors, readJson, isUuid, requireSession } from './_lib.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_HISTORY = 30;
const MAX_FRAGMENTS_CTX = 100;
const MAX_OUTPUTS_CTX = 20;
const MAX_OUTPUT_PREVIEW = 300;

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const userId = requireSession(req, res);
  if (!userId) return;

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const node_id = body?.node_id;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!isUuid(node_id)) return res.status(400).json({ error: 'node_id (uuid) is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  // デフォルト：親ノード呼び出し時は子孫の文脈も含める
  const include_descendants = body?.include_descendants !== false;

  let sql;
  try { sql = getSql(); } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }

  const nodeRows = await sql`
    SELECT id, name, system_prompt
    FROM nodes
    WHERE id = ${node_id} AND user_id = ${userId}
  `;
  const node = nodeRows[0];
  if (!node) return res.status(404).json({ error: 'Node not found' });

  let nodeIds = [node_id];
  if (include_descendants) {
    const desc = await sql.query(
      `WITH RECURSIVE d AS (
         SELECT id FROM nodes WHERE id = $1 AND user_id = $2
         UNION
         SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id WHERE n.user_id = $2
       ) SELECT id FROM d`,
      [node_id, userId]
    );
    nodeIds = desc.map((r) => r.id);
  }

  const fragments = await sql`
    SELECT raw_text, created_at
    FROM fragments
    WHERE user_id = ${userId} AND node_id = ANY(${nodeIds}::uuid[])
    ORDER BY created_at DESC
    LIMIT ${MAX_FRAGMENTS_CTX}
  `;
  const outputs = await sql`
    SELECT title, content, type, created_at
    FROM outputs
    WHERE user_id = ${userId} AND node_id = ANY(${nodeIds}::uuid[])
    ORDER BY created_at DESC
    LIMIT ${MAX_OUTPUTS_CTX}
  `;

  const ctxParts = [
    `あなたは「${node.name}」というテーマを担当するエージェントです。`,
    node.system_prompt || '',
  ];
  if (fragments.length > 0) {
    ctxParts.push('', '【蓄積された断片（新しい順）】');
    for (const f of fragments) ctxParts.push(`- ${f.raw_text}`);
  }
  if (outputs.length > 0) {
    ctxParts.push('', '【過去の成果物】');
    for (const o of outputs) {
      const prev = String(o.content || '').slice(0, MAX_OUTPUT_PREVIEW);
      ctxParts.push(`- [${o.type}] ${o.title}\n  ${prev}`);
    }
  }
  const systemCtx = ctxParts.filter(Boolean).join('\n');

  const rawHistory = Array.isArray(body?.history) ? body.history : [];
  const history = rawHistory
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .slice(-MAX_HISTORY)
    .map((h) => ({ role: h.role, content: h.content }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  const anthropic = new Anthropic({ apiKey });

  let reply, usage;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemCtx,
      messages: [...history, { role: 'user', content: message }],
    });
    reply = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    usage = resp.usage;
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({ error: 'LLM error', detail: String(e.message || e) });
  }

  return res.status(200).json({ reply, usage });
}
