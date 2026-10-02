'use strict';

/* ---------------------------------------------------------------------------
 * app.js — PCB 走线审阅工作台前端（无框架、无构建、无外部依赖）。
 *
 * 状态要点：
 *  - working       用户正在编辑的设计（画布铜形状的唯一数据源）
 *  - savedHead     服务器已保存的最新版次
 *  - activeReport  最近一次服务端检查报告；它带 contentHash，只有与当前
 *                  画布内容哈希一致时才允许把问题标到画布上（防旧坐标新标）
 *  - viewMode      'draft'（编辑）或 'history'（只读查看某个旧版次快照）
 * ------------------------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NET_COLORS = ['#38bdf8', '#4ade80', '#f472b6', '#facc15', '#a78bfa',
  '#fb923c', '#2dd4bf', '#f87171', '#818cf8', '#e879f9', '#94a3b8', '#bef264'];
const MARGIN = 40;

const state = {
  designId: null,
  designs: [],
  working: null,
  baseRevisionId: null,
  savedHash: null,
  dirty: false,
  serverHeadKnown: null,
  revisions: [],
  activeReport: null,
  reportHash: null,
  reportCurrency: 'none', // none | current | edited | checking | history
  checkSeq: 0,
  viewMode: 'draft',
  history: null, // {revisionId, design, report}
  selectedNet: null,
  selectedIssue: null,
  selectedObject: null,
  layers: { top: true, bottom: true },
  changedIds: new Set(),
  view: { scale: 8, panX: 0, panY: 0 },
  drag: null,
  remoteNotice: null,
};

const $ = (id) => document.getElementById(id);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error((payload && payload.error) || `HTTP ${res.status}`);
    err.statusCode = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const layerName = (l) => (l === 'top' ? '顶层' : '底层');

// 与后端 canonicalJSON 相同的键排序规范，sha256 十六进制
function canonicalString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalString(value[k])}`).join(',')}}`;
}

async function contentHashOf(design) {
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(canonicalString(design)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  bindUI();
  const list = await api('GET', '/api/designs');
  state.designs = list.designs;
  renderDesignSelect();
  state.designId = state.designs[0] ? state.designs[0].id : null;
  await loadHead(true);
  refreshRevisionList();
  setInterval(pollRemote, 3000);
  setInterval(revalidateCurrency, 1500);
}

// 最终闸门：周期性核对画布内容与报告哈希。即使编辑路径有遗漏，
// 不一致的旧报告也不会被画到当前坐标上。
let currencyBusy = false;
async function revalidateCurrency() {
  if (currencyBusy || state.viewMode === 'history' || state.reportCurrency === 'checking') return;
  if (!state.activeReport || !state.working) return;
  currencyBusy = true;
  try {
    const hash = await contentHashOf(state.working);
    const shouldBeCurrent = hash === state.reportHash;
    if (shouldBeCurrent && state.reportCurrency !== 'current') {
      state.reportCurrency = 'current';
      state.dirty = hash !== state.savedHash;
      renderAll();
    } else if (!shouldBeCurrent && state.reportCurrency === 'current') {
      state.reportCurrency = 'edited';
      state.dirty = true;
      renderAll();
    }
  } finally {
    currencyBusy = false;
  }
}

function renderDesignSelect() {
  const sel = $('design-select');
  sel.innerHTML = state.designs
    .map((d) => `<option value="${escapeHTML(d.id)}">${escapeHTML(d.name)} (${escapeHTML(d.id)})</option>`)
    .join('');
  sel.value = state.designId;
}

async function loadHead(initial = false) {
  const head = await api('GET', `/api/designs/${encodeURIComponent(state.designId)}/head`);
  state.working = head.design;
  state.baseRevisionId = head.revisionId;
  state.savedHash = head.contentHash;
  state.serverHeadKnown = head.revisionId;
  state.dirty = false;
  state.changedIds = new Set();
  state.viewMode = 'draft';
  state.history = null;
  state.selectedNet = null;
  state.selectedIssue = null;
  state.selectedObject = null;
  state.activeReport = null;
  state.reportHash = null;
  state.reportCurrency = 'none';
  state.revisions = (await api('GET', `/api/designs/${encodeURIComponent(state.designId)}/revisions`)).revisions;
  if (initial) fitView();
  renderAll();
}

// ---------------------------------------------------------------------------
// UI 绑定
// ---------------------------------------------------------------------------

function bindUI() {
  $('design-select').addEventListener('change', async (e) => {
    state.designId = e.target.value;
    await loadHead(true);
  });
  $('btn-check').addEventListener('click', () => runCheck(false));
  $('btn-save').addEventListener('click', () => saveDesign());
  $('btn-reload').addEventListener('click', () => loadHead(false));
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-zoom-fit').addEventListener('click', fitView);
  $('layer-top').addEventListener('change', (e) => { state.layers.top = e.target.checked; renderCanvas(); });
  $('layer-bottom').addEventListener('change', (e) => { state.layers.bottom = e.target.checked; renderCanvas(); });

  $('rule-clearance').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    const ctx = currentContext();
    ctx.design.rules.clearance = v;
    if (ctx.editable) noteEdit(['rules']);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveDesign();
    } else if (e.key.toLowerCase() === 'r') {
      runCheck(false);
    } else if (e.key === 'Escape') {
      state.selectedObject = null;
      state.selectedIssue = null;
      renderCanvas();
      renderProps();
      renderDetail();
    }
  });

  bindCanvasEvents();

  $('conflict-force').addEventListener('click', async () => {
    $('conflict-dialog').hidden = true;
    const head = await api('GET', `/api/designs/${encodeURIComponent(state.designId)}/head`);
    state.baseRevisionId = head.revisionId;
    state.serverHeadKnown = head.revisionId;
    await saveDesign(true);
  });
  $('conflict-discard').addEventListener('click', () => {
    $('conflict-dialog').hidden = true;
    loadHead(false);
  });
  $('conflict-cancel').addEventListener('click', () => { $('conflict-dialog').hidden = true; });
}

// ---------------------------------------------------------------------------
// 渲染上下文：编辑中看 working + 当前报告；历史视图看快照 + 快照版报告
// ---------------------------------------------------------------------------

function currentContext() {
  if (state.viewMode === 'history' && state.history) {
    return {
      design: state.history.design,
      report: state.history.report,
      currency: 'history',
      editable: false,
    };
  }
  return {
    design: state.working,
    report: state.reportCurrency === 'current' ? state.activeReport : null,
    currency: state.reportCurrency,
    editable: true,
  };
}

function renderAll() {
  renderChrome();
  renderNetList();
  renderRevisionList();
  renderIssues();
  renderProps();
  renderDetail();
  renderCanvas();
}

function renderChrome() {
  $('revision-info').textContent = state.baseRevisionId
    ? `已保存: ${state.baseRevisionId}` : '尚未保存';
  $('dirty-pill').hidden = !(state.dirty && state.viewMode === 'draft');
  $('btn-save').disabled = state.viewMode === 'history';
  $('btn-check').disabled = state.viewMode === 'history';
  $('rule-clearance').value = state.working ? state.working.rules.clearance : '';
  $('rule-clearance').disabled = state.viewMode === 'history';

  const banner = $('view-banner');
  if (state.viewMode === 'history') {
    banner.hidden = false;
    banner.textContent = `只读历史视图：${state.history.revisionId}（问题定位仅指向该版次对象）— 点击左栏“返回当前编辑”退出`;
  } else if (state.remoteNotice) {
    banner.hidden = false;
    banner.textContent = `另一窗口已保存新版 ${state.remoteNotice}，保存时会提示冲突`;
  } else {
    banner.hidden = true;
  }

  const meta = $('report-meta');
  if (state.viewMode === 'history' && state.history) {
    if (state.history.report) {
      meta.className = 'report-meta';
      meta.textContent = `历史报告 · ${state.history.report.revisionId} · ${formatTime(state.history.report.checkedAt)} · 单位 mm`;
    } else {
      meta.textContent = '该版次没有检查报告（可在历史快照上运行后保存，报告按内容哈希留存）';
    }
  } else if (state.reportCurrency === 'current' && state.activeReport) {
    meta.className = 'report-meta';
    const r = state.activeReport;
    meta.textContent = `报告版次 ${r.revisionId} · ${formatTime(r.checkedAt)} · ` +
      `短接 ${r.counts.short} / 净空 ${r.counts.clearance} / 未布通 ${r.counts.unrouted}`;
  } else if (state.reportCurrency === 'edited' || state.dirty) {
    meta.className = 'report-meta stale';
    meta.textContent = '画布内容自上次检查后已修改：旧版问题已隐藏，重新运行检查后才会标注到新坐标';
  } else {
    meta.className = 'report-meta muted';
    meta.textContent = '尚未运行检查';
  }
  $('check-progress').hidden = state.reportCurrency !== 'checking';
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); }
  catch { return iso; }
}

// ---------------------------------------------------------------------------
// 网络面板（连接范围来自服务端报告中的 islands/nets；无报告时仅列名称）
// ---------------------------------------------------------------------------

function netColor(net, report) {
  if (!report) {
    let h = 0;
    for (const ch of String(net)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return NET_COLORS[h % NET_COLORS.length];
  }
  const names = Object.keys(report.nets).sort();
  return NET_COLORS[names.indexOf(net) % NET_COLORS.length];
}

function netStatus(net, report) {
  if (!report) return { cls: 'unknown', text: '未检查' };
  if (report.issues.some((i) => i.type === 'short' && i.nets && i.nets.includes(net))) {
    return { cls: 'short', text: '短接' };
  }
  const summary = report.nets[net];
  if (summary && !summary.routed) return { cls: 'open', text: '未布通' };
  if (summary) return { cls: 'ok', text: '连通' };
  return { cls: 'unknown', text: '无焊盘' };
}

function renderNetList() {
  const ctx = currentContext();
  const ul = $('net-list');
  if (!ctx.design) { ul.innerHTML = ''; return; }

  const nets = new Set();
  ctx.design.objects.forEach((o) => { if (o.net) nets.add(o.net); });
  const names = [...nets].sort();

  const returnItem = state.viewMode === 'history'
    ? '<li class="net-item" id="exit-history" style="border:1px solid var(--line)">↩ 返回当前编辑</li>'
    : '';

  ul.innerHTML = returnItem + names.map((net) => {
    const st = netStatus(net, ctx.report);
    const color = netColor(net, ctx.report);
    let layerInfo = '';
    const summary = ctx.report && ctx.report.nets[net];
    if (summary) {
      const layers = new Set();
      summary.reach.forEach((r) => r.layers.forEach((l) => layers.add(l)));
      layerInfo = [...layers].map((l) => (l === 'top' ? '顶' : '底')).join('/');
    }
    const islands = summary ? summary.reach.length : '?';
    return `<li class="net-item ${state.selectedNet === net ? 'active' : ''}" data-net="${escapeHTML(net)}">
      <span class="net-swatch" style="background:${color}"></span>
      <span class="net-name">${escapeHTML(net)}</span>
      <span class="net-meta">${layerInfo} · ${islands} 岛<br><span class="net-status ${st.cls}">${st.text}</span></span>
    </li>`;
  }).join('');

  const exit = $('exit-history');
  if (exit) exit.addEventListener('click', () => { state.viewMode = 'draft'; state.history = null; renderAll(); });

  ul.querySelectorAll('.net-item[data-net]').forEach((li) => {
    li.addEventListener('click', () => {
      const net = li.dataset.net;
      state.selectedNet = state.selectedNet === net ? null : net;
      state.selectedIssue = null;
      renderAll();
    });
  });
}

// ---------------------------------------------------------------------------
// 版本历史
// ---------------------------------------------------------------------------

function renderRevisionList() {
  const ul = $('revision-list');
  if (!state.revisions.length) { ul.innerHTML = ''; return; }
  const viewing = state.viewMode === 'history' ? state.history.revisionId : null;
  ul.innerHTML = state.revisions.map((r) => `
    <li data-rev="${r.revisionId}" class="${viewing === r.revisionId ? 'active' : ''}">
      ${r.revisionId}${r.seed ? ' 🌱示例' : ''}
      <span class="rev-time">${formatTime(r.createdAt)}</span>
    </li>`).join('');
  ul.querySelectorAll('li[data-rev]').forEach((li) => {
    li.addEventListener('click', () => openRevision(li.dataset.rev));
  });
}

async function openRevision(revisionId) {
  const snap = await api('GET',
    `/api/designs/${encodeURIComponent(state.designId)}/revisions/${encodeURIComponent(revisionId)}`);
  let report = null;
  try {
    const r = await api('GET',
      `/api/designs/${encodeURIComponent(state.designId)}/reports/${snap.contentHash}`);
    report = r.report;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  state.viewMode = 'history';
  state.history = { revisionId, design: snap.design, report };
  state.selectedNet = null;
  state.selectedIssue = null;
  state.selectedObject = null;
  fitView();
  renderAll();
}

async function pollRemote() {
  if (!state.designId) return;
  try {
    const meta = await api('GET', `/api/designs/${encodeURIComponent(state.designId)}`);
    const head = meta.meta.headRevisionId;
    const headChanged = head !== state.serverHeadKnown;
    state.serverHeadKnown = head;
    if (state.viewMode !== 'history') {
      state.revisions = meta.meta.revisions;
      state.remoteNotice = head !== state.baseRevisionId ? head : null;
    }
    if (headChanged || state.viewMode !== 'history') {
      renderRevisionList();
      renderChrome();
    }
  } catch { /* 后台轮询静默 */ }
}

