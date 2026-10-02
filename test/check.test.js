'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runCheck } = require('../backend/check');
const { sampleDesign, validateDesign, canonicalJSON, hashContent } = require('../backend/design');

function baseDesign(overrides = {}) {
  const d = {
    formatVersion: 1,
    unit: 'mm',
    name: 't',
    board: { width: 60, height: 40 },
    layers: ['top', 'bottom'],
    rules: { clearance: 0.2 },
    objects: [],
  };
  return Object.assign(d, overrides);
}

const pad = (id, net, x, y, layers = ['top'], extra = {}) => ({
  id, type: 'pad', component: id.toUpperCase(), pin: '1',
  x, y, shape: 'circle', r: 0.8, holeRadius: 0, net, layers, ...extra,
});
const via = (id, net, x, y) => ({
  id, type: 'via', x, y, r: 0.6, drill: 0.3, net, layers: ['top', 'bottom'],
});
const trace = (id, net, layer, width, points) =>
  ({ id, type: 'trace', net, layer, width, points });

const META = { revisionId: 'rev_x', contentHash: 'a'.repeat(64) };

function check(design) {
  const r = runCheck(design, META);
  assert.ok(r.ok, () => `设计校验失败: ${JSON.stringify(r.errors)}`);
  return r.report;
}

// ---------------------------------------------------------------------------

test('同层线端贴着焊盘边缘：计入连接，无问题', () => {
  // 线宽 0.5（半宽 .25），端点中心距焊盘中心 1.05，焊盘半径 .8 -> 表面接触
  const d = baseDesign({
    objects: [
      pad('p1', 'N', 0, 0),
      pad('p2', 'N', 5, 0),
      trace('t1', 'N', 'top', 0.5, [[0, 0], [4.2, 0]]),
      trace('t2', 'N', 'top', 0.5, [[5, 0], [5.8, 0]]),
    ],
  });
  const r = check(d);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  assert.equal(r.nets.N.reach.length, 1);
});

test('不同铜层投影相交但无过孔：不导通，判为未布通并给出跨层证据', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'N', 0, 0),
      pad('p2', 'N', 20, 20, ['bottom']),
      trace('t1', 'N', 'top', 0.5, [[0, 0], [10, 10]]),
      trace('t2', 'N', 'bottom', 0.5, [[5, 15], [15, 5]]),
    ],
  });
  // 注意：bottom 焊盘层为 ['bottom']
  const r = check(d);
  const unrouted = r.issues.filter((i) => i.type === 'unrouted');
  assert.equal(unrouted.length, 1);
  assert.equal(unrouted[0].net, 'N');
  assert.ok(unrouted[0].projectedPairs.length >= 1, '应当报告跨层投影假相交');
  assert.equal(unrouted[0].projectedPairs[0].objectA, 't1');
  assert.equal(unrouted[0].projectedPairs[0].objectB, 't2');
});

test('投影相交处放一个同网络过孔：上下连通，无未布通', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'N', 0, 0),
      pad('p2', 'N', 20, 20, ['bottom']),
      trace('t1', 'N', 'top', 0.5, [[0, 0], [10, 10]]),
      trace('t2', 'N', 'bottom', 0.5, [[10, 10], [20, 20]]),
      via('v1', 'N', 10, 10),
    ],
  });
  const r = check(d);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  assert.equal(r.nets.N.reach.length, 1);
});

test('贯通焊盘（插件孔）等价于过孔，可跨层搭桥', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'N', 0, 0),
      pad('p2', 'N', 8, 8, ['top', 'bottom'], { holeRadius: 0.4 }),
      trace('t1', 'N', 'top', 0.5, [[0, 0], [8, 8]]),
      trace('t2', 'N', 'bottom', 0.5, [[8, 8], [20, 20]]),
      pad('p3', 'N', 20, 20, ['bottom']),
    ],
  });
  const r = check(d);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});

