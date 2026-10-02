/* PCB 走线审阅工作台 — 前端逻辑。
 * 坐标单位 mm（与服务端一致）；画布缩放只是视图变换，不影响服务端几何结论。
 * 检查结果绑定设计版本：编辑后旧结果立即从画布撤下，只保留在历史里。
 */
"use strict";

// ---------------------------------------------------------------- 状态
const state = {
  designId: null,
  name: "",
  version: null,        // 当前已保存的版本号
  design: null,         // 正在编辑的设计数据（工作副本）
  dirty: false,
  checks: [],           // 检查历史摘要
  activeCheck: null,    // 正在展示的检查结果（完整）
  findingsVisible: false,
  viewVersion: null,    // 非 null 表示正在查看历史版本快照（只读）
  viewData: null,
  selectedNet: null,
  selectedObject: null,
  activeFinding: null,
  invalidObjects: [],   // 服务端 422 返回的问题对象 id
  layerVisible: { top: true, bottom: true },
  view: { scale: 20, ox: 80, oy: 80 }, // scale: px/mm，y 轴向上
};

const ISLAND_COLORS = ["#ffd166", "#06d6a0", "#ef476f", "#4cc9f0", "#b388eb", "#ff9f1c"];
const FINDING_COLORS = { short: "#ff5252", clearance: "#ffb020", unrouted: "#9b8cff" };

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- API
async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(body.detail || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------- 工具
function displayData() {
  return state.viewVersion !== null ? state.viewData : state.design;
}
function displayedVersion() {
  return state.viewVersion !== null ? state.viewVersion : state.version;
}
function netColor(net, layer) {
  let h = 0;
  for (const ch of net) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return layer === "top"
    ? `hsla(${h}, 75%, 58%, 0.95)`
    : `hsla(${h}, 70%, 38%, 0.65)`;
}
function objectById(id) {
  const data = displayData();
  return data ? data.objects.find((o) => o.id === id) : null;
}
function objectCenter(obj) {
  if (obj.kind === "trace") {
    const pts = obj.path;
    const sx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const sy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [sx, sy];
  }
  return [obj.x, obj.y];
}
function objectBBox(obj) {
  if (obj.kind === "trace") {
    const r = obj.width / 2;
    const xs = obj.path.map((p) => p[0]);
    const ys = obj.path.map((p) => p[1]);
    return [Math.min(...xs) - r, Math.min(...ys) - r,
            Math.max(...xs) + r, Math.max(...ys) + r];
  }
  const r = obj.diameter / 2;
  return [obj.x - r, obj.y - r, obj.x + r, obj.y + r];
}
function objectsLayers(obj) {
  if (obj.kind === "via") return ["top", "bottom"];
  if (obj.kind === "pad" && obj.layer === "multi") return ["top", "bottom"];
  return [obj.layer];
}

// ---------------------------------------------------------------- 视图变换
function toScreen(x, y) {
  return [state.view.ox + x * state.view.scale, state.view.oy - y * state.view.scale];
}
function fromScreen(sx, sy) {
  return [(sx - state.view.ox) / state.view.scale, (state.view.oy - sy) / state.view.scale];
}
function fitView(bbox) {
  const wrap = $("canvas-wrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const [x0, y0, x1, y1] = bbox;
  const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
  const scale = Math.min(w / bw, h / bh) * 0.75;
  state.view.scale = Math.max(scale, 0.5);
  state.view.ox = (w - (x0 + x1) * state.view.scale) / 2;
  state.view.oy = (h + (y0 + y1) * state.view.scale) / 2;
  render();
}
function fitAll() {
  const data = displayData();
  if (!data || !data.objects.length) return;
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const obj of data.objects) {
    const b = objectBBox(obj);
    box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]),
           Math.max(box[2], b[2]), Math.max(box[3], b[3])];
  }
  fitView(box);
}
function fitObjects(ids) {
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const obj = objectById(id);
    if (!obj) continue;
    const b = objectBBox(obj);
    box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]),
           Math.max(box[2], b[2]), Math.max(box[3], b[3])];
  }
  if (box[0] !== Infinity) fitView(box);
}

