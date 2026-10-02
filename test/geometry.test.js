'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EPS,
  closestSegSeg,
  primitiveDistance,
  pointInsidePrimitive,
} = require('../backend/geometry');

test('线段最近点：平行线段间隙', () => {
  const r = closestSegSeg(0, 0, 10, 0, 0, 3, 10, 3);
  assert.ok(Math.abs(r.dist - 3) < EPS);
});

test('线段最近点：交叉线段距离为 0', () => {
  const r = closestSegSeg(0, 0, 10, 10, 0, 10, 10, 0);
  assert.ok(r.dist < EPS);
});

test('线段最近点：端点到另一段中部的垂直距离', () => {
  const r = closestSegSeg(0, 0, 0, 0, -3, 5, 3, 5);
  assert.ok(Math.abs(r.dist - 5) < 1e-9);
});

test('带宽度胶囊：中心线相距 1、各自半宽 0.3 时表面间隙 0.4', () => {
  const A = { kind: 'seg', x1: 0, y1: 0, x2: 10, y2: 0, w: 0.6 };
  const B = { kind: 'seg', x1: 0, y1: 1, x2: 10, y2: 1, w: 0.6 };
  const d = primitiveDistance(A, B);
  assert.ok(Math.abs(d.distance - 0.4) < 1e-9, d.distance);
});

test('胶囊与圆：线端与焊盘边缘接触 -> 距离 0（计入连接的几何条件）', () => {
  // 走线半宽 0.25，线端中心 (9.1, 0)；焊盘圆心 (10,0)，半径 0.9：
  // 中心距离 0.9 = 0.25 + 0.65，表面恰好接触
  const S = { kind: 'seg', x1: 0, y1: 0, x2: 9.1, y2: 0, w: 0.5 };
  const C = { kind: 'circle', x: 10, y: 0, r: 0.65 };
  const d = primitiveDistance(S, C);
  assert.ok(d.distance <= EPS, `期望接触，实际 ${d.distance}`);
});

test('胶囊与圆：差 0.05mm 间隙时不接触', () => {
  const S = { kind: 'seg', x1: 0, y1: 0, x2: 9.1, y2: 0, w: 0.5 };
  const C = { kind: 'circle', x: 10, y: 0, r: 0.6 };
  const d = primitiveDistance(S, C);
  assert.ok(Math.abs(d.distance - 0.05) < 1e-9);
});

test('不同层投影相交不应在此判连通——几何层只回答表面距离：' +
     '两条垂直段在不同调用中距离为 0，但连接判定由 check 层按层隔离', () => {
  const A = { kind: 'seg', x1: 5, y1: 0, x2: 5, y2: 10, w: 0.4 };
  const B = { kind: 'seg', x1: 0, y1: 5, x2: 10, y2: 5, w: 0.4 };
  assert.ok(primitiveDistance(A, B).distance <= EPS);
});

test('圆与矩形表面距离', () => {
  const C = { kind: 'circle', x: 5, y: 10, r: 1 };
  const R = { kind: 'rect', x: 0, y: 0, w: 10, h: 5 };
  const d = primitiveDistance(C, R);
  assert.ok(Math.abs(d.distance - 4) < 1e-9);
});

test('矩形重叠时表面距离为 0', () => {
  const A = { kind: 'rect', x: 0, y: 0, w: 5, h: 5 };
  const B = { kind: 'rect', x: 3, y: 3, w: 5, h: 5 };
  assert.ok(primitiveDistance(A, B).distance <= EPS);
});

test('矩形角对角间隙', () => {
  // A 右上角 (3,4)，B 左下角 (6,7)：轴向间隙各 3，表面距 3√2
  const A = { kind: 'rect', x: 0, y: 0, w: 3, h: 4 };
  const B = { kind: 'rect', x: 6, y: 7, w: 3, h: 4 };
  const d = primitiveDistance(A, B);
  assert.ok(Math.abs(d.distance - Math.hypot(3, 3)) < 1e-9, d.distance);
});

test('点在胶囊内：端点圆盘区域', () => {
  const S = { kind: 'seg', x1: 0, y1: 0, x2: 10, y2: 0, w: 1 };
  assert.ok(pointInsidePrimitive(10, 0.4, S));
  assert.ok(!pointInsidePrimitive(10.6, 0, S));
});