// ---------------------------------------------------------------------------
// 检查 / 保存
// ---------------------------------------------------------------------------

async function runCheck() {
  if (state.viewMode === 'history') return;
  const seq = ++state.checkSeq;
  state.reportCurrency = 'checking';
  state.validationErrors = null;
  renderChrome();
  renderValidation();
  renderIssues();
  renderCanvas();
  try {
    const sentDesign = state.working;
    const r = await api('POST',
      `/api/designs/${encodeURIComponent(state.designId)}/check`,
      { design: sentDesign, basedOnRevision: state.baseRevisionId });
    if (seq !== state.checkSeq) return; // 已被新一次检查取代
    // 服务端计算期间用户又编辑了画布：不能把刚回来的（旧内容）报告标到新坐标
    const currentHash = await contentHashOf(state.working);
    if (currentHash !== r.contentHash) {
      state.reportCurrency = 'edited';
      renderAll();
      return;
    }
    state.activeReport = r.report;
    state.reportHash = r.contentHash;
    state.reportCurrency = 'current';
  } catch (err) {
    if (seq !== state.checkSeq) return;
    if (err.statusCode === 422) {
      state.validationErrors = err.payload.errors;
      state.reportCurrency = 'edited'; // 检查被拒绝：保留编辑内容，不标注旧结果
    } else {
      state.reportCurrency = 'edited';
      alert(`检查失败: ${err.message}`);
    }
  }
  state.selectedIssue = null;
  renderAll();
}