// ---------------------------------------------------------------- 渲染
function resizeCanvas() {
  const wrap = $("canvas-wrap");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function drawObject(obj, layer) {
  ctx.fillStyle = netColor(obj.net, layer);
  ctx.strokeStyle = netColor(obj.net, layer);
  if (obj.kind === "trace") {
    ctx.lineWidth = Math.max(obj.width * state.view.scale, 1.5);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    obj.path.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  } else {
    const [sx, sy] = toScreen(obj.x, obj.y);
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max((obj.diameter / 2) * state.view.scale, 2), 0, Math.PI * 2);
    ctx.fill();
  }
}

function strokeObjectOutline(obj, color, widthPx, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.setLineDash(dash || []);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (obj.kind === "trace") {
    ctx.lineWidth = Math.max(obj.width * state.view.scale, 1.5) + widthPx * 2;
    ctx.beginPath();
    obj.path.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  } else {
    const [sx, sy] = toScreen(obj.x, obj.y);
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max((obj.diameter / 2) * state.view.scale, 2) + widthPx, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function render() {
  const data = displayData();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!data) return;

  // 铜层：先底层后顶层
  for (const layer of ["bottom", "top"]) {
    if (!state.layerVisible[layer]) continue;
    for (const obj of data.objects) {
      if (obj.kind === "via") continue;
      if (objectsLayers(obj).includes(layer)) drawObject(obj, layer);
    }
  }
  // 过孔：灰环 + 钻孔
  for (const obj of data.objects) {
    if (obj.kind !== "via") continue;
    const [sx, sy] = toScreen(obj.x, obj.y);
    const r = Math.max((obj.diameter / 2) * state.view.scale, 2);
    ctx.fillStyle = "#c8cdd4";
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#10231a";
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.45, 0, Math.PI * 2); ctx.fill();
  }

  // 选中网络的铜岛高亮（岛屿划分来自服务端检查结果）
  if (state.selectedNet && state.activeCheck && state.findingsVisible
      && state.activeCheck.version === displayedVersion()) {
    const info = state.activeCheck.nets[state.selectedNet];
    if (info) {
      info.islands.forEach((island, idx) => {
        const color = ISLAND_COLORS[idx % ISLAND_COLORS.length];
        for (const id of island) {
          const obj = objectById(id);
          if (obj) strokeObjectOutline(obj, color, 1.5, [6, 3]);
        }
      });
    }
  }

  // 检查问题标注（只画与当前显示版本一致的结果）
  if (state.activeCheck && state.findingsVisible
      && state.activeCheck.version === displayedVersion()) {
    for (const f of state.activeCheck.findings) {
      const color = FINDING_COLORS[f.type];
      const active = state.activeFinding && state.activeFinding.id === f.id;
      if (f.type === "unrouted") {
        (f.islands || []).forEach((island) => {
          for (const id of island) {
            const obj = objectById(id);
            if (obj) strokeObjectOutline(obj, color, active ? 3 : 1.5, [3, 3]);
          }
        });
      } else {
        const pts = f.objects.map((id) => objectById(id)).filter(Boolean)
          .map((o) => toScreen(...objectCenter(o)));
        if (pts.length === 2) {
          ctx.strokeStyle = color;
          ctx.lineWidth = active ? 3 : 1.5;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          ctx.lineTo(pts[1][0], pts[1][1]);
          ctx.stroke();
          ctx.setLineDash([]);
          const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
          ctx.fillStyle = color;
          ctx.font = "11px sans-serif";
          const label = f.type === "short" ? "短接" : `${f.distance_mm}mm`;
          ctx.fillText(label, mx + 5, my - 5);
        }
        for (const id of f.objects) {
          const obj = objectById(id);
          if (obj) strokeObjectOutline(obj, color, active ? 2.5 : 1.2);
        }
      }
    }
  }

  // 选中对象 / 校验失败对象
  if (state.selectedObject) {
    const obj = objectById(state.selectedObject);
    if (obj) strokeObjectOutline(obj, "#ffffff", 2);
  }
  for (const id of state.invalidObjects) {
    const obj = objectById(id);
    if (obj) strokeObjectOutline(obj, "#ff2d2d", 2, [4, 3]);
  }
}

// ---------------------------------------------------------------- 侧栏
function groupNets(data) {
  const nets = {};
  for (const obj of data.objects) {
    (nets[obj.net] = nets[obj.net] || []).push(obj.id);
  }
  return nets;
}

