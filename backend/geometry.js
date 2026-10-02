'use strict';

// ---------------------------------------------------------------------------
// geometry.js — 纯几何计算，单位全部为毫米 (mm)。
//
// 铜形状基元（Primitives）：
//   { kind: 'seg',   objectId, net, x1, y1, x2, y2, w }   // 走线中线段（带宽度的胶囊）
//   { kind: 'circle',objectId, net, x, y, r }              // 焊盘 / 过孔的圆
//   { kind: 'rect',  objectId, net, x, y, w, h }           // 矩形焊盘，轴对齐
//
// 本模块只关心“表面到表面”的最小距离 d：
//   d <= EPS  => 形状接触（同层时导通）
//   d >  EPS  => 间隙为 d
// 画布如何缩放与这里无关。
// ---------------------------------------------------------------------------

const EPS = 1e-6; // mm，小于该数值视为接触（浮点容差）

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 线段 a-b 的最近点参数 s ∈ [0,1]（点到无限长线的投影，夹紧到线段）
function pointSegParam(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
}

function segSegInfo(a) {
  // a = {x1,y1,x2,y2}（线段 1），其余参数为线段 2 的端点
  return [a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1];
}

// 两条线段之间的最小距离及最近点。采用 Ericson "Real-Time Collision
// Detection" 5.1.9 的鲁棒分段算法，退化情形（零长度线段）走夹紧投影。
function closestSegSeg(x1, y1, x2, y2, x3, y3, x4, y4) {
  const r1x = x2 - x1, r1y = y2 - y1;
  const r2x = x4 - x3, r2y = y4 - y3;
  const r3x = x1 - x3, r3y = y1 - y3;
  const a = r1x * r1x + r1y * r1y;
  const e = r2x * r2x + r2y * r2y;
  const f = r2x * r3x + r2y * r3y;

  let s, t;

  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const b = r1x * r2x + r1y * r2y;
    const c = r1x * r3x + r1y * r3y;
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const px = x1 + r1x * s, py = y1 + r1y * s;
  const qx = x3 + r2x * t, qy = y3 + r2y * t;
  const dx = qx - px, dy = qy - py;
  return { s, t, px, py, qx, qy, dist: Math.hypot(dx, dy) };
}

function pointDist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// ---------------------------------------------------------------------------
// 表面到表面距离（减去各自半径/半宽）。返回
//   { distance, p1: {x,y}, p2: {x,y} }   p1/p2 为两个形状表面上的最近点。
// 接触时 distance = 0。
// ---------------------------------------------------------------------------

function segSegSurface(A, B) {
  const rA = A.w / 2;
  const rB = B.w / 2;
  const c = closestSegSeg(A.x1, A.y1, A.x2, A.y2, B.x1, B.y1, B.x2, B.y2);
  const centerDist = c.dist || 0;
  const surface = Math.max(0, centerDist - rA - rB);
  let px = c.px, py = c.py, qx = c.qx, qy = c.qy;
  if (centerDist > EPS) {
    const ux = (c.qx - c.px) / centerDist;
    const uy = (c.qy - c.py) / centerDist;
    px = c.px + ux * rA; py = c.py + uy * rA;
    qx = c.qx - ux * rB; qy = c.qy - uy * rB;
  }
  return { distance: surface, p1: { x: px, y: py }, p2: { x: qx, y: qy } };
}

function segCircleSurface(S, C) {
  const rS = S.w / 2;
  const s = pointSegParam(C.x, C.y, S.x1, S.y1, S.x2, S.y2);
  const cx = S.x1 + (S.x2 - S.x1) * s;
  const cy = S.y1 + (S.y2 - S.y1) * s;
  const centerDist = pointDist(C.x, C.y, cx, cy);
  const surface = Math.max(0, centerDist - rS - C.r);
  let px = cx, py = cy, qx = C.x, qy = C.y;
  if (centerDist > EPS) {
    const ux = (C.x - cx) / centerDist;
    const uy = (C.y - cy) / centerDist;
    px = cx + ux * rS; py = cy + uy * rS;
    qx = C.x - ux * C.r; qy = C.y - uy * C.r;
  }
  return { distance: surface, p1: { x: px, y: py }, p2: { x: qx, y: qy } };
}

