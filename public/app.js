// ─────────────────────────────────────────────────────────────────
// TBD: 思考の星座 (Constellation) UI
//
// - 大きな丸 = エージェント。ドラッグで自由配置、位置は DB に保存
// - 小さな丸 = 未分類の断片（空きに浮かぶ。整理すると消えて星に吸収）
// - 投入時はニコニコ動画的に画面を流れる
// - ノードを別のノードに重ねてドロップ → 子ノードにする
// ─────────────────────────────────────────────────────────────────

const STATE = {
  user: null,
  token: null,
  nodes: [],
  unassigned: [],
  selectedNodeId: null,
  selectedNode: null,
  selectedIds: new Set(),  // 複数選択（グループ化用、Shift+クリックで切替）
  fragments: [],
  issues: [],
  outputs: [],
  chatHistory: {},
  lastAssistantReply: null,
  view: 'canvas',
  drawerTab: 'chat',
};

const STATUS = {
  active:  { fill: '#bbf7d0', stroke: '#16a34a', label: '進行中' },
  waiting: { fill: '#fef3c7', stroke: '#d97706', label: '待ち' },
  blocked: { fill: '#fecaca', stroke: '#dc2626', label: '止まり' },
  dormant: { fill: '#e5e7eb', stroke: '#9ca3af', label: '休眠' },
  done:    { fill: '#dbeafe', stroke: '#2563eb', label: '完了' },
};
const STATUS_KEYS = ['active', 'waiting', 'blocked', 'dormant', 'done'];
const PRIORITY_LABELS = ['低', '中', '高'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}
function renderMarkdown(text) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escapeHtml(text);
  return DOMPurify.sanitize(marked.parse(text || ''));
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(path, opts = {}) {
  const headers = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    'X-Session-Token': STATE.token || '',
    ...(opts.headers || {}),
  };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function logout() {
  localStorage.removeItem('tbd_token');
  localStorage.removeItem('tbd_user');
  location.href = '/login.html';
}

// ─────────────────────────────────────────────────────────────────
// D3 力学シミュレーション
//
// agentItems と fragmentItems を一つの simulation で扱う。
// _kind で分けて、charge/render を切り替える。
// ─────────────────────────────────────────────────────────────────
let simulation = null;
let svg, linkGroup, nodeGroup, fragmentGroup, fxLayer;
let simItems = []; // 同一性を保つために保持

function nodeRadius(n) {
  const c = n.fragment_count || 0;
  return 28 + Math.min(40, Math.sqrt(c) * 9);
}

function ensureSimulation() {
  if (simulation) return;
  svg = d3.select('#canvas');
  // 描画順：links → fragments（小さい）→ agents（大きい）→ fxLayer（流星・スクロール文字）
  linkGroup = svg.append('g').attr('class', 'links');
  fragmentGroup = svg.append('g').attr('class', 'fragments');
  nodeGroup = svg.append('g').attr('class', 'nodes');
  fxLayer = svg.append('g').attr('class', 'fx');

  const w = svg.node().clientWidth;
  const h = svg.node().clientHeight;
  simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id((d) => d.id).distance(140).strength(0.4))
    .force('charge', d3.forceManyBody()
      .strength((d) => d._kind === 'fragment' ? -30 : -380))
    .force('center', d3.forceCenter(w / 2, h / 2).strength(0.05))
    .force('collide', d3.forceCollide().radius((d) => (d.r || 12) + 6))
    // 画面外に出ないようにクランプする境界力（独自）
    .force('bounds', () => {
      const cw = svg.node().clientWidth;
      const ch = svg.node().clientHeight;
      const margin = 12;
      for (const d of simItems) {
        const r = (d.r || 12) + margin;
        if (d.x < r) d.x = r;
        if (d.x > cw - r) d.x = cw - r;
        if (d.y < r) d.y = r;
        if (d.y > ch - r) d.y = ch - r;
      }
    })
    .alphaDecay(0.05)
    .on('tick', tick);

  // SVG 背景クリック → ドロワーを閉じ、複数選択も解除
  svg.on('click', () => {
    if (STATE.selectedIds.size > 0) {
      STATE.selectedIds.clear();
      renderConstellation();
      updateActionBar();
    }
    closeDrawer();
  });
}

function tick() {
  linkGroup.selectAll('line')
    .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
    .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
  nodeGroup.selectAll('g.node')
    .attr('transform', (d) => `translate(${d.x},${d.y})`);
  fragmentGroup.selectAll('circle.frag')
    .attr('cx', (d) => d.x).attr('cy', (d) => d.y);
}

