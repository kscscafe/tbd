import Anthropic from '@anthropic-ai/sdk';
import { getSql, setCors, requireSession } from './_lib.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;
const MAX_FRAGMENTS = 200;
const MAX_NAME = 30;
const MAX_PROMPT = 4000;

const SYSTEM_PROMPT = [
  'あなたはユーザーの思考の断片を、ツリー構造に自動整理するエージェントです。',
  '',
  '【ユーザー特性】',
  '- ASD/ADHD 傾向で、自分で分類するのが苦手',
  '- 全体像をツリーで把握したい',
  '- 関連性が見える方が嬉しい',
  '',
  '【判断ルール】',
  '- 未分類の断片を読み、似た内容ごとにグループ化',
  '- 既存ツリーに明確に近いノードがあれば、そのノードに追加（target.type = "existing_node"）',
  '- 既存の親ノードの新しい側面なら、その下に子ノードを新規作成（target.type = "new_child"）',
  '- どの既存ツリーにも合わない場合のみ、新しいルートノードを作る（target.type = "new_root"）',
  '- ノード名は10文字以内で端的に（例：「営業」「LOUD」「妙蔵寺」）',
  '- 名前・system_prompt には絵文字を一切使わないこと',
  '- 既存ノードの名前・system_prompt は変更してはいけない（追記型）',
  '- 新規ノードには、そのテーマを担当するエージェントとして振る舞うための簡潔な system_prompt を書く（200字以内、装飾なしの平易な日本語）',
  '',
  '【出力形式】',
  '次のJSONのみを出力してください。前後の説明文・コードフェンスは付けないこと。',
  '{',
  '  "groups": [',
  '    {',
  '      "target": { "type": "existing_node", "label": "N3" },',
  '      "fragment_indices": [0, 2]',
  '    },',
  '    {',
  '      "target": { "type": "new_child", "parent_label": "N2", "name": "経理", "system_prompt": "..." },',
  '      "fragment_indices": [1]',
  '    },',
  '    {',
  '      "target": { "type": "new_root", "name": "新分野", "system_prompt": "..." },',
  '      "fragment_indices": [3]',
  '    }',
  '  ]',
  '}',
].join('\n');

// 既存ノードを階層インデント付き文字列にし、ラベル→id のマップを返す。
function buildTreeString(nodes) {
  const byParent = new Map();
  for (const n of nodes) {
    const key = n.parent_id ?? '__root__';
    const arr = byParent.get(key) || [];
    arr.push(n);
    byParent.set(key, arr);
  }
  for (const [, arr] of byParent) {
    arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }

  const idByLabel = new Map();
  const lines = [];
  let counter = 1;
  function recurse(parentKey, depth) {
    const arr = byParent.get(parentKey) || [];
    for (const n of arr) {
      const label = `N${counter++}`;
      idByLabel.set(label, n.id);
      const indent = '  '.repeat(depth);
      lines.push(`${indent}[${label}] ${n.name}`);
      recurse(n.id, depth + 1);
    }
  }
  recurse('__root__', 0);
  return { tree: lines.join('\n'), idByLabel };
}

// AI 出力から最初の JSON オブジェクトを抜き出す（コードフェンスや前置きを排除）。
function extractJson(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start === -1) throw new Error('No JSON object in response');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error('Unbalanced JSON');
}