function segRectSurface(S, R) {
  // 先求点（胶囊圆心）到矩形的最近点，再考虑另一头是线段：
  // 把线段采样为两个端点+与矩形四条边的最近参数点，取最小值。
  // 精确做法：圆心轨迹到膨胀矩形 (rect 外扩 rS) 的最近点，
  // 等价于线段到矩形中心距离后减去 rS。枚举线段 vs 矩形四边/顶点。
  const rS = S.w / 2;
  const candidates = [];
  const rx1 = R.x, ry1 = R.y, rx2 = R.x + R.w, ry2 = R.y + R.h;
  const edges = [
    [rx1, ry1, rx2, ry1],
    [rx2, ry1, rx2, ry2],
    [rx2, ry2, rx1, ry2],
    [rx1, ry2, rx1, ry1],
  ];
  // 线段中线 与 矩形各边 的最近点
  for (const e of edges) {
    const c = closestSegSeg(S.x1, S.y1, S.x2, S.y2, e[0], e[1], e[2], e[3]);
    candidates.push({ centerDist: c.dist, px: c.px, py: c.py, qx: c.qx, qy: c.qy });
  }
  // 两端点到矩形内部的最近点（处理端点正对矩形面的情况）
  for (const [ex, ey] of [[S.x1, S.y1], [S.x2, S.y2]]) {
    const qx = clamp(ex, rx1, rx2);
    const qy = clamp(ey, ry1, ry2);
    const d = pointDist(ex, ey, qx, qy);
    candidates.push({ centerDist: d, px: ex, py: ey, qx, qy });
  }
  candidates.sort((u, v) => u.centerDist - v.centerDist);
  const best = candidates[0];
  const surface = Math.max(0, best.centerDist - rS);
  let px = best.px, py = best.py;
  if (best.centerDist > EPS) {
    const ux = (best.qx - best.px) / best.centerDist;
    const uy = (best.qy - best.py) / best.centerDist;
    px = best.px + ux * rS; py = best.py + uy * rS;
  }
  return { distance: surface, p1: { x: px, y: py }, p2: { x: best.qx, y: best.qy } };
}

function circleCircleSurface(A, B) {
  const centerDist = pointDist(A.x, A.y, B.x, B.y);
  const surface = Math.max(0, centerDist - A.r - B.r);
  let px = A.x, py = A.y, qx = B.x, qy = B.y;
  if (centerDist > EPS) {
    const ux = (B.x - A.x) / centerDist;
    const uy = (B.y - A.y) / centerDist;
    px = A.x + ux * A.r; py = A.y + uy * A.r;
    qx = B.x - ux * B.r; qy = B.y - uy * B.r;
  }
  return { distance: surface, p1: { x: px, y: py }, p2: { x: qx, y: qy } };
}

function circleRectSurface(C, R) {
  const qx = clamp(C.x, R.x, R.x + R.w);
  const qy = clamp(C.y, R.y, R.y + R.h);
  const centerDist = pointDist(C.x, C.y, qx, qy);
  const surface = Math.max(0, centerDist - C.r);
  let px = C.x, py = C.y;
  if (centerDist > EPS) {
    const ux = (qx - C.x) / centerDist;
    const uy = (qy - C.y) / centerDist;
    px = C.x + ux * C.r; py = C.y + uy * C.r;
  }
  return { distance: surface, p1: { x: px, y: py }, p2: { x: qx, y: qy } };
}

function rectRectSurface(A, B) {
  // 两个轴对齐矩形：分离轴上取最大重叠/间隙
  const ax1 = A.x, ax2 = A.x + A.w, ay1 = A.y, ay2 = A.y + A.h;
  const bx1 = B.x, bx2 = B.x + B.w, by1 = B.y, by2 = B.y + B.h;
  const dx = overlapGap(ax1, ax2, bx1, bx2);
  const dy = overlapGap(ay1, ay2, by1, by2);
  let distance = 0, p1, p2;
  if (dx < 0 && dy < 0) {
    // 相交，表面距离 0；找交界面上的点
    distance = 0;
    const cx = clamp((ax1 + ax2) / 2, bx1, bx2);
    const cy = clamp((ay1 + ay2) / 2, by1, by2);
    p1 = { x: cx, y: cy };
    p2 = { x: cx, y: cy };
  } else if (dx >= 0 && dy >= 0) {
    // 角对角
    distance = Math.hypot(dx, dy);
    p1 = { x: dx > 0 ? (ax1 < bx1 ? ax2 : ax1) : clamp((ax1 + ax2) / 2, bx1, bx2),
           y: dy > 0 ? (ay1 < by1 ? ay2 : ay1) : clamp((ay1 + ay2) / 2, by1, by2) };
    p2 = { x: dx > 0 ? (ax1 < bx1 ? bx1 : bx2) : p1.x,
           y: dy > 0 ? (ay1 < by1 ? by1 : by2) : p1.y };
  } else if (dx >= 0) {
    distance = dx;
    const cy = clamp((ay1 + ay2) / 2, by1, by2);
    p1 = { x: ax1 < bx1 ? ax2 : ax1, y: cy };
    p2 = { x: ax1 < bx1 ? bx1 : bx2, y: cy };
  } else {
    distance = dy;
    const cx = clamp((ax1 + ax2) / 2, bx1, bx2);
    p1 = { x: cx, y: ay1 < by1 ? ay2 : ay1 };
    p2 = { x: cx, y: ay1 < by1 ? by1 : by2 };
  }
  return { distance, p1, p2 };
}

