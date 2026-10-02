'use strict';

// ---------------------------------------------------------------------------
// check.js — 服务端规则检查引擎。输入一份经过校验的设计（坐标单位 mm），
// 输出与该设计内容严格绑定的检查报告。
//
// 连接模型（关键规则）：
//   1. 同一铜层上，两对象的铜表面距离 <= EPS（接触）才导通；线端贴着焊盘
//      边缘算连接。
//   2. 不同铜层投影相交/接触 *不* 导通，除非存在同一对象同时跨越两层
//      （过孔、贯通焊盘）——并查集以“对象”为节点，跨层对象天然搭桥。
//   3. 网络名相同只是网表预期，不是电气连接。
//
// 三类问题：
//   short      不同网络在同层表面接触（distance = 0），已经短接；
//   clearance  不同网络同层表面间隙 < 规则要求但未接触；
//   unrouted   同一网络的焊盘落在多个连通岛上，或存在接不到任何焊盘的铜岛
//              （报告跨层投影假相交作为判断依据）。
// ---------------------------------------------------------------------------

const { validateDesign, EPS } = require('./design');
const { primitiveDistance, primitiveBBox } = require('./geometry');

// 把一个对象展开为指定层上的铜基元
function primitivesOfObject(obj, layer) {
  const out = [];
  if (obj.type === 'pad' || obj.type === 'via') {
    if (!obj.layers.includes(layer)) return out;
    if (obj.shape === 'rect') {
      out.push({
        kind: 'rect', objectId: obj.id, net: obj.net,
        x: obj.x - obj.w / 2, y: obj.y - obj.h / 2, w: obj.w, h: obj.h,
      });
    } else {
      out.push({ kind: 'circle', objectId: obj.id, net: obj.net, x: obj.x, y: obj.y, r: obj.r });
    }
  } else if (obj.type === 'trace' && obj.layer === layer) {
    for (let i = 0; i < obj.points.length - 1; i += 1) {
      const [x1, y1] = obj.points[i];
      const [x2, y2] = obj.points[i + 1];
      out.push({ kind: 'seg', objectId: obj.id, net: obj.net, x1, y1, x2, y2, w: obj.width });
    }
  }
  return out;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = id;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function unionBBoxes(boxes) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  boxes.forEach((x) => {
    b.minX = Math.min(b.minX, x.minX);
    b.minY = Math.min(b.minY, x.minY);
    b.maxX = Math.max(b.maxX, x.maxX);
    b.maxY = Math.max(b.maxY, x.maxY);
  });
  return b;
}

function pairKey(layer, a, b) {
  return [a, b, layer].sort().join('|');
}