test('不同网络同层接触 -> 短接，报告具体两处对象、铜层与依据', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'A', 0, 0),
      pad('p2', 'B', 10, 0),
      trace('t1', 'A', 'top', 0.5, [[0, 0], [5, 0]]),
      trace('t2', 'B', 'top', 0.5, [[5, 0], [10, 0]]),
    ],
  });
  const r = check(d);
  const shorts = r.issues.filter((i) => i.type === 'short');
  assert.equal(shorts.length, 1);
  assert.deepEqual(shorts[0].objects.sort(), ['t1', 't2']);
  assert.equal(shorts[0].layer, 'top');
  assert.equal(shorts[0].distance, 0);
  assert.ok(/表面接触/.test(shorts[0].basis));
});

test('不同网络不同层投影相交：既不是短接也不是净空问题', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'A', 0, 0),
      pad('p2', 'B', 20, 20, ['bottom']),
      trace('t1', 'A', 'top', 0.5, [[0, 0], [10, 10]]),
      trace('t2', 'B', 'bottom', 0.5, [[5, 15], [15, 5]]),
    ],
  });
  const r = check(d);
  assert.equal(r.issues.some((i) => i.type === 'short'), false);
  assert.equal(r.issues.some((i) => i.type === 'clearance'), false);
});

test('不同网络同层靠近但不接触：测得距离 < clearance -> 净空违规且带测量值', () => {
  // 两条宽 0.5 走线中心线相距 0.45，表面间隙 0.45 - 0.25 - 0.25 = -0.05? 用 0.55 中心距
  // 表面 = 0.55 - 0.5 = 0.05 < 0.2
  const d = baseDesign({
    objects: [
      pad('p1', 'A', 0, 0),
      pad('p2', 'B', 0, 10),
      trace('t1', 'A', 'top', 0.5, [[0, 0], [10, 0]]),
      trace('t2', 'B', 'top', 0.5, [[0, 0.55], [10, 0.55]]),
    ],
  });
  const r = check(d);
  const cl = r.issues.filter((i) => i.type === 'clearance');
  assert.equal(cl.length, 1);
  assert.ok(Math.abs(cl[0].distance - 0.05) < 1e-6);
  assert.equal(cl[0].required, 0.2);
  assert.deepEqual(cl[0].objects.sort(), ['t1', 't2']);
});

test('放宽 clearance 到 0.04 后同一设计不再有净空问题', () => {
  const d = baseDesign({
    rules: { clearance: 0.04 },
    objects: [
      pad('p1', 'A', 0, 0),
      pad('p2', 'B', 0, 10),
      trace('t1', 'A', 'top', 0.5, [[0, 0], [10, 0]]),
      trace('t2', 'B', 'top', 0.5, [[0, 0.55], [10, 0.55]]),
    ],
  });
  const r = check(d);
  assert.equal(r.issues.some((i) => i.type === 'clearance'), false);
});

test('净空边界：表面间隙恰好等于 clearance 时合规（严格 < 才违规）', () => {
  // 两条平行线在板中部：中心距 0.7、半宽和 0.5 -> 表面 0.2 恰好等于要求；
  // B 焊盘与引线放在远离平行段的位置
  const d = baseDesign({
    rules: { clearance: 0.2 },
    objects: [
      pad('p1', 'A', 2, 2),
      pad('p2', 'B', 2, 12),
      trace('t1', 'A', 'top', 0.5, [[2, 2], [40, 2]]),
      trace('t2', 'B', 'top', 0.5, [[8, 2.7], [40, 2.7]]),
      trace('t3', 'B', 'top', 0.5, [[2, 12], [8, 12], [8, 2.7]]),
    ],
  });
  const r = check(d);
  assert.equal(r.issues.some((i) => i.type === 'clearance'), false, JSON.stringify(r.issues));
  assert.equal(r.issues.some((i) => i.type === 'short'), false);
});

test('线端与焊盘边缘相切（距离 0）即连通；差一丝（间隙 EPS 量级）不连通', () => {
  const mk = (endX) => baseDesign({
    objects: [
      pad('p1', 'N', 0, 0),
      pad('p2', 'N', 5, 0),
      // p2 半径 .8，走线半宽 .25，相切时端点中心 = 5 - 1.05 = 3.95
      trace('t1', 'N', 'top', 0.5, [[0, 0], [endX, 0]]),
    ],
  });
  assert.equal(check(mk(3.95)).issues.length, 0);
  const open = check(mk(3.949));
  assert.ok(open.issues.some((i) => i.type === 'unrouted'));
});