async function saveDesign() {
  if (state.viewMode === 'history') return;
  try {
    const r = await api('PUT',
      `/api/designs/${encodeURIComponent(state.designId)}/save`,
      { design: state.working, baseRevisionId: state.baseRevisionId });
    state.baseRevisionId = r.revisionId;
    state.savedHash = r.contentHash;
    state.dirty = false;
    state.changedIds = new Set();
    state.remoteNotice = null;
    state.revisions = (await api('GET',
      `/api/designs/${encodeURIComponent(state.designId)}/revisions`)).revisions;
    // 只有当报告内容哈希等于刚保存的内容时，报告才与画布同版次；否则重检
    if (state.reportHash === r.contentHash && state.activeReport) {
      state.reportCurrency = 'current';
      renderAll();
    } else {
      await runCheck();
    }
  } catch (err) {
    if (err.statusCode === 422) {
      state.validationErrors = err.payload.errors;
      renderValidation();
      renderChrome();
      alert('设计不完整，服务器拒绝保存。你正在编辑的内容仍保留在画布上，请修复右侧列出的对象。');
    } else if (err.statusCode === 409) {
      const serverHead = err.payload.serverHead;
      $('conflict-text').textContent =
        `你的编辑基于 ${state.baseRevisionId}，但另一个窗口已保存 ${serverHead}。` +
        '直接保存会覆盖对方的改动，请选择处理方式（你的编辑不会丢失）：';
      $('conflict-dialog').hidden = false;
    } else {
      alert(`保存失败: ${err.message}`);
    }
  }
}