function renderConstellation() {
  ensureSimulation();

  const oldById = new Map(simItems.map((n) => [n.id, n]));

  // エージェント（大きな丸）
  const agentItems = STATE.nodes.map((n) => {
    const old = oldById.get(n.id);
    // 保存位置 (position_x/y) があればそれを fx/fy として固定
    const fx = (n.position_x != null) ? n.position_x : (old?.fx ?? null);
    const fy = (n.position_y != null) ? n.position_y : (old?.fy ?? null);
    return {
      ...n,
      _kind: 'agent',
      r: nodeRadius(n),
      x: old?.x ?? fx ?? undefined,
      y: old?.y ?? fy ?? undefined,
      fx, fy,
      vx: old?.vx, vy: old?.vy,
    };
  });

  // 未分類フラグメント（小さな丸）。新規分は画面内のランダム位置に置く。
  const cw = svg ? svg.node().clientWidth : 800;
  const ch = svg ? svg.node().clientHeight : 600;
  const fragmentItems = STATE.unassigned.map((f) => {
    const id = 'frag-' + f.id;
    const old = oldById.get(id);
    let x = old?.x, y = old?.y;
    if (x == null) {
      x = cw * (0.15 + Math.random() * 0.7);
      y = ch * (0.15 + Math.random() * 0.7);
    }
    return {
      id,
      real_id: f.id,
      raw_text: f.raw_text,
      _kind: 'fragment',
      r: 14,
      x, y,
      vx: old?.vx, vy: old?.vy,
    };
  });

  simItems = [...agentItems, ...fragmentItems];

  // リンク：エージェント間の親子のみ
  const idSet = new Set(agentItems.map((n) => n.id));
  const links = agentItems
    .filter((n) => n.parent_id && idSet.has(n.parent_id))
    .map((n) => ({ source: n.parent_id, target: n.id }));

  // links 描画
  const linkSel = linkGroup.selectAll('line').data(links, (d) =>
    `${typeof d.source === 'object' ? d.source.id : d.source}__${typeof d.target === 'object' ? d.target.id : d.target}`
  );
  linkSel.exit().remove();
  linkSel.enter().append('line').attr('class', 'link-line');

  // agents 描画
  const nodeSel = nodeGroup.selectAll('g.node').data(agentItems, (d) => d.id);
  nodeSel.exit().remove();
  const enter = nodeSel.enter().append('g').attr('class', 'node')
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag', dragged)
      .on('end', dragEnd));
  enter.append('circle').attr('class', 'node-circle');
  enter.append('text').attr('class', 'node-label').attr('text-anchor', 'middle').attr('dy', '0.35em');
  enter.append('text').attr('class', 'node-meta').attr('text-anchor', 'middle');

  const merged = enter.merge(nodeSel);
  merged.on('click', (e, d) => {
    e.stopPropagation();
    if (d._dragMoved) { d._dragMoved = false; return; } // ドラッグ後のクリック抑止
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      // 複数選択トグル
      if (STATE.selectedIds.has(d.id)) STATE.selectedIds.delete(d.id);
      else STATE.selectedIds.add(d.id);
      renderConstellation();
      updateActionBar();
      return;
    }
    openDrawer(d.id);
  });
  merged.select('circle')
    .attr('r', (d) => d.r)
    .attr('fill', (d) => STATUS[d.status]?.fill || '#e5e7eb')
    .attr('stroke', (d) => {
      if (STATE.selectedIds.has(d.id)) return '#f59e0b';     // 複数選択中：オレンジ
      if (d.id === STATE.selectedNodeId) return '#1d4ed8';   // ドロワー選択：青
      return STATUS[d.status]?.stroke || '#9ca3af';
    })
    .attr('stroke-width', (d) =>
      (STATE.selectedIds.has(d.id) || d.id === STATE.selectedNodeId) ? 4 : 2)
    .style('opacity', (d) => d.status === 'dormant' ? 0.6 : 1);
  merged.select('.node-label')
    .attr('y', 0)
    .text((d) => d.name.length > 10 ? d.name.slice(0, 10) + '…' : d.name);
  merged.select('.node-meta')
    .attr('y', (d) => d.r + 14)
    .text((d) => {
      const parts = [STATUS[d.status]?.label || d.status];
      if (d.fragment_count) parts.push(`断片${d.fragment_count}`);
      if (d.open_issue_count) parts.push(`課題${d.open_issue_count}`);
      if (d.progress) parts.push(`${d.progress}%`);
      return parts.join(' ・ ');
    });

  // fragments 描画（ドラッグ・Shift+クリック対応）
  const fragSel = fragmentGroup.selectAll('circle.frag').data(fragmentItems, (d) => d.id);
  fragSel.exit().remove();
  const fragEnter = fragSel.enter().append('circle').attr('class', 'frag')
    .call(d3.drag()
      .on('start', dragFragmentStart)
      .on('drag', dragFragmentDragged)
      .on('end', dragFragmentEnd));
  fragEnter.append('title');
  const fragMerged = fragEnter.merge(fragSel);
  fragMerged
    .attr('r', 14)
    .attr('fill', (d) => STATE.selectedIds.has(d.id) ? '#fde68a' : '#bfdbfe')
    .attr('stroke', (d) => STATE.selectedIds.has(d.id) ? '#f59e0b' : '#2563eb')
    .attr('stroke-width', (d) => STATE.selectedIds.has(d.id) ? 4 : 2)
    .style('opacity', 0.95)
    .style('cursor', 'pointer')
    .on('click', (e, d) => {
      e.stopPropagation();
      if (d._dragMoved) { d._dragMoved = false; return; }
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (STATE.selectedIds.has(d.id)) STATE.selectedIds.delete(d.id);
        else STATE.selectedIds.add(d.id);
        renderConstellation();
        updateActionBar();
      }
    });
  fragMerged.select('title').text((d) => d.raw_text);

  simulation.nodes(simItems);
  simulation.force('link').links(links);
  simulation.alpha(0.4).restart();

  $('#empty-state').classList.toggle('hidden', simItems.length > 0);
}

function dragStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d._dragStartX = d.x; d._dragStartY = d.y;
  d._dragMoved = false;
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) {
  d.fx = event.x; d.fy = event.y;
  if (Math.hypot(d.fx - d._dragStartX, d.fy - d._dragStartY) > 4) {
    d._dragMoved = true;
  }
  // ドロップ先候補のハイライト
  const target = findDropTarget(d, event.x, event.y);
  nodeGroup.selectAll('.node-circle')
    .classed('drop-target', false);
  if (target) {
    nodeGroup.selectAll('g.node')
      .filter((n) => n.id === target.id)
      .select('.node-circle')
      .classed('drop-target', true);
  }
}
function dragEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  nodeGroup.selectAll('.node-circle').classed('drop-target', false);

  if (!d._dragMoved) return; // クリックっぽい操作

  const target = findDropTarget(d, d.fx, d.fy);
  if (target) {
    // 親子化
    if (confirm(`「${d.name}」を「${target.name}」の子にしますか？`)) {
      makeChild(d.id, target.id);
    } else {
      // キャンセルなら位置のみ保存
      savePosition(d.id, d.fx, d.fy);
    }
  } else {
    // 通常のドラッグ：位置保存
    savePosition(d.id, d.fx, d.fy);
  }
}

function findDropTarget(d, x, y) {
  // 自分以外のエージェントに重なっているか
  return simItems.find((n) =>
    n._kind === 'agent' && n.id !== d.id &&
    Math.hypot(n.x - x, n.y - y) < (n.r - 4)
  );
}

// ─────────────────────────────────────────────────────────────────
// フラグメントのドラッグ：エージェントに重ねる → 手動割り当て
// ─────────────────────────────────────────────────────────────────
function dragFragmentStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d._dragStartX = d.x; d._dragStartY = d.y;
  d._dragMoved = false;
  d.fx = d.x; d.fy = d.y;
}
function dragFragmentDragged(event, d) {
  d.fx = event.x; d.fy = event.y;
  if (Math.hypot(d.fx - d._dragStartX, d.fy - d._dragStartY) > 4) {
    d._dragMoved = true;
  }
  const target = findDropTarget(d, event.x, event.y);
  nodeGroup.selectAll('.node-circle').classed('drop-target', false);
  if (target) {
    nodeGroup.selectAll('g.node')
      .filter((n) => n.id === target.id)
      .select('.node-circle')
      .classed('drop-target', true);
  }
}
function dragFragmentEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  nodeGroup.selectAll('.node-circle').classed('drop-target', false);
  if (!d._dragMoved) {
    // クリック扱いに任せる。fx/fy は維持（その場に留める）
    return;
  }
  const target = findDropTarget(d, d.fx, d.fy);
  if (target) {
    if (confirm(`この断片を「${target.name}」に入れますか？`)) {
      assignFragmentToNode(d.real_id, target.id);
    }
  }
  // フラグメント位置は永続化しない（一時的な存在）。ただしセッション中は留める
}

async function assignFragmentToNode(fragmentId, nodeId) {
  try {
    await api(`/api/fragments?id=${fragmentId}`, {
      method: 'PUT',
      body: JSON.stringify({ node_id: nodeId }),
    });
    await Promise.all([loadNodes(), loadUnassigned()]);
    if (STATE.selectedNodeId === nodeId) await loadDrawerContent();
    toast('断片を割り当てました');
  } catch (e) {
    toast('エラー: ' + e.message);
  }
}

async function savePosition(nodeId, x, y) {
  try {
    const updated = await api(`/api/nodes?id=${nodeId}`, {
      method: 'PUT',
      body: JSON.stringify({ position_x: x, position_y: y }),
    });
    const idx = STATE.nodes.findIndex((n) => n.id === nodeId);
    if (idx >= 0) STATE.nodes[idx] = { ...STATE.nodes[idx], ...updated };
  } catch (e) {
    toast('位置保存失敗: ' + e.message);
  }
}