function renderNetList() {
  const data = displayData();
  const ul = $("net-list");
  ul.innerHTML = "";
  const nets = groupNets(data);
  for (const net of Object.keys(nets).sort()) {
    const li = document.createElement("li");
    if (net === state.selectedNet) li.classList.add("selected");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = netColor(net, "top");
    li.appendChild(sw);
    const name = document.createElement("span");
    name.textContent = ` ${net}`;
    li.appendChild(name);
    const info = state.activeCheck && state.findingsVisible
      && state.activeCheck.version === displayedVersion()
      ? state.activeCheck.nets[net] : null;
    if (info) {
      const tag = document.createElement("span");
      tag.className = "tag " + (info.routed ? "tag-ok" : "tag-unrouted");
      tag.textContent = info.routed ? "已布通" : `未布通 ${info.islands.length} 岛`;
      li.appendChild(tag);
    }
    const cnt = document.createElement("span");
    cnt.style.color = "#8a96a8";
    cnt.textContent = ` ${nets[net].length} 对象`;
    li.appendChild(cnt);
    li.onclick = () => selectNet(net);
    ul.appendChild(li);
  }
  renderNetDetail();
}

function renderNetDetail() {
  const div = $("net-detail");
  if (!state.selectedNet) { div.classList.add("hidden"); return; }
  div.classList.remove("hidden");
  const info = state.activeCheck && state.findingsVisible
    && state.activeCheck.version === displayedVersion()
    ? state.activeCheck.nets[state.selectedNet] : null;
  let html = `<h3>网络 ${escapeHtml(state.selectedNet)}</h3>`;
  if (!info) {
    html += `<p>运行检查后可查看该网络在顶层/底层的实际连接范围。</p>`;
  } else {
    html += `<p>状态：${info.routed ? "已布通（全部焊盘同属一个铜岛）" : "未布通"}</p>`;
    info.islands.forEach((island, idx) => {
      const color = ISLAND_COLORS[idx % ISLAND_COLORS.length];
      html += `<div><span class="swatch" style="background:${color}"></span> 岛 ${idx + 1}：`;
      html += island.map((id) =>
        `<span class="obj-link" data-obj="${escapeHtml(id)}">${escapeHtml(id)}</span>`).join("");
      html += `</div>`;
    });
  }
  div.innerHTML = html;
  div.querySelectorAll(".obj-link").forEach((el) => {
    el.onclick = () => selectObject(el.dataset.obj);
  });
}

function renderFindings() {
  const ul = $("finding-list");
  ul.innerHTML = "";
  const show = state.activeCheck && state.findingsVisible
    && state.activeCheck.version === displayedVersion();
  $("finding-count").textContent = show
    ? `v${state.activeCheck.version} · 短接 ${state.activeCheck.summary.short} / `
      + `净空 ${state.activeCheck.summary.clearance} / 未布通 ${state.activeCheck.summary.unrouted}`
    : "";
  if (!show) {
    const li = document.createElement("li");
    li.textContent = state.dirty ? "设计已修改，请重新运行检查" : "暂无检查结果";
    li.style.cursor = "default";
    ul.appendChild(li);
    $("finding-detail").classList.add("hidden");
    return;
  }
  const labels = { short: "短接", clearance: "净空", unrouted: "未布通" };
  for (const f of state.activeCheck.findings) {
    const li = document.createElement("li");
    if (state.activeFinding && state.activeFinding.id === f.id) li.classList.add("selected");
    const tag = document.createElement("span");
    tag.className = `tag tag-${f.type}`;
    tag.textContent = labels[f.type];
    li.appendChild(tag);
    const txt = document.createElement("span");
    txt.textContent = f.type === "unrouted"
      ? ` ${f.net}`
      : ` ${f.objects.join(" ↔ ")}${f.layer ? " (" + f.layer + ")" : ""}`;
    li.appendChild(txt);
    li.onclick = () => selectFinding(f);
    ul.appendChild(li);
  }
  if (!state.activeCheck.findings.length) {
    const li = document.createElement("li");
    li.textContent = "未发现问题 ✓";
    li.style.cursor = "default";
    ul.appendChild(li);
  }
  renderFindingDetail();
}