function noteEdit(ids) {
  if (state.viewMode === 'history') return;
  state.dirty = true;
  (ids || []).forEach((id) => { if (id !== 'rules') state.changedIds.add(id); });
  // 内容一旦改动，旧报告的坐标依据就不再成立；哈希不一致前不把旧问题标到画布上
  state.reportCurrency = state.activeReport ? 'edited' : 'none';
  renderAll();
}

function renderValidation() {
  const box = $('validation-box');
  const list = $('validation-list');
  const errors = state.validationErrors;
  if (state.viewMode === 'history' || !errors || errors.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  list.innerHTML = errors.map((e) => `
    <li>${escapeHTML(e.message)}
      ${e.objectId ? `<button data-jump="${escapeHTML(e.objectId)}">定位 ${escapeHTML(e.objectId)}</button>` : ''}
      <span class="muted">(${escapeHTML(e.code)})</span>
    </li>`).join('');
  list.querySelectorAll('button[data-jump]').forEach((b) => {
    b.addEventListener('click', () => {
      const obj = state.working.objects.find((o) => o.id === b.dataset.jump);
      if (obj) { state.selectedObject = obj.id; renderProps(); renderCanvas(); focusObjects([obj.id]); }
    });
  });
}

// ---------------------------------------------------------------------------
// 问题列表与判断依据
// ---------------------------------------------------------------------------

function issueTitle(i) {
  if (i.type === 'short') return `短接：${i.nets[0]} ⚡ ${i.nets[1]}`;
  if (i.type === 'clearance') return `净空不足：${i.nets[0]} ↔ ${i.nets[1]}`;
  return `未布通：${i.net}`;
}

function renderIssues() {
  const ul = $('issue-list');
  const ctx = currentContext();
  renderValidation();
  if (!ctx.report) {
    ul.innerHTML = state.reportCurrency === 'checking'
      ? ''
      : '<li class="muted" style="padding:4px">运行检查后在此查看问题。编辑期间旧版问题不会标注在新坐标上。</li>';
    return;
  }
  const issues = ctx.report.issues;
  if (issues.length === 0) {
    ul.innerHTML = '<li style="padding:6px;color:var(--accent-2)">✓ 未发现短接、净空或连通问题</li>';
    return;
  }
  ul.innerHTML = issues.map((i, idx) => {
    const where = i.type === 'unrouted'
      ? `${i.islands.length} 个连通岛`
      : `${layerName(i.layer)} · ${i.objects.join(' / ')}`;
    const measure = i.type === 'clearance'
      ? `测得 ${i.distance} mm < 要求 ${i.required} mm`
      : i.type === 'short' ? '测得距离 0 mm（表面接触）' : '';
    return `<li class="issue-item ${i.type} ${state.selectedIssue === idx ? 'active' : ''}" data-idx="${idx}">
      <div class="issue-title"><span class="issue-tag ${i.type}">${
        i.type === 'short' ? '短接' : i.type === 'clearance' ? '净空' : '未布通'
      }</span>${escapeHTML(issueTitle(i))}</div>
      <div class="issue-sub">${escapeHTML(where)}</div>
      ${measure ? `<div class="issue-sub">${escapeHTML(measure)}</div>` : ''}
    </li>`;
  }).join('');

  ul.querySelectorAll('.issue-item').forEach((li) => {
    li.addEventListener('click', () => selectIssue(Number(li.dataset.idx)));
  });
}

function selectIssue(idx) {
  const ctx = currentContext();
  if (!ctx.report) return;
  state.selectedIssue = idx;
  const issue = ctx.report.issues[idx];
  if (issue.type === 'unrouted' && issue.net) state.selectedNet = issue.net;
  renderIssues();
  renderNetList();
  renderDetail();
  focusBBox(issue.bbox);
  renderCanvas();
  // 详情里给出对象链接
  document.querySelectorAll('#detail-box .obj-link').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedObject = el.dataset.id;
      renderProps();
      focusObjects([el.dataset.id]);
    });
  });
}