// 返回两区间在轴上的“表面距离”：正值为间隙，负值为重叠量，0 为边缘贴合
function overlapGap(a1, a2, b1, b2) {
  if (a2 <= b1) return b1 - a2;
  if (b2 <= a1) return a1 - b2;
  return -(Math.min(a2, b2) - Math.max(a1, b1));
}

// 统一入口：两个基元的表面距离
function primitiveDistance(A, B) {
  if (A.kind === 'seg' && B.kind === 'seg') return segSegSurface(A, B);
  if (A.kind === 'circle' && B.kind === 'circle') return circleCircleSurface(A, B);
  if (A.kind === 'rect' && B.kind === 'rect') return rectRectSurface(A, B);
  if (A.kind === 'seg' && B.kind === 'circle') return segCircleSurface(A, B);
  if (B.kind === 'seg' && A.kind === 'circle') {
    const r = segCircleSurface(B, A);
    return { distance: r.distance, p1: r.p2, p2: r.p1 };
  }
  if (A.kind === 'seg' && B.kind === 'rect') return segRectSurface(A, B);
  if (B.kind === 'seg' && A.kind === 'rect') {
    const r = segRectSurface(B, A);
    return { distance: r.distance, p1: r.p2, p2: r.p1 };
  }
  if (A.kind === 'circle' && B.kind === 'rect') return circleRectSurface(A, B);
  if (B.kind === 'circle' && A.kind === 'rect') {
    const r = circleRectSurface(B, A);
    return { distance: r.distance, p1: r.p2, p2: r.p1 };
  }
  throw new Error(`未知基元类型: ${A.kind}/${B.kind}`);
}

// 点到带宽度线段（胶囊）的表面距离
function pointToSegmentSurface(px, py, S) {
  const s = pointSegParam(px, py, S.x1, S.y1, S.x2, S.y2);
  const cx = S.x1 + (S.x2 - S.x1) * s;
  const cy = S.y1 + (S.y2 - S.y1) * s;
  return { distance: Math.max(0, pointDist(px, py, cx, cy) - S.w / 2), s, cx, cy };
}

// 点是否在基元表面内（接触判定，用于“线端与焊盘边缘接触”类判断的测试）
function pointInsidePrimitive(px, py, P) {
  if (P.kind === 'circle') return pointDist(px, py, P.x, P.y) <= P.r + EPS;
  if (P.kind === 'rect') return px >= P.x - EPS && px <= P.x + P.w + EPS &&
    py >= P.y - EPS && py <= P.y + EPS;
  if (P.kind === 'seg') return pointToSegmentSurface(px, py, P).distance <= EPS;
  throw new Error(`未知基元类型: ${P.kind}`);
}

// 基元的轴对齐包围盒 {minX,minY,maxX,maxY}
function primitiveBBox(P) {
  if (P.kind === 'circle') {
    return { minX: P.x - P.r, minY: P.y - P.r, maxX: P.x + P.r, maxY: P.y + P.r };
  }
  if (P.kind === 'rect') {
    return { minX: P.x, minY: P.y, maxX: P.x + P.w, maxY: P.y + P.h };
  }
  // 胶囊：两端圆 + 矩形
  const r = P.w / 2;
  const minX = Math.min(P.x1, P.x2) - r;
  const maxX = Math.max(P.x1, P.x2) + r;
  const minY = Math.min(P.y1, P.y2) - r;
  const maxY = Math.max(P.y1, P.y2) + r;
  return { minX, minY, maxX, maxY };
}

module.exports = {
  EPS,
  clamp,
  closestSegSeg,
  primitiveDistance,
  pointToSegmentSurface,
  pointInsidePrimitive,
  primitiveBBox,
};