async function makeChild(childId, newParentId) {
  try {
    const updated = await api(`/api/nodes?id=${childId}`, {
      method: 'PUT',
      body: JSON.stringify({ parent_id: newParentId }),
    });
    const idx = STATE.nodes.findIndex((n) => n.id === childId);
    if (idx >= 0) STATE.nodes[idx] = { ...STATE.nodes[idx], ...updated };
    renderConstellation();
    toast('親子関係を更新しました');
  } catch (e) {
    toast('エラー: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// 親を解除（ルートに戻す）／ グループ化（複数選択 → 新しい親で束ねる）
// ─────────────────────────────────────────────────────────────────
async function detachFromParent() {
  const node = STATE.selectedNode;
  if (!node || !node.parent_id) return;
  try {
    const updated = await api(`/api/nodes?id=${node.id}`, {
      method: 'PUT',
      body: JSON.stringify({ parent_id: null }),
    });
    const idx = STATE.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) STATE.nodes[idx] = { ...STATE.nodes[idx], ...updated };
    STATE.selectedNode = { ...STATE.selectedNode, ...updated };
    fillDrawerControls();
    updateDetachButton();
    if (STATE.view === 'canvas') renderConstellation(); else renderTable();
    toast('親を解除しました');
  } catch (e) {
    toast('エラー: ' + e.message);
  }
}

function updateDetachButton() {
  const has = STATE.selectedNode?.parent_id;
  $('#btn-detach').classList.toggle('hidden', !has);
}

function updateActionBar() {
  const n = STATE.selectedIds.size;
  $('#action-bar').classList.toggle('hidden', n === 0);
  $('#action-count').textContent = n;
  $('#btn-group').disabled = n < 2;
}

async function groupSelected() {
  const ids = [...STATE.selectedIds];
  if (ids.length < 2) {
    toast('2つ以上選択してください（Shift+クリック）');
    return;
  }
  // ノードIDと未分類フラグメントIDを分離
  const nodeIds = ids.filter((id) => STATE.nodes.some((n) => n.id === id));
  const fragmentIds = ids
    .filter((id) => typeof id === 'string' && id.startsWith('frag-'))
    .map((id) => id.slice(5));

  const name = prompt(`新しいグループの名前：（ノード${nodeIds.length}件、断片${fragmentIds.length}件をまとめます）`);
  if (!name || !name.trim()) return;

  $('#btn-group').disabled = true;
  try {
    const parent = await api('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), parent_id: null }),
    });
    // 既存ノードを子に
    for (const id of nodeIds) {
      await api(`/api/nodes?id=${id}`, {
        method: 'PUT',
        body: JSON.stringify({ parent_id: parent.id }),
      });
    }
    // 断片を新ノード配下に割り当て
    for (const fid of fragmentIds) {
      await api(`/api/fragments?id=${fid}`, {
        method: 'PUT',
        body: JSON.stringify({ node_id: parent.id }),
      });
    }
    STATE.selectedIds.clear();
    await Promise.all([loadNodes(), loadUnassigned()]);
    updateActionBar();
    toast(`「${parent.name}」にグループ化（ノード${nodeIds.length} ・ 断片${fragmentIds.length}）`);
  } catch (e) {
    toast('エラー: ' + e.message);
  } finally {
    updateActionBar();
  }
}

// ─────────────────────────────────────────────────────────────────
// ニコニコ動画風：投入したテキストが画面を右→左に流れる
// ─────────────────────────────────────────────────────────────────
function niconicoFly(text) {
  if (!svg || !fxLayer) return;
  const w = svg.node().clientWidth;
  const h = svg.node().clientHeight;
  const y = 40 + Math.random() * Math.max(0, h - 100);
  const display = text.length > 40 ? text.slice(0, 40) + '…' : text;

  const txt = fxLayer.append('text')
    .attr('x', w + 10)
    .attr('y', y)
    .attr('font-size', 18)
    .attr('font-weight', 600)
    .attr('fill', '#1d4ed8')
    .attr('opacity', 0.9)
    .style('paint-order', 'stroke')
    .style('stroke', 'white')
    .style('stroke-width', '4px')
    .text(display);

  const node = txt.node();
  const textWidth = node.getComputedTextLength?.() || 200;
  const distance = w + textWidth + 20;
  const duration = 4500;
  const start = performance.now();

  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const x = (w + 10) - distance * t;
    txt.attr('x', x);
    if (t < 1) requestAnimationFrame(step);
    else txt.remove();
  }
  requestAnimationFrame(step);
}