function renderDetail() {
  const section = $('detail-section');
  const box = $('detail-box');
  const ctx = currentContext();
  if (state.selectedIssue === null || !ctx.report) {
    section.hidden = true;
    return;
  }
  const i = ctx.report.issues[state.selectedIssue];
  if (!i) { section.hidden = true; return; }
  section.hidden = false;

  let html = `<div class="kv"><span class="k">规则</span></div>
    <div class="rule"><strong>${escapeHTML(i.ruleId)}</strong><br>${escapeHTML(i.ruleText)}</div>`;

  if (i.type === 'short' || i.type === 'clearance') {
    html += `<div class="kv"><span class="k">铜层</span><span>${layerName(i.layer)}</span></div>
      <div class="kv"><span class="k">对象 A</span><span><span class="obj-link" data-id="${escapeHTML(i.objects[0])}">${escapeHTML(i.objects[0])}</span> (${escapeHTML(i.objectTypes[0])}, ${escapeHTML(i.nets[0])})</span></div>
      <div class="kv"><span class="k">对象 B</span><span><span class="obj-link" data-id="${escapeHTML(i.objects[1])}">${escapeHTML(i.objects[1])}</span> (${escapeHTML(i.objectTypes[1])}, ${escapeHTML(i.nets[1])})</span></div>
      <div class="kv"><span class="k">测得距离</span><span>${i.distance} mm${i.type === 'clearance' ? `（要求 ≥ ${i.required} mm）` : '，表面接触'}</span></div>
      <div class="kv"><span class="k">最近点 A</span><span>(${i.pointA.x}, ${i.pointA.y}) mm</span></div>
      <div class="kv"><span class="k">最近点 B</span><span>(${i.pointB.x}, ${i.pointB.y}) mm</span></div>`;
  } else {
    html += `<div class="kv"><span class="k">网络</span><span>${escapeHTML(i.net)}</span></div>`;
    html += `<div class="kv"><span class="k">连通岛</span><span>${i.islands.length} 个：</span></div>`;
    html += '<ul style="margin:2px 0 8px 16px;padding:0">' + i.islands.map((isl) => {
      const pads = isl.padRefs.length ? isl.padRefs.join(', ') : '（无焊盘）';
      return `<li><strong>${escapeHTML(isl.island)}</strong> [${isl.layers.map(layerName).join('+')}]<br>
        焊盘: ${escapeHTML(pads)}<br>
        走线: ${escapeHTML(isl.traceIds.join(', ') || '无')}; 过孔: ${escapeHTML(isl.viaIds.join(', ') || '无')}</li>`;
    }).join('') + '</ul>';
    if (i.projectedPairs.length) {
      html += '<div class="rule">跨层投影相交但无过孔的位置（看着连着，实际断开）：<ul style="margin:4px 0 0 16px;padding:0">' +
        i.projectedPairs.map((p) => `<li>顶层 <span class="obj-link" data-id="${escapeHTML(p.objectA)}">${escapeHTML(p.objectA)}</span>
          × 底层 <span class="obj-link" data-id="${escapeHTML(p.objectB)}">${escapeHTML(p.objectB)}</span><br>
          <span class="muted">${escapeHTML(p.note)}</span></li>`).join('') + '</ul></div>';
    }
  }
  html += `<div class="rule">${escapeHTML(i.basis)}</div>
    <div class="muted" style="font-size:11px">结论绑定报告版次 ${escapeHTML(ctx.report.revisionId)}（内容哈希 ${escapeHTML(ctx.report.contentHash.slice(0, 12))}…）；${
      ctx.currency === 'history' ? '当前为该版次只读快照，定位不会指向其他版次对象。' : '编辑后需重新检查。'
    }</div>`;
  box.innerHTML = html;
  box.querySelectorAll('.obj-link').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedObject = el.dataset.id;
      renderProps();
      focusObjects([el.dataset.id]);
    });
  });
}

// ---------------------------------------------------------------------------
// 属性面板
// ---------------------------------------------------------------------------

function renderProps() {
  const box = $('props-section').querySelector('#props-box');
  const ctx = currentContext();
  const id = state.selectedObject;
  const obj = id && ctx.design ? ctx.design.objects.find((o) => o.id === id) : null;
  if (!obj) {
    box.innerHTML = '<p class="muted">未选中对象。点击画布上的焊盘/过孔/走线进行编辑。拖动可移动。</p>';
    return;
  }
  const ro = ctx.editable ? '' : 'disabled';
  let body = '';
  body += `<div class="props-grid">
    <label>对象 ID</label><span>${escapeHTML(obj.id)} (${obj.type})</span>`;
  if (obj.type === 'pad') {
    body += `<label>器件.引脚</label><span>${escapeHTML(obj.component)}.${escapeHTML(obj.pin)}</span>`;
  }
  body += `<label>网络 net</label><input data-k="net" value="${escapeHTML(obj.net)}" ${ro}/>`;
  if (obj.type === 'trace') {
    body += `<label>铜层</label><select data-k="layer" ${ro}>
      <option value="top" ${obj.layer === 'top' ? 'selected' : ''}>顶层 top</option>
      <option value="bottom" ${obj.layer === 'bottom' ? 'selected' : ''}>底层 bottom</option></select>`;
    body += `<label>线宽 mm</label><input type="number" step="0.05" min="0.05" data-k="width" value="${obj.width}" ${ro}/>`;
    body += `<label>顶点数</label><span>${obj.points.length}</span>`;
  } else {
    body += `<label>x mm</label><input type="number" step="0.5" data-k="x" value="${obj.x}" ${ro}/>`;
    body += `<label>y mm</label><input type="number" step="0.5" data-k="y" value="${obj.y}" ${ro}/>`;
    body += `<label>半径 mm</label><input type="number" step="0.1" min="0.05" data-k="r" value="${obj.r}" ${ro}/>`;
    body += `<label>所在层</label><span>${obj.layers.map(layerName).join(' + ')}${
      obj.type === 'via' || (obj.type === 'pad' && obj.holeRadius > 0) ? '（贯通）' : ''}</span>`;
  }
  body += '</div>';
  if (ctx.editable) {
    body += `<p class="hint" style="margin-top:8px">提示：在画布上拖动对象即移动；改层/改净空后点“运行检查”。</p>`;
  } else {
    body += `<p class="hint" style="margin-top:8px">历史快照只读。</p>`;
  }
  box.innerHTML = body;
  box.querySelectorAll('[data-k]').forEach((input) => {
    input.addEventListener('change', () => {
      const k = input.dataset.k;
      if (k === 'layer') obj.layer = input.value;
      else if (k === 'net') obj.net = input.value.trim();
      else if (k === 'x' || k === 'y' || k === 'r' || k === 'width') {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        obj[k] = v;
      }
      noteEdit([obj.id]);
    });
  });
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function objectBBox(o) {
  const pad = (o.type === 'trace' ? o.width : (o.r || 0)) + 0.5;
  if (o.type === 'trace') {
    const xs = o.points.map((p) => p[0]);
    const ys = o.points.map((p) => p[1]);
    return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad };
  }
  return { minX: o.x - o.r - 0.5, maxX: o.x + o.r + 0.5,
    minY: o.y - o.r - 0.5, maxY: o.y + o.r + 0.5 };
}