function renderFindingDetail() {
  const div = $("finding-detail");
  const f = state.activeFinding;
  const show = f && state.activeCheck && state.findingsVisible
    && state.activeCheck.version === displayedVersion();
  if (!show) { div.classList.add("hidden"); return; }
  div.classList.remove("hidden");
  const labels = { short: "短接", clearance: "净空违规", unrouted: "未布通网络" };
  let rows = `<dt>类型</dt><dd>${labels[f.type]}</dd>`;
  if (f.layer) rows += `<dt>铜层</dt><dd>${f.layer === "top" ? "顶层" : "底层"}</dd>`;
  rows += `<dt>网络</dt><dd>${f.nets.map(escapeHtml).join(", ")}</dd>`;
  rows += `<dt>对象</dt><dd>${f.objects.map((id) =>
    `<span class="obj-link" data-obj="${escapeHtml(id)}">${escapeHtml(id)}</span>`).join("")}</dd>`;
  rows += `<dt>规则</dt><dd>${escapeHtml(f.rule)}${f.limit_mm !== undefined ? ` = ${f.limit_mm} mm` : ""}</dd>`;
  if (f.distance_mm !== undefined) rows += `<dt>实测净距</dt><dd>${f.distance_mm} mm</dd>`;
  if (f.islands) rows += `<dt>铜岛数</dt><dd>${f.islands.length}</dd>`;
  rows += `<dt>依据</dt><dd>${escapeHtml(f.detail)}</dd>`;
  div.innerHTML = `<h3>问题详情（v${state.activeCheck.version}）</h3><dl>${rows}</dl>`;
  div.querySelectorAll(".obj-link").forEach((el) => {
    el.onclick = () => selectObject(el.dataset.obj);
  });
}

function renderCheckList() {
  const ul = $("check-list");
  ul.innerHTML = "";
  for (const c of state.checks) {
    const li = document.createElement("li");
    if (state.activeCheck && state.activeCheck.id === c.id) li.classList.add("selected");
    const t = new Date(c.created_at * 1000).toLocaleTimeString();
    li.textContent = `v${c.version} · ${t} · 短${c.summary.short}/距${c.summary.clearance}/断${c.summary.unrouted}`;
    li.onclick = () => viewCheck(c.id);
    ul.appendChild(li);
  }
}

function renderSidebar() {
  renderNetList();
  renderFindings();
  renderCheckList();
}

// ---------------------------------------------------------------- 横幅与状态
function setBanner(text, isError) {
  const b = $("banner");
  if (!text) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  b.classList.toggle("error", !!isError);
  b.textContent = text;
}
function refreshChrome() {
  $("design-label").textContent = `${state.name} · v${displayedVersion()}`;
  $("dirty-badge").classList.toggle("hidden", !state.dirty);
  $("viewmode-badge").classList.toggle("hidden", state.viewVersion === null);
  if (state.viewVersion !== null) {
    $("viewmode-badge").textContent = `查看历史版本 v${state.viewVersion}（只读）`;
  }
  $("btn-back-to-edit").classList.toggle("hidden", state.viewVersion === null);
  if (!state.dirty && state.viewVersion === null) setBanner(null);
}

// ---------------------------------------------------------------- 编辑
function markDirty() {
  if (state.viewVersion !== null) return; // 历史快照只读
  state.dirty = true;
  state.findingsVisible = false; // 旧版问题不得标在新坐标上
  state.activeFinding = null;
  state.invalidObjects = [];
  setBanner(`设计已修改（基于 v${state.version}），上次检查结果已过期，请保存后重新运行检查。`);
  refreshChrome();
  renderSidebar();
  render();
}

function hitTest(mx, my) {
  const data = displayData();
  const [x, y] = fromScreen(mx, my);
  const tol = 3 / state.view.scale; // 3px 命中容差
  // 后画优先：via > top > bottom
  const order = [...data.objects].sort((a, b) => {
    const rank = (o) => o.kind === "via" ? 2 : (objectsLayers(o).includes("top") ? 1 : 0);
    return rank(a) - rank(b);
  });
  for (let i = order.length - 1; i >= 0; i--) {
    const obj = order[i];
    if (obj.kind === "trace") {
      const r = obj.width / 2 + tol;
      for (let k = 0; k < obj.path.length - 1; k++) {
        if (pointSegDist(x, y, obj.path[k], obj.path[k + 1]) <= r) return obj;
      }
    } else {
      const r = obj.diameter / 2 + tol;
      if (Math.hypot(x - obj.x, y - obj.y) <= r) return obj;
    }
  }
  return null;
}

function pointSegDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