// ─────────────────────────────────────────────────────────────────
// 表ビュー
// ─────────────────────────────────────────────────────────────────
function renderTable() {
  const body = $('#table-body');
  if (STATE.nodes.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gray-500">エージェントがまだありません</td></tr>';
    return;
  }
  const byParent = new Map();
  for (const n of STATE.nodes) {
    const k = n.parent_id || '__root__';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  for (const [, arr] of byParent) {
    arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  const rows = [];
  function recurse(parentKey, depth) {
    const arr = byParent.get(parentKey) || [];
    for (const n of arr) {
      rows.push({ n, depth });
      recurse(n.id, depth + 1);
    }
  }
  recurse('__root__', 0);
  body.innerHTML = rows.map(({ n, depth }) => `
    <tr class="border-b hover:bg-gray-50 cursor-pointer" data-id="${n.id}">
      <td class="p-2" style="padding-left: ${depth * 16 + 8}px">${escapeHtml(n.name)}</td>
      <td class="p-2">
        <span class="px-2 py-0.5 rounded text-xs"
          style="background:${STATUS[n.status].fill};color:${STATUS[n.status].stroke}">
          ${STATUS[n.status].label}
        </span>
      </td>
      <td class="p-2">${n.progress}%</td>
      <td class="p-2">${PRIORITY_LABELS[n.priority] || ''}</td>
      <td class="p-2">${n.fragment_count || 0}</td>
      <td class="p-2 text-gray-600">${escapeHtml(n.next_action || '')}</td>
    </tr>
  `).join('');
  body.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.id));
  });
}

function setView(v) {
  STATE.view = v;
  const isCanvas = v === 'canvas';
  $('#canvas-wrap').classList.toggle('hidden', !isCanvas);
  $('#table-wrap').classList.toggle('hidden', isCanvas);
  $('#btn-view').textContent = isCanvas ? '表で見る' : '星座で見る';
  if (!isCanvas) renderTable();
}

// ─────────────────────────────────────────────────────────────────
// ドロワー
// ─────────────────────────────────────────────────────────────────
async function openDrawer(nodeId) {
  STATE.selectedNodeId = nodeId;
  STATE.selectedNode = STATE.nodes.find((n) => n.id === nodeId) || null;
  if (!STATE.selectedNode) return;
  STATE.lastAssistantReply = null;
  $('#d-btn-save-output').disabled = true;

  $('#drawer').classList.add('open');
  $('#drawer-overlay').classList.remove('hidden');
  fillDrawerControls();
  updateDetachButton();
  await loadDrawerContent();
  switchDrawerTab('chat');
  if (STATE.view === 'canvas') renderConstellation();
}

function closeDrawer() {
  if (!STATE.selectedNodeId) return;
  STATE.selectedNodeId = null;
  STATE.selectedNode = null;
  $('#drawer').classList.remove('open');
  $('#drawer-overlay').classList.add('hidden');
  if (STATE.view === 'canvas') renderConstellation();
}