function runCheck(design, meta) {
  const validation = validateDesign(design);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  const clearance = design.rules.clearance;
  const layers = design.layers;
  const objects = new Map(design.objects.map((o) => [o.id, o]));

  // 逐层基元
  const byLayer = new Map(layers.map((l) => [l, []]));
  design.objects.forEach((o) => {
    layers.forEach((layer) => {
      primitivesOfObject(o, layer).forEach((p) => byLayer.get(layer).push(p));
    });
  });

  const uf = new UnionFind([...objects.keys()]);
  const touches = []; // 所有同层接触对
  const clearanceIssues = [];
  const seenPair = new Set();

  layers.forEach((layer) => {
    const prims = byLayer.get(layer);
    for (let i = 0; i < prims.length; i += 1) {
      for (let j = i + 1; j < prims.length; j += 1) {
        const A = prims[i];
        const B = prims[j];
        if (A.objectId === B.objectId) continue;
        const key = pairKey(layer, A.objectId, B.objectId);
        const d = primitiveDistance(A, B);
        const distance = round6(d.distance);
        if (distance <= EPS) {
          uf.union(A.objectId, B.objectId);
          if (!seenPair.has(key)) {
            seenPair.add(key);
            touches.push({
              layer, a: A.objectId, b: B.objectId,
              pointA: { x: round6(d.p1.x), y: round6(d.p1.y) },
              pointB: { x: round6(d.p2.x), y: round6(d.p2.y) },
              netA: A.net, netB: B.net,
            });
          }
        } else if (A.net !== B.net && distance < clearance - EPS) {
          if (!seenPair.has(key)) {
            seenPair.add(key);
            clearanceIssues.push({
              type: 'clearance',
              severity: 'clearance',
              ruleId: 'CLEARANCE',
              ruleText: `不同网络铜形状在同一铜层上的表面净空不得小于 ${clearance} mm`,
              layer,
              objects: [A.objectId, B.objectId],
              objectTypes: [objects.get(A.objectId).type, objects.get(B.objectId).type],
              nets: [A.net, B.net],
              distance,
              required: clearance,
              pointA: { x: round6(d.p1.x), y: round6(d.p1.y) },
              pointB: { x: round6(d.p2.x), y: round6(d.p2.y) },
              basis: `在 ${layer === 'top' ? '顶层' : '底层'} 测得两网络铜表面最近点间距 ${distance} mm，净空要求 ${clearance} mm`,
              bbox: unionBBoxes([primitiveBBox(A), primitiveBBox(B)]),
            });
          }
        }
      }
    }
  });

  // 连通岛
  const islandMap = new Map();
  design.objects.forEach((o) => {
    const root = uf.find(o.id);
    if (!islandMap.has(root)) {
      islandMap.set(root, { id: `isl_${root}`, objectIds: [], nets: new Set(), layers: new Set() });
    }
    const isl = islandMap.get(root);
    isl.objectIds.push(o.id);
    isl.nets.add(o.net);
    if (o.type === 'trace') isl.layers.add(o.layer);
    if (o.type === 'via' || o.type === 'pad') o.layers.forEach((l) => isl.layers.add(l));
  });

  const objectBBoxes = new Map();
  design.objects.forEach((o) => {
    const ps = [];
    layers.forEach((layer) => primitivesOfObject(o, layer).forEach((p) => ps.push(primitiveBBox(p))));
    objectBBoxes.set(o.id, unionBBoxes(ps));
  });

  const islands = [...islandMap.values()].map((isl) => {
    const pads = isl.objectIds
      .filter((id) => objects.get(id).type === 'pad')
      .map((id) => {
        const p = objects.get(id);
        return { objectId: id, component: p.component, pin: p.pin, net: p.net, x: p.x, y: p.y };
      });
    const vias = isl.objectIds.filter((id) => objects.get(id).type === 'via');
    const traces = isl.objectIds.filter((id) => objects.get(id).type === 'trace');
    return {
      id: isl.id,
      objectIds: isl.objectIds,
      nets: [...isl.nets],
      layers: [...isl.layers],
      pads,
      viaIds: vias,
      traceIds: traces,
      bbox: unionBBoxes(isl.objectIds.map((id) => objectBBoxes.get(id))),
    };
  });
  const islandOf = new Map();
  islands.forEach((isl) => isl.objectIds.forEach((id) => islandOf.set(id, isl.id)));

  const issues = [];

  // ---- 短接：同层接触且网络不同（每次接触对都是具体的“两处对象”） ----
  touches.forEach((t) => {
    if (t.netA === t.netB) return;
    issues.push({
      type: 'short',
      severity: 'short',
      ruleId: 'NO_SHORT',
      ruleText: '不同网络的铜形状在同一铜层表面接触即构成短接（距离 0 mm）',
      layer: t.layer,
      objects: [t.a, t.b],
      objectTypes: [objects.get(t.a).type, objects.get(t.b).type],
      nets: [t.netA, t.netB],
      distance: 0,
      pointA: t.pointA,
      pointB: t.pointB,
      island: islandOf.get(t.a),
      basis: `${t.netA} 与 ${t.netB} 在 ${t.layer === 'top' ? '顶层' : '底层'} 的铜表面接触（最近点重合于 ` +
        `(${t.pointA.x}, ${t.pointA.y}) mm），两网络已短接`,
      bbox: unionBBoxes([objectBBoxes.get(t.a), objectBBoxes.get(t.b)]),
    });
  });

  // ---- 净空违规 ----
  issues.push(...clearanceIssues);

  // ---- 未布通：按网络归组连通岛 ----
  const padNets = new Set();
  design.objects.forEach((o) => {
    if (o.type === 'pad') padNets.add(o.net);
  });
  // net -> islands
  const netIslands = new Map();
  islands.forEach((isl) => {
    isl.nets.forEach((net) => {
      if (!netIslands.has(net)) netIslands.set(net, []);
      netIslands.get(net).push(isl);
    });
  });

  // 跨层投影假相交（同一网络、不同层、表面接触但分属不同连通岛 => 缺少过孔）
  function projectedHints(net) {
    const hints = [];
    const topP = byLayer.get('top').filter((p) => p.net === net);
    const botP = byLayer.get('bottom').filter((p) => p.net === net);
    const seen = new Set();
    topP.forEach((A) => {
      botP.forEach((B) => {
        if (A.objectId === B.objectId) return; // 跨越两层的同一对象（过孔/插件焊盘）合法
        if (uf.find(A.objectId) === uf.find(B.objectId)) return; // 已通过别处过孔连通
        const d = primitiveDistance(A, B);
        if (d.distance <= EPS) {
          const key = [A.objectId, B.objectId].sort().join('|');
          if (seen.has(key)) return;
          seen.add(key);
          hints.push({
            layerA: 'top', objectA: A.objectId,
            layerB: 'bottom', objectB: B.objectId,
            pointA: { x: round6(d.p1.x), y: round6(d.p1.y) },
            pointB: { x: round6(d.p2.x), y: round6(d.p2.y) },
            note: '两层投影相交，但没有任何过孔或贯通焊盘同时连接这两层，电气上断开',
          });
        }
      });
    });
    return hints;
  }

  const netSummary = {};
  netIslands.forEach((isls, net) => {
    const padIslands = isls.filter((i) => i.pads.length > 0);
    const copperIslands = isls.filter((i) => i.pads.length === 0);
    const padCount = isls.reduce((n, i) => n + i.pads.length, 0);
    const reach = isls.map((i) => ({
      island: i.id,
      layers: i.layers,
      pads: i.pads.map((p) => `${p.component}.${p.pin}`),
      traceIds: i.traceIds,
      viaIds: i.viaIds,
      bbox: i.bbox,
    }));
    netSummary[net] = {
      net,
      padCount,
      reach,
      routed: padIslands.length <= 1 && copperIslands.length === 0,
    };
  });

  netIslands.forEach((isls, net) => {
    if (!padNets.has(net)) return; // 没有焊盘的网络（纯铜段）不产生未布通结论
    const padIslands = isls.filter((i) => i.pads.length > 0);
    const copperIslands = isls.filter((i) => i.pads.length === 0);
    if (padIslands.length >= 2 || (padIslands.length >= 1 && copperIslands.length >= 1)) {
      const projected = projectedHints(net);
      issues.push({
        type: 'unrouted',
        severity: 'open',
        ruleId: 'NETLIST_CONNECTIVITY',
        ruleText: '同一网络名下的所有焊盘必须通过同层接触或过孔/贯通焊盘真实连通；网络名相同不代表连接',
        net,
        islands: isls.map((i) => ({
          island: i.id,
          layers: i.layers,
          padRefs: i.pads.map((p) => `${p.component}.${p.pin}`),
          traceIds: i.traceIds,
          viaIds: i.viaIds,
        })),
        projectedPairs: projected,
        basis: projected.length > 0
          ? `网络 ${net} 被分成 ${isls.length} 个连通岛；其中存在顶层/底层投影相交但无过孔的铜段，` +
            '这是“看似相连实际断开”的位置'
          : `网络 ${net} 的焊盘分布在 ${padIslands.length} 个互不连通的铜岛上` +
            (copperIslands.length ? `，另有 ${copperIslands.length} 段铜接不到任何焊盘` : ''),
        bbox: unionBBoxes(isls.map((i) => i.bbox)),
      });
    }
  });

  // 排序：短接 > 净空 > 未布通，同类型按坐标
  const order = { short: 0, clearance: 1, unrouted: 2 };
  issues.sort((a, b) => {
    if (order[a.type] !== order[b.type]) return order[a.type] - order[b.type];
    return a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY;
  });

  return {
    ok: true,
    report: {
      schemaVersion: 1,
      unit: 'mm',
      revisionId: meta.revisionId,
      contentHash: meta.contentHash,
      basedOnRevision: meta.basedOnRevision || null,
      checkedAt: new Date(0).toISOString(), // 由调用方（storage/server）覆盖为真实时间
      rules: { clearance, layers },
      counts: {
        short: issues.filter((i) => i.type === 'short').length,
        clearance: issues.filter((i) => i.type === 'clearance').length,
        unrouted: issues.filter((i) => i.type === 'unrouted').length,
      },
      islands,
      nets: netSummary,
      issues,
    },
  };
}

module.exports = { runCheck, primitivesOfObject };