const NODE_RETURNING_COLS = `
  id, user_id, parent_id, name, system_prompt,
  status, progress, priority, next_action,
  auto_named, sort_order, created_at, updated_at
`;

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const userId = requireSession(req, res);
  if (!userId) return;

  let sql;
  try { sql = getSql(); } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }

  const fragments = await sql`
    SELECT id, raw_text
    FROM fragments
    WHERE user_id = ${userId} AND node_id IS NULL
    ORDER BY created_at ASC
    LIMIT ${MAX_FRAGMENTS}
  `;
  if (fragments.length === 0) {
    return res.status(200).json({
      assigned: 0, created_nodes: 0,
      message: '未分類の断片がありません',
    });
  }

  const nodes = await sql`
    SELECT id, parent_id, name, sort_order
    FROM nodes WHERE user_id = ${userId}
  `;
  const { tree, idByLabel } = buildTreeString(nodes);

  const userMessage = [
    nodes.length > 0
      ? '【既存のツリー】（参考情報。既存ノードの名前は変更しないこと）\n' + tree
      : '【既存のツリー】（まだ何もありません。すべて新規ノードとして整理してください）',
    '',
    '【未分類の断片】',
    ...fragments.map((f, i) => `[${i}] ${f.raw_text}`),
    '',
    '上記の未分類断片を、既存ノードへの追加か新規ノード作成として振り分けてください。',
  ].join('\n');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  const anthropic = new Anthropic({ apiKey });

  let parsed;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    parsed = extractJson(text);
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({ error: 'LLM error', detail: String(e.message || e) });
  }

  if (!parsed || !Array.isArray(parsed.groups)) {
    return res.status(502).json({ error: 'Unexpected LLM output shape' });
  }

  // 親ごとの末尾 sort_order を把握しつつ、新規ノード追加で更新していく。
  const maxSortByParent = new Map();
  for (const n of nodes) {
    const key = n.parent_id ?? '__root__';
    const cur = maxSortByParent.get(key) ?? -1;
    if ((n.sort_order ?? 0) > cur) maxSortByParent.set(key, n.sort_order ?? 0);
  }
  function nextSort(parentKey) {
    const cur = maxSortByParent.get(parentKey) ?? -1;
    const next = cur + 1;
    maxSortByParent.set(parentKey, next);
    return next;
  }

  // 同一実行内で同じ name + parent の new_child / new_root を重複作成しないための dedup。
  const newKey = new Map();
  const insertedNodes = [];
  let totalAssigned = 0;

  try {
    for (const g of parsed.groups) {
      const t = g?.target;
      if (!t || typeof t !== 'object') continue;
      const idxs = Array.isArray(g?.fragment_indices) ? g.fragment_indices : [];
      const fragmentIds = idxs
        .map((i) => fragments[i]?.id)
        .filter((x) => typeof x === 'string');
      if (fragmentIds.length === 0) continue;

      let nodeId = null;

      if (t.type === 'existing_node' && typeof t.label === 'string') {
        nodeId = idByLabel.get(t.label) || null;
      } else if (t.type === 'new_child' && typeof t.parent_label === 'string' && typeof t.name === 'string') {
        const parentId = idByLabel.get(t.parent_label);
        if (!parentId) continue;
        const name = t.name.trim().slice(0, MAX_NAME);
        if (!name) continue;
        const key = `${parentId}|${name}`;
        if (newKey.has(key)) {
          nodeId = newKey.get(key);
        } else {
          const sysp = (typeof t.system_prompt === 'string' ? t.system_prompt : '').slice(0, MAX_PROMPT);
          const order = nextSort(parentId);
          const [created] = await sql.query(
            `INSERT INTO nodes (user_id, parent_id, name, system_prompt, auto_named, sort_order)
             VALUES ($1, $2, $3, $4, true, $5)
             RETURNING ${NODE_RETURNING_COLS}`,
            [userId, parentId, name, sysp, order]
          );
          newKey.set(key, created.id);
          insertedNodes.push(created);
          nodeId = created.id;
        }
      } else if (t.type === 'new_root' && typeof t.name === 'string') {
        const name = t.name.trim().slice(0, MAX_NAME);
        if (!name) continue;
        const key = `__root__|${name}`;
        if (newKey.has(key)) {
          nodeId = newKey.get(key);
        } else {
          const sysp = (typeof t.system_prompt === 'string' ? t.system_prompt : '').slice(0, MAX_PROMPT);
          const order = nextSort('__root__');
          const [created] = await sql.query(
            `INSERT INTO nodes (user_id, parent_id, name, system_prompt, auto_named, sort_order)
             VALUES ($1, NULL, $2, $3, true, $4)
             RETURNING ${NODE_RETURNING_COLS}`,
            [userId, name, sysp, order]
          );
          newKey.set(key, created.id);
          insertedNodes.push(created);
          nodeId = created.id;
        }
      }

      if (!nodeId) continue;

      const updated = await sql`
        UPDATE fragments
        SET node_id = ${nodeId}
        WHERE id = ANY(${fragmentIds}::uuid[])
          AND user_id = ${userId}
          AND node_id IS NULL
        RETURNING id
      `;
      totalAssigned += updated.length;
    }
  } catch (e) {
    return res.status(500).json({ error: 'DB write failed', detail: String(e.message || e) });
  }

  return res.status(200).json({
    assigned: totalAssigned,
    created_nodes: insertedNodes.length,
    nodes: insertedNodes,
  });
}