function fillDrawerControls() {
  const n = STATE.selectedNode;
  $('#d-name').value = n.name;
  $('#d-status-text').textContent = STATUS[n.status]?.label || n.status;
  $('#d-progress-text').textContent = n.progress;

  $('#d-status').innerHTML = STATUS_KEYS
    .map((k) => `<option value="${k}" ${n.status === k ? 'selected' : ''}>${STATUS[k].label}</option>`).join('');
  $('#d-progress').value = n.progress;
  $('#d-priority').innerHTML = [0, 1, 2]
    .map((p) => `<option value="${p}" ${n.priority === p ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('');
  $('#d-next-action').value = n.next_action || '';
  $('#d-system-prompt').value = n.system_prompt || '';
}

async function loadDrawerContent() {
  if (!STATE.selectedNodeId) return;
  const [fragRes, outRes, issueRes] = await Promise.all([
    api(`/api/fragments?node_id=${STATE.selectedNodeId}`),
    api(`/api/outputs?node_id=${STATE.selectedNodeId}`),
    api(`/api/issues?node_id=${STATE.selectedNodeId}`),
  ]);
  STATE.fragments = fragRes.fragments || [];
  STATE.outputs = outRes.outputs || [];
  STATE.issues = issueRes.issues || [];
  $('#d-frag-count').textContent = `(${STATE.fragments.length})`;
  $('#d-out-count').textContent = `(${STATE.outputs.length})`;
  const openCount = STATE.issues.filter((i) => i.status === 'open' || i.status === 'in_progress').length;
  $('#d-issue-count').textContent = `(${openCount}/${STATE.issues.length})`;
  renderFragmentsTab();
  renderOutputsTab();
  renderIssuesTab();
  renderChatTab();
}

function switchDrawerTab(tab) {
  STATE.drawerTab = tab;
  $$('.d-tab').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.classList.toggle('text-gray-500', !active);
    b.classList.toggle('border-blue-500', active);
    b.classList.toggle('border-transparent', !active);
  });
  ['chat', 'fragments', 'issues', 'outputs'].forEach((t) => {
    $(`#d-tab-${t}`).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'chat') setTimeout(() => $('#d-chat-input').focus(), 0);
}

function renderFragmentsTab() {
  const wrap = $('#d-tab-fragments');
  if (STATE.fragments.length === 0) {
    wrap.innerHTML = '<p class="text-gray-500 text-sm">まだ断片がありません</p>';
    return;
  }
  wrap.innerHTML = STATE.fragments.map((f) => `
    <div class="border-b last:border-0 py-2 text-sm">
      <p class="whitespace-pre-wrap">${escapeHtml(f.raw_text)}</p>
      <p class="text-xs text-gray-400 mt-1">${new Date(f.created_at).toLocaleString('ja-JP')}</p>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────────────────────────
// 課題（Issues）タブ
// ─────────────────────────────────────────────────────────────────
const ISSUE_STATUS = {
  open:        { label: '未着手', bg: '#fef3c7', fg: '#d97706' },
  in_progress: { label: '進行中', bg: '#bbf7d0', fg: '#16a34a' },
  done:        { label: '完了',   bg: '#dbeafe', fg: '#2563eb' },
  wontfix:     { label: '見送り', bg: '#e5e7eb', fg: '#6b7280' },
};
const ISSUE_STATUS_KEYS = ['open', 'in_progress', 'done', 'wontfix'];

function renderIssuesTab() {
  const wrap = $('#d-tab-issues');
  const headerHtml = `
    <div class="mb-3 p-2 bg-gray-50 rounded">
      <div class="flex gap-2">
        <input id="new-issue-title" placeholder="新しい課題のタイトル"
          class="flex-1 border rounded px-2 py-1 text-sm" />
        <button id="btn-add-issue"
          class="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700">追加</button>
      </div>
    </div>
  `;
  if (STATE.issues.length === 0) {
    wrap.innerHTML = headerHtml + '<p class="text-gray-500 text-sm">まだ課題がありません</p>';
    bindIssueAdd();
    return;
  }
  const rows = STATE.issues.map((i) => {
    const s = ISSUE_STATUS[i.status] || ISSUE_STATUS.open;
    return `
      <div class="border-b last:border-0 py-2 text-sm" data-id="${i.id}">
        <div class="flex items-start gap-2">
          <select class="issue-status border rounded px-1 py-0.5 text-xs"
            style="background:${s.bg};color:${s.fg}">
            ${ISSUE_STATUS_KEYS.map((k) =>
              `<option value="${k}" ${i.status === k ? 'selected' : ''}>${ISSUE_STATUS[k].label}</option>`
            ).join('')}
          </select>
          <input class="issue-title flex-1 border-b border-transparent hover:border-gray-300 focus:border-blue-500 outline-none px-1"
            value="${escapeHtml(i.title)}" />
          <button class="issue-delete text-gray-400 hover:text-red-600 text-lg leading-none">×</button>
        </div>
        <div class="flex gap-3 mt-1 text-xs text-gray-500 ml-1">
          <label class="flex items-center gap-1">
            優先度
            <select class="issue-priority border rounded px-1 py-0.5">
              ${[0, 1, 2].map((p) =>
                `<option value="${p}" ${i.priority === p ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`
              ).join('')}
            </select>
          </label>
          <label class="flex items-center gap-1">
            期日
            <input type="date" class="issue-due border rounded px-1 py-0.5"
              value="${i.due_date || ''}" />
          </label>
        </div>
      </div>
    `;
  }).join('');
  wrap.innerHTML = headerHtml + rows;
  bindIssueAdd();
  bindIssueRows();
}

function bindIssueAdd() {
  const input = $('#new-issue-title');
  const btn = $('#btn-add-issue');
  if (!input || !btn) return;
  const submit = async () => {
    const title = input.value.trim();
    if (!title) return;
    btn.disabled = true;
    try {
      await api('/api/issues', {
        method: 'POST',
        body: JSON.stringify({ node_id: STATE.selectedNodeId, title }),
      });
      input.value = '';
      await loadDrawerContent();
      switchDrawerTab('issues');
      await loadNodes(); // open_issue_count を更新
    } catch (e) {
      toast('エラー: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
}

function bindIssueRows() {
  $$('#d-tab-issues [data-id]').forEach((row) => {
    const id = row.dataset.id;
    const statusSel = row.querySelector('.issue-status');
    const titleInput = row.querySelector('.issue-title');
    const prioritySel = row.querySelector('.issue-priority');
    const dueInput = row.querySelector('.issue-due');
    const delBtn = row.querySelector('.issue-delete');

    const updateField = async (body) => {
      try {
        await api(`/api/issues?id=${id}`, { method: 'PUT', body: JSON.stringify(body) });
        await loadDrawerContent();
        await loadNodes();
      } catch (e) {
        toast('エラー: ' + e.message);
      }
    };
    statusSel.addEventListener('change', () => updateField({ status: statusSel.value }));
    prioritySel.addEventListener('change', () => updateField({ priority: parseInt(prioritySel.value, 10) }));
    dueInput.addEventListener('change', () => updateField({ due_date: dueInput.value || null }));
    titleInput.addEventListener('blur', () => {
      const v = titleInput.value.trim();
      if (v) updateField({ title: v });
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
    });
    delBtn.addEventListener('click', async () => {
      if (!confirm('この課題を削除しますか？')) return;
      try {
        await api(`/api/issues?id=${id}`, { method: 'DELETE' });
        await loadDrawerContent();
        await loadNodes();
      } catch (e) {
        toast('エラー: ' + e.message);
      }
    });
  });
}

function renderOutputsTab() {
  const wrap = $('#d-tab-outputs');
  if (STATE.outputs.length === 0) {
    wrap.innerHTML = '<p class="text-gray-500 text-sm">まだ成果物がありません。対話タブで AI 応答を「成果物に保存」できます。</p>';
    return;
  }
  wrap.innerHTML = STATE.outputs.map((o) => `
    <details class="border-b last:border-0 py-2">
      <summary class="cursor-pointer text-sm">
        <span class="font-bold">${escapeHtml(o.title)}</span>
        <span class="text-xs text-gray-400 ml-2">[${o.type}] v${o.version} ・ ${new Date(o.created_at).toLocaleDateString('ja-JP')}</span>
      </summary>
      <div class="md mt-2 pl-4 text-sm" id="out-${o.id}"></div>
    </details>
  `).join('');
  for (const o of STATE.outputs) {
    const el = document.getElementById(`out-${o.id}`);
    if (el) el.innerHTML = renderMarkdown(o.content);
  }
}

function renderChatTab() {
  const wrap = $('#d-chat-messages');
  const history = STATE.chatHistory[STATE.selectedNodeId] || [];
  if (history.length === 0) {
    wrap.innerHTML = `<p class="text-xs text-gray-400">「${escapeHtml(STATE.selectedNode?.name || '')}」と対話できます</p>`;
    return;
  }
  wrap.innerHTML = '';
  for (const m of history) {
    const div = document.createElement('div');
    if (m.role === 'user') {
      div.className = 'bg-blue-600 text-white p-2 rounded text-sm ml-10 whitespace-pre-wrap';
      div.textContent = m.content;
    } else {
      div.className = 'bg-gray-100 p-2 rounded text-sm mr-10 md';
      div.innerHTML = renderMarkdown(m.content);
    }
    wrap.appendChild(div);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

async function saveNode() {
  const id = STATE.selectedNodeId;
  if (!id) return;
  const name = $('#d-name').value.trim();
  if (!name) { toast('名前は必須です'); return; }
  try {
    const updated = await api(`/api/nodes?id=${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        status: $('#d-status').value,
        progress: parseInt($('#d-progress').value, 10) || 0,
        priority: parseInt($('#d-priority').value, 10) || 0,
        next_action: $('#d-next-action').value,
        system_prompt: $('#d-system-prompt').value,
      }),
    });
    const idx = STATE.nodes.findIndex((n) => n.id === updated.id);
    if (idx >= 0) STATE.nodes[idx] = { ...STATE.nodes[idx], ...updated };
    STATE.selectedNode = { ...STATE.selectedNode, ...updated };
    fillDrawerControls();
    if (STATE.view === 'canvas') renderConstellation(); else renderTable();
    toast('保存しました');
  } catch (e) {
    toast('エラー: ' + e.message);
  }
}