let drag = null; // {mode:'pan'|'object', ...}
canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (state.viewVersion === null) {
    const obj = hitTest(mx, my);
    if (obj) {
      state.selectedObject = obj.id;
      state.selectedNet = obj.net;
      drag = { mode: "object", id: obj.id, last: fromScreen(mx, my), moved: false };
      renderSidebar();
      render();
      return;
    }
  }
  drag = { mode: "pan", startX: mx, startY: my, ox: state.view.ox, oy: state.view.oy };
});
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const [x, y] = fromScreen(mx, my);
  $("cursor-pos").textContent = `x ${x.toFixed(2)} mm, y ${y.toFixed(2)} mm`;
  if (!drag) return;
  if (drag.mode === "pan") {
    state.view.ox = drag.ox + (mx - drag.startX);
    state.view.oy = drag.oy + (my - drag.startY);
    render();
  } else {
    const cur = fromScreen(mx, my);
    const dx = cur[0] - drag.last[0], dy = cur[1] - drag.last[1];
    if (dx || dy) {
      const obj = state.design.objects.find((o) => o.id === drag.id);
      if (obj.kind === "trace") {
        obj.path = obj.path.map(([px, py]) => [round3(px + dx), round3(py + dy)]);
      } else {
        obj.x = round3(obj.x + dx);
        obj.y = round3(obj.y + dy);
      }
      drag.last = cur;
      drag.moved = true;
      markDirty();
    }
  }
});
window.addEventListener("mouseup", () => {
  if (drag && drag.mode === "object" && !drag.moved) {
    selectObject(drag.id);
  }
  drag = null;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const [wx, wy] = fromScreen(mx, my);
  state.view.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  state.view.scale = Math.min(Math.max(state.view.scale, 0.5), 500);
  state.view.ox = mx - wx * state.view.scale;
  state.view.oy = my + wy * state.view.scale;
  render();
}, { passive: false });

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function selectNet(net) {
  state.selectedNet = net;
  state.selectedObject = null;
  renderSidebar();
  render();
}
function selectObject(id) {
  const obj = objectById(id);
  if (!obj) return;
  state.selectedObject = id;
  state.selectedNet = obj.net;
  renderSidebar();
  render();
}
function selectFinding(f) {
  state.activeFinding = f;
  if (f.type !== "unrouted") fitObjects(f.objects);
  else if (f.objects.length) fitObjects(f.objects);
  renderSidebar();
  render();
}

// 换层：走线 top<->bottom；焊盘 top->bottom->multi 循环
$("btn-flip-layer").onclick = () => {
  if (state.viewVersion !== null || !state.selectedObject) return;
  const obj = state.design.objects.find((o) => o.id === state.selectedObject);
  if (!obj || obj.kind === "via") return;
  if (obj.kind === "trace") {
    obj.layer = obj.layer === "top" ? "bottom" : "top";
  } else {
    obj.layer = { top: "bottom", bottom: "multi", multi: "top" }[obj.layer];
  }
  markDirty();
};

$("show-top").onchange = (e) => { state.layerVisible.top = e.target.checked; render(); };
$("show-bottom").onchange = (e) => { state.layerVisible.bottom = e.target.checked; render(); };
$("clearance-input").onchange = (e) => {
  if (state.viewVersion !== null) return;
  const v = parseFloat(e.target.value);
  if (!(v >= 0)) return;
  state.design.rules.clearance_mm = v;
  markDirty();
};

// ---------------------------------------------------------------- 保存 / 检查
async function save() {
  try {
    const resp = await api(`/api/designs/${state.designId}/versions`, {
      method: "PUT",
      body: JSON.stringify({ base_version: state.version, data: state.design }),
    });
    state.version = resp.version;
    state.dirty = false;
    state.invalidObjects = [];
    setBanner(null);
    refreshChrome();
    await refreshChecks();
    return true;
  } catch (err) {
    if (err.status === 409) {
      openConflictDialog(err.body.latest_version);
    } else if (err.status === 422) {
      const errs = (err.body && err.body.errors) || [];
      state.invalidObjects = errs.map((e) => e.object).filter(Boolean);
      setBanner("设计不完整，无法保存：" +
        errs.map((e) => `${e.object || "设计"}: ${e.message}`).join("；"), true);
      render();
    } else {
      setBanner(`保存失败：${err.message}`, true);
    }
    return false;
  }
}

