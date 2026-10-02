'use strict';

// ---------------------------------------------------------------------------
// design.js — 设计数据模型、内置示例板、完整性校验、规范化序列化与内容哈希。
//
// 设计 JSON（单位全部为毫米 mm）：
// {
//   formatVersion: 1,
//   unit: 'mm',
//   board: { width, height },
//   layers: ['top', 'bottom'],
//   rules: { clearance: 0.2 },           // 最小净空 mm
//   objects: [
//     { id, type:'pad', component, pin, x, y,
//       shape:'circle', r, holeRadius,   // holeRadius>0 表示插件焊盘，贯通两层
//       net, layers:['top'] },
//     { id, type:'via', x, y, r, drill, net, layers:['top','bottom'] },
//     { id, type:'trace', net, layer:'top'|'bottom', width, points:[[x,y],...] }
//   ]
// }
// 网络归属（网表预期）由焊盘的 net 字段声明：同一 net 的所有焊盘应当彼此导通，
// 不同 net 的焊盘若导通则为短接。网络名相同不等于几何连通。
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');

const LAYERS = ['top', 'bottom'];
const EPS = 1e-6;

function sampleDesign() {
  return {
    formatVersion: 1,
    unit: 'mm',
    name: '示例板 DEMO-8050',
    board: { width: 80, height: 50 },
    layers: ['top', 'bottom'],
    rules: { clearance: 0.2 },
    objects: [
      // ---- U1：两引脚器件，3V3 与 GND ----
      { id: 'p1', type: 'pad', component: 'U1', pin: '3V3', x: 10, y: 10,
        shape: 'circle', r: 0.8, holeRadius: 0, net: '3V3', layers: ['top'] },
      { id: 'p2', type: 'pad', component: 'U1', pin: 'GND', x: 14, y: 14,
        shape: 'circle', r: 0.8, holeRadius: 0, net: 'GND', layers: ['top'] },

      // ---- R1：串联在 3V3 与 SIG 之间 ----
      { id: 'p3', type: 'pad', component: 'R1', pin: '1', x: 24, y: 10,
        shape: 'circle', r: 0.8, holeRadius: 0, net: '3V3', layers: ['top'] },
      { id: 'p4', type: 'pad', component: 'R1', pin: '2', x: 28, y: 10,
        shape: 'circle', r: 0.8, holeRadius: 0, net: 'SIG', layers: ['top'] },

      // ---- R2：插件电阻，pin1=SIG(顶层)，pin2=GND(贯通) ----
      { id: 'p5', type: 'pad', component: 'R2', pin: '1', x: 24, y: 26,
        shape: 'circle', r: 1.0, holeRadius: 0.5, net: 'SIG', layers: ['top', 'bottom'] },
      { id: 'p6', type: 'pad', component: 'R2', pin: '2', x: 28, y: 26,
        shape: 'circle', r: 1.0, holeRadius: 0.5, net: 'GND', layers: ['top', 'bottom'] },

      // ---- R3：3V3 上拉，XNET 是一条尚未布通的网络（跨层投影相交但无过孔） ----
      { id: 'p7', type: 'pad', component: 'R3', pin: '1', x: 58, y: 10,
        shape: 'circle', r: 0.8, holeRadius: 0, net: '3V3', layers: ['top'] },
      { id: 'p8', type: 'pad', component: 'R3', pin: '2', x: 62, y: 10,
        shape: 'circle', r: 0.8, holeRadius: 0, net: 'XNET', layers: ['top'] },

      // ---- R4：LED 焊盘，两条不同网络走线在 (60,36) 相碰 -> 短接 ----
      { id: 'p9', type: 'pad', component: 'R4', pin: 'A', x: 58, y: 40,
        shape: 'circle', r: 0.8, holeRadius: 0, net: 'LEDA', layers: ['top'] },
      { id: 'p10', type: 'pad', component: 'R4', pin: 'K', x: 62, y: 40,
        shape: 'circle', r: 0.8, holeRadius: 0, net: 'LEDB', layers: ['top'] },

      // ---- 过孔：GND 从顶层换到顶层 R2 插件脚之间的底层路径 ----
      { id: 'v1', type: 'via', x: 14, y: 26, r: 0.6, drill: 0.3, net: 'GND',
        layers: ['top', 'bottom'] },

      // ---- 3V3：p1 -> p3 -> p7，单岛连通 ----
      { id: 't1', type: 'trace', net: '3V3', layer: 'top', width: 0.5,
        points: [[10, 10], [24, 10]] },
      { id: 't7', type: 'trace', net: '3V3', layer: 'top', width: 0.5,
        points: [[24, 10], [24, 6], [58, 6], [58, 10]] },

      // ---- SIG：R1.2 -> R2.1 ----
      { id: 't2', type: 'trace', net: 'SIG', layer: 'top', width: 0.5,
        points: [[28, 10], [24, 26]] },

      // ---- GND：U1.GND -> v1（顶层），v1 -> R2.2（底层，借贯通焊盘/过孔换层） ----
      { id: 't3', type: 'trace', net: 'GND', layer: 'top', width: 0.5,
        points: [[14, 14], [14, 26]] },
      { id: 't4', type: 'trace', net: 'GND', layer: 'bottom', width: 0.6,
        points: [[14, 26], [14, 32], [28, 32], [28, 26]] },
      // GND 分支，与 SIG 的 t2 表面净空仅 0.10mm < 0.20mm -> 净空违规
      { id: 't14', type: 'trace', net: 'GND', layer: 'top', width: 0.5,
        points: [[14, 26], [24.75, 20.6]] },

      // ---- XNET：顶层 p8 到 (52,16)，底层 (46,16)->(58,16) 投影穿过同一位置，
      //      但没有任何过孔/插件焊盘跨越两层 -> 看上去相交，实际断开 ----
      { id: 't9', type: 'trace', net: 'XNET', layer: 'top', width: 0.5,
        points: [[62, 10], [66, 10], [66, 16], [52, 16]] },
      { id: 't10', type: 'trace', net: 'XNET', layer: 'bottom', width: 0.5,
        points: [[46, 16], [58, 16]] },

      // ---- LEDA / LEDB：两条走线在端点 (60,36) 接触 -> 短接 ----
      { id: 't11', type: 'trace', net: 'LEDA', layer: 'top', width: 0.5,
        points: [[58, 40], [60, 36]] },
      { id: 't12', type: 'trace', net: 'LEDB', layer: 'top', width: 0.5,
        points: [[62, 40], [60, 36]] },
    ],
  };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 完整性校验：不完整的设计不能检查；错误带 objectId，便于前端定位“无法检查的对象”。
function validateDesign(design) {
  const errors = [];
  const push = (code, message, objectId) => errors.push({ code, message, objectId: objectId || null });

  if (!design || typeof design !== 'object') {
    push('design.not-object', '设计根节点必须是对象');
    return { valid: false, errors };
  }
  if (design.unit !== 'mm') {
    push('design.unit', `仅支持单位 mm，收到 ${JSON.stringify(design.unit)}`);
  }
  const b = design.board;
  if (!b || !isFiniteNumber(b.width) || !isFiniteNumber(b.height) || b.width <= 0 || b.height <= 0) {
    push('board.size', '板宽/板高必须为正数 (mm)');
  }
  const cl = design.rules && design.rules.clearance;
  if (!isFiniteNumber(cl) || cl < 0) {
    push('rules.clearance', '净空规则必须是非负数 (mm)');
  }
  if (!Array.isArray(design.layers) || design.layers.length === 0 ||
      design.layers.some((l) => !LAYERS.includes(l))) {
    push('design.layers', `铜层必须取自 ${LAYERS.join('/')}`);
  }
  if (!Array.isArray(design.objects)) {
    push('objects.missing', 'objects 必须是数组');
    return { valid: false, errors };
  }

  const seenIds = new Set();
  design.objects.forEach((o, i) => {
    const where = o && o.id ? o.id : `#${i}`;
    if (!o || typeof o !== 'object') {
      push('object.not-object', '对象必须是对象', where);
      return;
    }
    if (typeof o.id !== 'string' || !o.id) {
      push('object.id', '对象缺少 id', where);
    } else if (seenIds.has(o.id)) {
      push('object.duplicate-id', `对象 id 重复: ${o.id}`, o.id);
    } else {
      seenIds.add(o.id);
    }
    if (o.net === undefined || o.net === null || String(o.net).trim() === '') {
      push('object.missing-net', '对象未分配网络，无法判定连接关系', where);
    }

    if (o.type === 'pad' || o.type === 'via') {
      if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) {
        push('object.coordinates', '坐标必须是有限数 (mm)', where);
      }
      if (!isFiniteNumber(o.r) || o.r <= 0) {
        push('object.radius', '半径必须是正数 (mm)', where);
      }
      if (o.type === 'via') {
        if (!isFiniteNumber(o.drill) || o.drill < 0) {
          push('via.drill', '钻孔直径必须是非负数 (mm)', where);
        }
      }
      if (o.type === 'pad') {
        if (typeof o.component !== 'string' || !o.component ||
            typeof o.pin !== 'string' || !o.pin) {
          push('pad.ref', '焊盘必须声明 component 与 pin', where);
        }
        if (!isFiniteNumber(o.holeRadius) || o.holeRadius < 0) {
          push('pad.hole', 'holeRadius 必须是非负数 (mm)', where);
        }
        if (o.shape === 'rect') {
          if (!isFiniteNumber(o.w) || o.w <= 0 || !isFiniteNumber(o.h) || o.h <= 0) {
            push('pad.rect', '矩形焊盘的宽高必须为正数 (mm)', where);
          }
        } else if (o.shape && o.shape !== 'circle') {
          push('pad.shape', `不支持的焊盘形状: ${o.shape}`, where);
        }
      }
      const layers = Array.isArray(o.layers) ? o.layers : [];
      if (layers.length === 0 || layers.some((l) => !LAYERS.includes(l))) {
        push('object.layers', '对象所在层无效', where);
      }
    } else if (o.type === 'trace') {
      if (!LAYERS.includes(o.layer)) {
        push('trace.layer', `走线层必须是 ${LAYERS.join('/')}`, where);
      }
      if (!isFiniteNumber(o.width) || o.width <= 0) {
        push('trace.width', '线宽必须是正数 (mm)', where);
      }
      if (!Array.isArray(o.points) || o.points.length < 2) {
        push('trace.points', '走线至少需要两个点', where);
      } else {
        o.points.forEach((pt) => {
          if (!Array.isArray(pt) || pt.length !== 2 ||
              !isFiniteNumber(pt[0]) || !isFiniteNumber(pt[1])) {
            push('trace.point', '走线点必须是 [x, y] 有限数 (mm)', where);
          }
        });
      }
    } else {
      push('object.type', `未知对象类型: ${JSON.stringify(o.type)}`, where);
    }
  });

  // 网表一致性：同一 (component, pin) 只能出现一次
  const pinKeys = new Map();
  design.objects.forEach((o) => {
    if (o.type === 'pad') {
      const key = `${o.component}@${o.pin}`;
      if (pinKeys.has(key)) {
        push('pad.duplicate-pin', `焊盘 ${key} 重复`, o.id);
      }
      pinKeys.set(key, o.id);
    }
  });

  return { valid: errors.length === 0, errors };
}

// 规范化序列化：键按字典序排序（数组保持顺序）。
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

function hashContent(design) {
  return crypto.createHash('sha256').update(canonicalJSON(design)).digest('hex');
}

function revisionIdFor(design) {
  return `rev_${hashContent(design).slice(0, 12)}`;
}

module.exports = {
  LAYERS,
  EPS,
  sampleDesign,
  validateDesign,
  canonicalJSON,
  hashContent,
  revisionIdFor,
};