function focusBBox(bb) {
  if (!bb) return;
  const host = $('canvas-scroll');
  const w = host.clientWidth - 2 * MARGIN;
  const h = host.clientHeight - 2 * MARGIN;
  const bw = Math.max(bb.maxX - bb.minX, 2);
  const bh = Math.max(bb.maxY - bb.minY, 2);
  const scale = Math.min(w / bw, h / bh) * 0.7;
  state.view.scale = Math.max(2, Math.min(40, scale));
  state.view.panX = (bb.minX + bb.maxX) / 2;
  state.view.panY = (bb.minY + bb.maxY) / 2;
  applyView();
}

function focusObjects(ids) {
  const ctx = currentContext();
  const objs = ids.map((id) => ctx.design.objects.find((o) => o.id === id)).filter(Boolean);
  if (!objs.length) return;
  const bbs = objs.map(objectBBox);
  focusBBox({
    minX: Math.min(...bbs.map((b) => b.minX)),
    minY: Math.min(...bbs.map((b) => b.minY)),
    maxX: Math.max(...bbs.map((b) => b.maxX)),
    maxY: Math.max(...bbs.map((b) => b.maxY)),
  });
}

function fitView() {
  const ctx = currentContext();
  if (!ctx.design) return;
  const host = $('canvas-scroll');
  const { width, height } = ctx.design.board;
  state.view.scale = Math.min((host.clientWidth - 2 * MARGIN) / width,
    (host.clientHeight - 2 * MARGIN) / height);
  state.view.panX = width / 2;
  state.view.panY = height / 2;
  applyView();
}

function zoomBy(factor, cx, cy) {
  const s = Math.max(1, Math.min(60, state.view.scale * factor));
  if (cx !== undefined) {
    // 以光标为锚点缩放
    const before = screenToBoard(cx, cy);
    state.view.scale = s;
    applyView();
    const after = screenToBoard(cx, cy);
    state.view.panX += before.x - after.x;
    state.view.panY += before.y - after.y;
  } else {
    state.view.scale = s;
  }
  applyView();
}

function applyView() {
  const host = $('canvas-scroll');
  const ctx = currentContext();
  if (!ctx.design) return;
  const w = Math.max(host.clientWidth, 600);
  const h = Math.max(host.clientHeight, 400);
  const svg = $('board-svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  const root = svg.querySelector('#world-root');
  if (root) {
    const tx = w / 2 - state.view.panX * state.view.scale;
    const ty = h / 2 - state.view.panY * state.view.scale;
    root.setAttribute('transform', `translate(${tx},${ty}) scale(${state.view.scale})`);
  }
}

function screenToBoard(clientX, clientY) {
  const svg = $('board-svg');
  const pt = new DOMPoint(clientX, clientY);
  const ctm = svg.getScreenCTM();
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function renderCanvas() {
  const ctx = currentContext();
  const svg = $('board-svg');
  svg.innerHTML = '';
  if (!ctx.design) return;
  const { width, height } = ctx.design.board;
  const host = $('canvas-scroll');
  svg.setAttribute('width', host.clientWidth);
  svg.setAttribute('height', host.clientHeight);

  const root = svgEl('g', { id: 'world-root' });
  svg.appendChild(root);

  // 板外框与网格
  root.appendChild(svgEl('rect', {
    x: 0, y: 0, width, height, class: 'board-bg',
    'stroke-width': 0.1, stroke: '#334252',
  }));
  const grid = svgEl('g', { class: 'grid' });
  for (let x = 5; x < width; x += 5) {
    grid.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: height, class: x % 10 === 0 ? 'major' : '' }));
  }
  for (let y = 5; y < height; y += 5) {
    grid.appendChild(svgEl('line', { x1: 0, y1: y, x2: width, y2: y, class: y % 10 === 0 ? 'major' : '' }));
  }
  root.appendChild(grid);

  const objs = ctx.design.objects;
  const report = ctx.report;
  const colorOf = (net) => netColor(net, report);
  const dimmed = new Set();
  if (state.selectedNet) {
    objs.forEach((o) => { if (o.net !== state.selectedNet) dimmed.add(o.id); });
  }

  // 叠放顺序：底层铜 -> 顶层铜 -> 焊盘/过孔（贯通件压在两层之上）
  const gBottom = svgEl('g', { class: 'copper-bottom' });
  const gTop = svgEl('g', { class: 'copper-top' });
  const gMid = svgEl('g', { class: 'copper-pads' });
  root.appendChild(gBottom);
  root.appendChild(gTop);
  root.appendChild(gMid);

  objs.forEach((o) => {
    if (o.type === 'trace') {
      const g = renderTrace(o, colorOf(o.net), dimmed, ctx);
      (o.layer === 'top' ? gTop : gBottom).appendChild(g);
    }
  });
  // 焊盘、过孔（贯通件）画在铜之上
  objs.forEach((o) => {
    if (o.type !== 'trace') {
      const g = renderPadOrVia(o, colorOf(o.net), dimmed, ctx);
      gMid.appendChild(g);
    }
  });

  // 问题标注：只有报告与当前画布内容同版次时才画
  if (report) {
    const gMarks = svgEl('g', { class: 'issue-layer' });
    root.appendChild(gMarks);
    report.issues.forEach((issue, idx) => {
      if (state.selectedNet && issue.net && issue.net !== state.selectedNet &&
        !(issue.nets && issue.nets.includes(state.selectedNet))) return;
      renderIssueMarker(issue, idx, gMarks);
    });
    // 连通岛轮廓（选中网络时）
    if (state.selectedNet) {
      const gIsl = svgEl('g', { class: 'island-layer' });
      root.appendChild(gIsl);
      report.islands
        .filter((isl) => isl.nets.includes(state.selectedNet))
        .forEach((isl) => {
          const b = isl.bbox;
          gIsl.appendChild(svgEl('rect', {
            x: b.minX - 0.6, y: b.minY - 0.6,
            width: b.maxX - b.minX + 1.2, height: b.maxY - b.minY + 1.2, rx: 0.8,
            fill: 'none', stroke: colorOf(state.selectedNet),
            'stroke-width': 0.12, 'stroke-dasharray': '0.7 0.5', opacity: 0.9,
          }));
        });
    }
  }

  // 焦点框
  if (state.selectedIssue !== null && report) {
    const issue = report.issues[state.selectedIssue];
    if (issue) {
      const b = issue.bbox;
      root.appendChild(svgEl('rect', {
        class: 'focus-halo',
        x: b.minX - 1, y: b.minY - 1,
        width: b.maxX - b.minX + 2, height: b.maxY - b.minY + 2, rx: 1,
      }));
    }
  }

  applyView();
}