test('同网络多段同层链接触碰焊盘 -> 单岛；短接岛上的全部焊盘网络都可从 islands 读出', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'A', 0, 0),
      pad('p2', 'B', 10, 0),
      trace('t1', 'A', 'top', 0.5, [[0, 0], [5, 0]]),
      trace('t2', 'B', 'top', 0.5, [[5, 0], [10, 0]]),
    ],
  });
  const r = check(d);
  const isl = r.islands.find((i) => i.nets.includes('A') && i.nets.includes('B'));
  assert.ok(isl, '短接的两网络应处于同一连通岛');
  assert.deepEqual(isl.pads.map((p) => p.net).sort(), ['A', 'B']);
});

test('网络名相同不等于连接：两个独立 A 网络焊盘 + 无连接走线，判未布通', () => {
  const d = baseDesign({
    objects: [
      pad('p1', 'A', 0, 0),
      pad('p2', 'A', 10, 0),
      trace('t1', 'A', 'top', 0.5, [[3, 3], [6, 6]]), // 接不到任何焊盘的铜岛
    ],
  });
  const r = check(d);
  assert.equal(r.issues.some((i) => i.type === 'unrouted'), true);
  const u = r.issues.find((i) => i.type === 'unrouted');
  assert.ok(u.islands.length >= 2);
});

test('局部几何身份稳定：移动不相关网络不改变其他对象 id 与连接结论', () => {
  const rep1 = check(sampleDesign());
  const moved = sampleDesign();
  const t11 = moved.objects.find((o) => o.id === 't11');
  // 整条 LEDA 走线搬到板子另一侧，远离 LEDB 走线与 LEDA 焊盘（不再接触任何对象）
  t11.points = [[6, 40], [8, 36]];
  const rep2 = check(moved);
  // SIG 净空问题（与 t2/t14 有关）距离必须保持不变
  const sig1 = rep1.issues.find((i) => i.type === 'clearance');
  const sig2 = rep2.issues.find((i) => i.type === 'clearance');
  assert.ok(sig1 && sig2);
  assert.equal(sig1.distance, sig2.distance);
  assert.deepEqual(sig2.objects, ['t2', 't14']);
  // 移动后 LEDA/LEDB 短接消失（LEDA 变成未布通是另一条结论，不计短接）
  assert.equal(rep2.counts.short, 0);
});

test('内置示例板：恰好检出短接/净空/未布通各一处', () => {
  const r = check(sampleDesign());
  assert.equal(r.counts.short, 1);
  assert.equal(r.counts.clearance, 1);
  assert.equal(r.counts.unrouted, 1);
  const u = r.issues.find((i) => i.type === 'unrouted');
  assert.equal(u.net, 'XNET');
  const s = r.issues.find((i) => i.type === 'short');
  assert.deepEqual(s.objects.sort(), ['t11', 't12']);
});

// ---------------------------------------------------------------------------

test('校验拒绝不完整设计：缺网络的对象带 objectId', () => {
  const d = baseDesign({
    objects: [trace('t1', '', 'top', 0.5, [[0, 0], [1, 1]])],
  });
  const v = validateDesign(d);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.code === 'object.missing-net' && e.objectId === 't1'));
});

test('校验拒绝负线宽、坏单位、负净空', () => {
  const d = baseDesign({
    unit: 'mil',
    rules: { clearance: -1 },
    objects: [
      { id: 'x', type: 'trace', net: 'A', layer: 'top', width: -0.5, points: [[0, 0]] },
    ],
  });
  const v = validateDesign(d);
  const codes = v.errors.map((e) => e.code);
  assert.ok(codes.includes('design.unit'));
  assert.ok(codes.includes('rules.clearance'));
  assert.ok(codes.includes('trace.width'));
  assert.ok(codes.includes('trace.points'));
});

test('规范化 JSON 对键顺序不敏感（内容哈希是几何版本身份）', () => {
  const a = { b: 1, a: [1, 2, 3], c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: [1, 2, 3], b: 1 };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.equal(hashContent(a), hashContent(b));
});