async function runCheck() {
  if (state.viewVersion !== null) backToEdit();
  if (state.dirty) {
    const ok = await save();
    if (!ok) return; // 冲突或校验失败：保留编辑内容，不跑检查
  }
  try {
    const result = await api(`/api/designs/${state.designId}/checks`, {
      method: "POST",
      body: JSON.stringify({ version: state.version }),
    });
    state.activeCheck = result;
    state.activeFinding = null;
    state.findingsVisible = true;
    setBanner(null);
    refreshChrome();
    await refreshChecks();
    renderSidebar();
    render();
  } catch (err) {
    setBanner(`检查失败：${err.message}`, true);
  }
}

async function refreshChecks() {
  const resp = await api(`/api/designs/${state.designId}/checks`);
  state.checks = resp.checks;
  renderCheckList();
}

async function viewCheck(checkId) {
  try {
    const check = await api(`/api/designs/${state.designId}/checks/${checkId}`);
    if (check.version === state.version && !state.dirty) {
      state.viewVersion = null;
      state.viewData = null;
    } else {
      const snap = await api(`/api/designs/${state.designId}/versions/${check.version}`);
      state.viewVersion = check.version;
      state.viewData = snap.data;
    }
    state.activeCheck = check;
    state.activeFinding = null;
    state.findingsVisible = true;
    state.selectedNet = null;
    state.selectedObject = null;
    refreshChrome();
    renderSidebar();
    fitAll();
  } catch (err) {
    setBanner(`加载检查结果失败：${err.message}`, true);
  }
}

function backToEdit() {
  state.viewVersion = null;
  state.viewData = null;
  state.activeFinding = null;
  // 当前版本若无有效结果，则撤下问题标注
  state.findingsVisible = !!(state.activeCheck
    && state.activeCheck.version === state.version && !state.dirty);
  refreshChrome();
  renderSidebar();
  render();
}

// ---------------------------------------------------------------- 冲突对话框
let conflictResolve = null;
function openConflictDialog(latestVersion) {
  $("conflict-text").textContent =
    `服务器上的设计已更新到 v${latestVersion}（可能来自另一个窗口）。` +
    `直接保存将覆盖那些改动。`;
  $("conflict-dialog").showModal();
}
$("btn-conflict-cancel").onclick = () => $("conflict-dialog").close();
$("btn-conflict-reload").onclick = async () => {
  $("conflict-dialog").close();
  await loadLatest();
  setBanner("已加载最新版本，本地未保存的修改已放弃。");
};
$("btn-conflict-overwrite").onclick = async () => {
  $("conflict-dialog").close();
  try {
    const latest = await api(`/api/designs/${state.designId}`);
    const resp = await api(`/api/designs/${state.designId}/versions`, {
      method: "PUT",
      body: JSON.stringify({ base_version: latest.latest_version, data: state.design }),
    });
    state.version = resp.version;
    state.dirty = false;
    refreshChrome();
    await refreshChecks();
    renderSidebar();
    setBanner(`已强制保存为 v${resp.version}（覆盖了其他窗口的改动）。`);
  } catch (err) {
    setBanner(`强制保存失败：${err.message}`, true);
  }
};

// ---------------------------------------------------------------- 加载
async function loadLatest() {
  const d = await api(`/api/designs/${state.designId}`);
  state.name = d.name;
  state.version = d.latest_version;
  state.design = d.design;
  state.dirty = false;
  state.viewVersion = null;
  state.viewData = null;
  state.invalidObjects = [];
  $("clearance-input").value = d.design.rules.clearance_mm;
  refreshChrome();
  renderSidebar();
  fitAll();
}

async function init() {
  window.addEventListener("resize", resizeCanvas);
  $("btn-save").onclick = save;
  $("btn-check").onclick = runCheck;
  $("btn-back-to-edit").onclick = backToEdit;
  resizeCanvas();

  const list = await api("/api/designs");
  state.designId = list.designs[0].id;
  await loadLatest();
  await refreshChecks();
  // 打开即检查：若最新版本还没有检查结果则补跑一次，
  // 保证板图与检查结果来自同一份设计版本。
  const latest = state.checks.find((c) => c.version === state.version);
  if (latest) {
    state.activeCheck = await api(`/api/designs/${state.designId}/checks/${latest.id}`);
    state.findingsVisible = true;
    renderSidebar();
    render();
  } else {
    await runCheck();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init().catch((err) => setBanner(`初始化失败：${err.message}`, true));