function renderTrace(o, color, dimmed, ctx) {
  const visible = o.layer === 'top' ? state.layers.top : state.layers.bottom;
  const g = svgEl('g', {
    class: `selectable trace ${dimmed.has(o.id) ? 'dimmed' : ''} ${
      state.selectedObject === o.id ? 'selected' : ''} ${visible ? '' : 'layer-hidden'}`,
    'data-id': o.id,
  });
  if (!visible) g.setAttribute('opacity', '0.08');
  const pts = o.points.map((p) => p.join(',')).join(' ');

  // 选中光环
  if (state.selectedObject === o.id) {
    g.appendChild(svgEl('polyline', {
      points: pts, fill: 'none', class: 'selection-halo',
      'stroke-width': o.width + 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }
  // 编辑中（未保存）虚线标记
  if (state.changedIds.has(o.id) && ctx.currency !== 'history') {
    g.appendChild(svgEl('polyline', {
      points: pts, fill: 'none', class: 'unsaved-halo',
      'stroke-width': o.width + 0.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }

  g.appendChild(svgEl('polyline', {
    points: pts, fill: 'none', stroke: color,
    'stroke-width': o.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    class: dimmed.has(o.id) ? '' : 'net-highlight',
  }));
  // 顶点小圆点
  o.points.forEach(([x, y]) => {
    g.appendChild(svgEl('circle', { cx: x, cy: y, r: o.width / 2, fill: color }));
  });
  // 命中区
  g.appendChild(svgEl('polyline', {
    points: pts, fill: 'none', class: 'hitarea',
    'stroke-width': Math.max(o.width + 1.2, 2), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  return g;
}

function renderPadOrVia(o, color, dimmed, ctx) {
  const visible = o.layers.some((l) => state.layers[l]);
  const g = svgEl('g', {
    class: `selectable ${o.type} ${dimmed.has(o.id) ? 'dimmed' : ''} ${
      state.selectedObject === o.id ? 'selected' : ''} ${visible ? '' : 'layer-hidden'}`,
    'data-id': o.id,
  });
  if (!visible) g.setAttribute('opacity', '0.08');

  if (state.selectedObject === o.id) {
    g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.r + 0.7, class: 'selection-halo' }));
  }
  if (state.changedIds.has(o.id) && ctx.currency !== 'history') {
    g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.r + 0.45, class: 'unsaved-halo' }));
  }

  if (o.type === 'via') {
    g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.r, class: 'via-ring' }));
    g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.drill / 2, class: 'via-drill' }));
  } else {
    // 贯通焊盘在底层先画一个虚影，体现“实际尺寸和所属层”
    if (o.holeRadius > 0) {
      g.appendChild(svgEl('circle', {
        cx: o.x, cy: o.y, r: o.r + 0.25, fill: 'none',
        stroke: '#8d7a3a', 'stroke-width': 0.06, 'stroke-dasharray': '0.3 0.25', opacity: 0.7,
      }));
    }
    if (o.shape === 'rect') {
      g.appendChild(svgEl('rect', {
        x: o.x - o.w / 2, y: o.y - o.h / 2, width: o.w, height: o.h,
        class: 'pad-ring rect', rx: 0.2,
      }));
      if (o.holeRadius > 0) {
        g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.holeRadius, class: 'pad-hole' }));
      }
    } else {
      g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.r, class: 'pad-ring' }));
      if (o.holeRadius > 0) {
        g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: o.holeRadius, class: 'pad-hole' }));
      }
    }
    const label = `${o.component}.${o.pin}`;
    g.appendChild(svgEl('text', {
      x: o.x, y: o.y - o.r - 0.35, class: 'ref-label',
      'text-anchor': 'middle',
    }, label));
  }
  g.appendChild(svgEl('circle', { cx: o.x, cy: o.y, r: Math.max(o.r + 0.8, 1.4), class: 'hitarea' }));
  return g;
}