async function deleteNode() {
  if (!STATE.selectedNode) return;
  if (!confirm(`「${STATE.selectedNode.name}」とその子孫・成果物を削除します（断片は未分類に戻ります）。よろしいですか？`)) return;
  try {
    await api(`/api/nodes?id=${STATE.selectedNodeId}`, { method: 'DELETE' });
    closeDrawer();
    await Promise.all([loadNodes(), loadUnassigned()]);
  } catch (e) {
    toast('エラー: ' + e.message);
  }
}

async function sendChat() {
  const node_id = STATE.selectedNodeId;
  const message = $('#d-chat-input').value.trim();
  if (!message || !node_id) return;
  const history = STATE.chatHistory[node_id] || [];
  history.push({ role: 'user', content: message });
  STATE.chatHistory[node_id] = history;
  $('#d-chat-input').value = '';
  $('#d-btn-send').disabled = true;
  renderChatTab();

  const wrap = $('#d-chat-messages');
  const thinking = document.createElement('div');
  thinking.className = 'bg-gray-50 p-2 rounded text-xs text-gray-500 mr-10';
  thinking.textContent = '考え中...';
  wrap.appendChild(thinking);
  wrap.scrollTop = wrap.scrollHeight;

  try {
    const { reply } = await api('/api/agent-chat', {
      method: 'POST',
      body: JSON.stringify({
        node_id, message,
        history: history.slice(0, -1),
      }),
    });
    history.push({ role: 'assistant', content: reply });
    STATE.lastAssistantReply = reply;
    $('#d-btn-save-output').disabled = false;
    renderChatTab();
  } catch (e) {
    history.pop();
    toast('エラー: ' + e.message);
    renderChatTab();
  } finally {
    $('#d-btn-send').disabled = false;
    thinking.remove();
  }
}

