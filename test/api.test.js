'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, Storage } = require('../server');

let baseURL;
let server;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-e2e-'));
  const storage = new Storage(dataDir);
  await storage.init({ seed: true });
  server = createServer(storage);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, p, body) {
  const res = await fetch(baseURL + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let head; // 各用例依次依赖，顺序执行

test('打开应用即有可操作的示例板，而不是空后台', async () => {
  const list = await call('GET', '/api/designs');
  assert.equal(list.status, 200);
  assert.ok(list.json.designs.some((d) => d.id === 'demo'));
});

test('GET head：示例板、版次、单位', async () => {
  const r = await call('GET', '/api/designs/demo/head');
  assert.equal(r.status, 200);
  assert.match(r.json.revisionId, /^rev_[0-9a-f]{12}$/);
  assert.equal(r.json.design.unit, 'mm');
  assert.ok(r.json.design.objects.length >= 10);
  head = r.json;
});

test('检查示例板：短接(LEDA/LEDB)、净空(SIG/GND)、未布通(XNET)，且铜形状与结果同版次', async () => {
  const r = await call('POST', '/api/designs/demo/check',
    { design: head.design, basedOnRevision: head.revisionId });
  assert.equal(r.status, 200);
  const { report } = r.json;
  assert.equal(report.contentHash, r.json.contentHash);
  assert.equal(report.counts.short, 1);
  assert.equal(report.counts.clearance, 1);
  assert.equal(report.counts.unrouted, 1);

  const s = report.issues.find((i) => i.type === 'short');
  assert.deepEqual(s.objects.sort(), ['t11', 't12']);
  assert.equal(s.layer, 'top');
  assert.equal(s.distance, 0);
  assert.deepEqual(s.nets.sort(), ['LEDA', 'LEDB']);

  const c = report.issues.find((i) => i.type === 'clearance');
  assert.deepEqual([...c.objects].sort(), ['t14', 't2']);
  assert.ok(c.distance > 0 && c.distance < c.required,
    `净空测量值 ${c.distance} 应在 0 和 ${c.required} 之间`);

  const u = report.issues.find((i) => i.type === 'unrouted');
  assert.equal(u.net, 'XNET');
  // 跨层投影相交但无过孔——“看着连着实际断开”
  assert.ok(u.projectedPairs.some((p) => p.objectA === 't9' && p.objectB === 't10'));

  // 网络连接范围：3V3 在报告里是一个连通岛；XNET 有两个岛
  assert.equal(report.nets['3V3'].reach.length, 1);
  assert.equal(report.nets.XNET.reach.length, 2);
});

test('层间连通：在 XNET 跨层投影处补一个过孔后检查 -> XNET 变连通', async () => {
  const edited = JSON.parse(JSON.stringify(head.design));
  edited.objects.push({
    id: 'v_new', type: 'via', x: 52, y: 16, r: 0.6, drill: 0.3,
    net: 'XNET', layers: ['top', 'bottom'],
  });
  // t9 顶层终点 (52,16)，t10 底层经过 (52,16)，过孔桥接两层
  const r = await call('POST', '/api/designs/demo/check', { design: edited });
  assert.equal(r.status, 200);
  assert.equal(r.json.report.counts.unrouted, 0);
  assert.equal(r.json.report.nets.XNET.reach.length, 1);
  assert.equal(r.json.saved, false, '未保存内容的检查只进临时缓存');
});

test('网络归属：删掉 LEDA 走线的一段使短接消失，问题随之消失（身份不变）', async () => {
  const edited = JSON.parse(JSON.stringify(head.design));
  const t11 = edited.objects.find((o) => o.id === 't11');
  t11.points = [[58, 40], [59.2, 39.2]]; // 不再碰到 (60,36)
  const r = await call('POST', '/api/designs/demo/check', { design: edited });
  assert.equal(r.json.report.counts.short, 0);
  // 其他对象 id 未受影响
  assert.ok(edited.objects.every((o) => head.design.objects.some((h) => h.id === o.id)));
});

test('422：不完整设计被拒绝检查，错误带 objectId（前端可保留编辑并定位）', async () => {
  const broken = JSON.parse(JSON.stringify(head.design));
  broken.objects.find((o) => o.id === 't1').net = '';
  const r = await call('POST', '/api/designs/demo/check', { design: broken });
  assert.equal(r.status, 422);
  assert.ok(r.json.errors.some((e) => e.code === 'object.missing-net' && e.objectId === 't1'));
});

test('保存未改动内容是幂等的（不制造新版次）', async () => {
  const r = await call('PUT', '/api/designs/demo/save',
    { design: head.design, baseRevisionId: head.revisionId });
  assert.equal(r.status, 200);
  assert.equal(r.json.unchanged, true);
  assert.equal(r.json.revisionId, head.revisionId);
});

let saved2;
test('保存一次真实编辑 -> 产生新版本，保留父子关系', async () => {
  const edited = JSON.parse(JSON.stringify(head.design));
  edited.rules.clearance = 0.3; // 仅改规则：净空问题依旧存在（0.082<0.3），结论按同份内容计算
  const r = await call('PUT', '/api/designs/demo/save',
    { design: edited, baseRevisionId: head.revisionId });
  assert.equal(r.status, 200);
  assert.equal(r.json.unchanged, false);
  assert.notEqual(r.json.revisionId, head.revisionId);
  assert.equal(r.json.parentRevisionId, head.revisionId);
  saved2 = r.json;
});

test('版本冲突：仍基于旧版次保存 -> 409 且带服务器 head，旧内容未被覆盖', async () => {
  const edited = JSON.parse(JSON.stringify(head.design));
  edited.objects.find((o) => o.id === 't11').points = [[58, 40], [59, 39]];
  const r = await call('PUT', '/api/designs/demo/save',
    { design: edited, baseRevisionId: head.revisionId }); // 故意用旧 base
  assert.equal(r.status, 409);
  assert.equal(r.json.serverHead, saved2.revisionId);

  // 服务器 head 仍然是 saved2（未被无提示覆盖）
  const h = await call('GET', '/api/designs/demo/head');
  assert.equal(h.json.revisionId, saved2.revisionId);
  assert.equal(h.json.design.rules.clearance, 0.3);
});

test('冲突恢复：基于最新 head 重新接续保存 -> 成功（模拟用户选择后另存新版）', async () => {
  const edited = JSON.parse(JSON.stringify(head.design));
  edited.objects.find((o) => o.id === 't11').points = [[58, 40], [59, 39]];
  const r = await call('PUT', '/api/designs/demo/save',
    { design: edited, baseRevisionId: saved2.revisionId });
  assert.equal(r.status, 200);
  assert.equal(r.json.unchanged, false);
  assert.equal(r.json.parentRevisionId, saved2.revisionId);
});

test('刷新页面重开：head 与版次历史均可找回', async () => {
  const h = await call('GET', '/api/designs/demo/head');
  assert.equal(h.status, 200);
  assert.match(h.json.revisionId, /^rev_[0-9a-f]{12}$/);

  const revs = await call('GET', '/api/designs/demo/revisions');
  assert.ok(revs.json.revisions.length >= 3, '至少：示例版 + 规则修改版 + 接续保存版');

  // 取回最初的示例版快照——旧版几何不可变
  const old = await call('GET', `/api/designs/demo/revisions/${head.revisionId}`);
  assert.equal(old.status, 200);
  assert.equal(old.json.design.rules.clearance, 0.2);
  assert.equal(old.json.contentHash, head.contentHash);
});

test('旧版检查结果可按内容哈希取回，且报告中的对象 id 只在该版次几何中解释', async () => {
  // 对旧版快照内容重新检查（报告按哈希索引，与新版互不串扰）
  const old = await call('GET', `/api/designs/demo/revisions/${head.revisionId}`);
  const r = await call('POST', '/api/designs/demo/check',
    { design: old.json.design, basedOnRevision: head.revisionId });
  const hash = r.json.contentHash;
  const again = await call('GET', `/api/designs/demo/reports/${hash}`);
  assert.equal(again.status, 200);
  assert.equal(again.json.report.contentHash, hash);
  // 旧版短接对象 t11/t12 的坐标取自旧快照而非当前 head
  const s = again.json.report.issues.find((i) => i.type === 'short');
  const oldT11 = old.json.design.objects.find((o) => o.id === 't11');
  const curHead = (await call('GET', '/api/designs/demo/head')).json.design;
  const newT11 = curHead.objects.find((o) => o.id === 't11');
  assert.deepEqual(s.objects.sort(), ['t11', 't12']);
  assert.deepEqual(oldT11.points, [[58, 40], [60, 36]]);
  assert.deepEqual(newT11.points, [[58, 40], [59, 39]]);
});

test('静态页面可访问', async () => {
  const res = await fetch(baseURL + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('PCB 走线审阅工作台'));
  const js = await fetch(baseURL + '/app.js');
  assert.equal(js.status, 200);
});