function renderIssueMarker(issue, idx, parent) {
  const g = svgEl('g', {
    class: `issue-marker ${issue.type} ${state.selectedIssue === idx ? '' : ''}`,
    'data-issue-idx': idx,
  });
  if (issue.type === 'short' || issue.type === 'clearance') {
    const a = issue.pointA;
    const b = issue.pointB;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (issue.type === 'clearance') {
      g.appendChild(svgEl('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'marker-line',
      }));
    }
    g.appendChild(svgEl('circle', {
      cx, cy, r: issue.type === 'short' ? 0.9 : 0.7, class: 'marker-shape',
    }));
  } else if (issue.type === 'unrouted') {
    issue.projectedPairs.forEach((p) => {
      g.appendChild(svgEl('line', {
        x1: p.pointA.x, y1: p.pointA.y, x2: p.pointB.x, y2: p.pointB.y,
        class: 'marker-line',
      }));
      g.appendChild(svgEl('circle', {
        cx: p.pointA.x, cy: p.pointA.y, r: 0.7, class: 'marker-shape',
      }));
    });
    if (!issue.projectedPairs.length) {
      const b = issue.bbox;
      g.appendChild(svgEl('rect', {
        x: b.minX - 0.5, y: b.minY - 0.5,
        width: b.maxX - b.minX + 1, height: b.maxY - b.minY + 1, rx: 0.6,
        class: 'marker-shape', fill: 'none',
      }));
    }
  }
  parent.appendChild(g);
}

// ---------------------------------------------------------------------------
// 画布交互：点选 / 拖动 / 平移 / 缩放
// ---------------------------------------------------------------------------

function bindCanvasEvents() {
  const svg = $('board-svg');

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    zoomBy(factor, e.clientX, e.clientY);
  }, { passive: false });

  svg.addEventListener('mousedown', (e) => {
    const target = e.target.closest('.selectable');
    const board = screenToBoard(e.clientX, e.clientY);
    if (target && state.viewMode === 'draft') {
      const id = target.getAttribute('data-id');
      const obj = state.working.objects.find((o) => o.id === id);
      if (obj) {
        state.selectedObject = id;
        state.drag = { id, startX: board.x, startY: board.y, moved: false, objStart: deepClone(obj) };
        renderProps();
        renderCanvas();
        return;
      }
    }
    // 背景拖动平移
    state.drag = { pan: true, startClientX: e.clientX, startClientY: e.clientY,
      panX: state.view.panX, panY: state.view.panY };
  });

  window.addEventListener('mousemove', (e) => {
    const d = state.drag;
    if (!d) return;
    if (d.pan) {
      state.view.panX = d.panX - (e.clientX - d.startClientX) / state.view.scale;
      state.view.panY = d.panY - (e.clientY - d.startClientY) / state.view.scale;
      applyView();
      return;
    }
    const board = screenToBoard(e.clientX, e.clientY);
    const dx = board.x - d.startX;
    const dy = board.y - d.startY;
    if (Math.hypot(dx, dy) > 0.05) d.moved = true;
    const obj = state.working.objects.find((o) => o.id === d.id);
    if (!obj) return;
    if (obj.type === 'trace') {
      const base = d.objStart.points;
      obj.points = base.map((p) => [
        Math.round((p[0] + dx) * 1000) / 1000,
        Math.round((p[1] + dy) * 1000) / 1000,
      ]);
    } else {
      obj.x = Math.round((d.objStart.x + dx) * 1000) / 1000;
      obj.y = Math.round((d.objStart.y + dy) * 1000) / 1000;
    }
    renderCanvas();
    updateCoord(board);
  });

  window.addEventListener('mouseup', () => {
    const d = state.drag;
    state.drag = null;
    if (d && d.moved && !d.pan) {
      noteEdit([d.id]);
    } else if (d && !d.pan && !d.moved) {
      renderProps();
    }
  });

  svg.addEventListener('click', (e) => {
    const mark = e.target.closest('.issue-marker');
    if (mark) {
      selectIssue(Number(mark.getAttribute('data-issue-idx')));
      return;
    }
    if (!e.target.closest('.selectable')) {
      state.selectedObject = null;
      renderProps();
      renderCanvas();
    }
  });

  svg.addEventListener('mousemove', (e) => {
    updateCoord(screenToBoard(e.clientX, e.clientY));
  });

  window.addEventListener('resize', applyView);
}

function updateCoord(p) {
  $('coord-readout').textContent = `x: ${p.x.toFixed(2)}, y: ${p.y.toFixed(2)} mm · 缩放 ${state.view.scale.toFixed(1)}×`;
}

// 启动
boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:20px;color:#fca5a5">启动失败: ${escapeHTML(err.message)}</div>`);
});