async function saveLastReplyAsOutput() {
  if (!STATE.lastAssistantReply || !STATE.selectedNodeId) return;
  const def = `${STATE.selectedNode.name} ${new Date().toLocaleDateString('ja-JP')}`;
  const title = prompt('成果物のタイトル：', def);
  if (!title) return;
  try {
    await api('/api/outputs', {
      method: 'POST',
      body: JSON.stringify({
        node_id: STATE.selectedNodeId,
        title,
        content: STATE.lastAssistantReply,
        type: 'free',
      }),
    });
    toast('成果物として保存しました');
    await loadDrawerContent();
    switchDrawerTab('outputs');
  } catch (e) {
    toast('エラー: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// 断片投入（画面下の入力欄）
// ─────────────────────────────────────────────────────────────────
async function throwFragment() {
  const text = $('#quick-input').value.trim();
  if (!text) return;
  $('#btn-throw').disabled = true;
  try {
    await api('/api/fragments', {
      method: 'POST',
      body: JSON.stringify({ raw_text: text }),
    });
    niconicoFly(text);
    $('#quick-input').value = '';
    await loadUnassigned();
    toast('投げました。画面に浮かんでいる小さな丸が、未分類の断片です');
  } catch (e) {
    toast('エラー: ' + e.message);
  } finally {
    $('#btn-throw').disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────
// クラスタリング
// ─────────────────────────────────────────────────────────────────
async function runCluster() {
  if (STATE.unassigned.length === 0) {
    toast('未分類の断片がありません');
    return;
  }
  if (!confirm(`未分類 ${STATE.unassigned.length} 件を AI で振り分けます。既存ノードの内容は変更されません。`)) return;
  const btn = $('#btn-cluster');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.textContent = '整理中...';
  try {
    const result = await api('/api/cluster', { method: 'POST' });
    toast(`${result.assigned}件を振り分け、${result.created_nodes}個のエージェントを作成しました`);
    await Promise.all([loadNodes(), loadUnassigned()]);
    if (STATE.selectedNodeId) await loadDrawerContent();
    if (STATE.view === 'table') renderTable();
  } catch (e) {
    toast('エラー: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    updateClusterButton();
  }
}

function updateClusterButton() {
  const n = STATE.unassigned.length;
  $('#unassigned-count').textContent = n;
  $('#btn-cluster').disabled = n === 0;
}

// ─────────────────────────────────────────────────────────────────
// ローダ
// ─────────────────────────────────────────────────────────────────
async function loadNodes() {
  const { nodes } = await api('/api/nodes');
  STATE.nodes = nodes;
  if (STATE.selectedNodeId) {
    const found = nodes.find((n) => n.id === STATE.selectedNodeId);
    if (found) STATE.selectedNode = found;
    else closeDrawer();
  }
  if (STATE.view === 'canvas') renderConstellation();
  else renderTable();
}

async function loadUnassigned() {
  const { fragments } = await api('/api/fragments?unassigned=1');
  STATE.unassigned = fragments;
  updateClusterButton();
  if (STATE.view === 'canvas') renderConstellation();
}

// ─────────────────────────────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────────────────────────────
async function init() {
  STATE.token = localStorage.getItem('tbd_token');
  if (!STATE.token) { location.href = '/login.html'; return; }
  try { STATE.user = await api('/api/auth'); } catch { return; }
  $('#user-name').textContent = STATE.user.display_name || STATE.user.email;

  $('#btn-logout').addEventListener('click', logout);
  $('#btn-cluster').addEventListener('click', runCluster);
  $('#btn-view').addEventListener('click', () => setView(STATE.view === 'canvas' ? 'table' : 'canvas'));
  $('#btn-throw').addEventListener('click', throwFragment);
  $('#quick-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      throwFragment();
    }
  });

  $('#btn-drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-overlay').addEventListener('click', closeDrawer);
  $('#btn-save-node').addEventListener('click', saveNode);
  $('#btn-detach').addEventListener('click', detachFromParent);
  $('#btn-delete-node').addEventListener('click', deleteNode);
  $('#btn-group').addEventListener('click', groupSelected);
  $('#btn-clear-selection').addEventListener('click', () => {
    STATE.selectedIds.clear();
    renderConstellation();
    updateActionBar();
  });
  $$('.d-tab').forEach((b) => b.addEventListener('click', () => switchDrawerTab(b.dataset.tab)));
  $('#d-btn-send').addEventListener('click', sendChat);
  $('#d-chat-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });
  $('#d-btn-save-output').addEventListener('click', saveLastReplyAsOutput);

  window.addEventListener('resize', () => {
    if (simulation && svg) {
      const w = svg.node().clientWidth;
      const h = svg.node().clientHeight;
      simulation.force('center', d3.forceCenter(w / 2, h / 2));
      simulation.alpha(0.2).restart();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (STATE.selectedIds.size > 0) {
        STATE.selectedIds.clear();
        renderConstellation();
        updateActionBar();
      } else if (STATE.selectedNodeId) {
        closeDrawer();
      }
    }
  });

  await Promise.all([loadNodes(), loadUnassigned()]);
}

init();
