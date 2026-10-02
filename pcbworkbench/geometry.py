"""二维几何内核。所有坐标与尺寸单位均为毫米（mm）。

形状只有两种：
- Disk    ：圆盘（焊盘、过孔的铜）
- Capsule ：胶囊（一段走线 = 线段 + 线宽半径）

所有距离都是"铜皮到铜皮"的净距离（已扣除半径），
返回值 <= 0 表示两形状接触或重叠。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

EPS = 1e-9
# 连通判定容差（mm）：净距离不超过该值即视为"接触导通"。
# 对应"线端与焊盘边缘接触需要计入连接"。
CONNECT_EPS = 1e-6


@dataclass(frozen=True)
class Disk:
    x: float
    y: float
    r: float


@dataclass(frozen=True)
class Capsule:
    ax: float
    ay: float
    bx: float
    by: float
    r: float


def point_seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def _orient(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _on_segment(ax: float, ay: float, bx: float, by: float, px: float, py: float) -> bool:
    return (
        min(ax, bx) - EPS <= px <= max(ax, bx) + EPS
        and min(ay, by) - EPS <= py <= max(ay, by) + EPS
    )


def segments_intersect(a, b, c, d) -> bool:
    """线段相交判定，共线接触也算相交。"""
    ax, ay = a
    bx, by = b
    cx, cy = c
    dx, dy = d
    o1 = _orient(ax, ay, bx, by, cx, cy)
    o2 = _orient(ax, ay, bx, by, dx, dy)
    o3 = _orient(cx, cy, dx, dy, ax, ay)
    o4 = _orient(cx, cy, dx, dy, bx, by)
    if ((o1 > EPS and o2 < -EPS) or (o1 < -EPS and o2 > EPS)) and (
        (o3 > EPS and o4 < -EPS) or (o3 < -EPS and o4 > EPS)
    ):
        return True
    if abs(o1) <= EPS and _on_segment(ax, ay, bx, by, cx, cy):
        return True
    if abs(o2) <= EPS and _on_segment(ax, ay, bx, by, dx, dy):
        return True
    if abs(o3) <= EPS and _on_segment(cx, cy, dx, dy, ax, ay):
        return True
    if abs(o4) <= EPS and _on_segment(cx, cy, dx, dy, bx, by):
        return True
    return False


def seg_seg_dist(a, b, c, d) -> float:
    if segments_intersect(a, b, c, d):
        return 0.0
    return min(
        point_seg_dist(a[0], a[1], c[0], c[1], d[0], d[1]),
        point_seg_dist(b[0], b[1], c[0], c[1], d[0], d[1]),
        point_seg_dist(c[0], c[1], a[0], a[1], b[0], b[1]),
        point_seg_dist(d[0], d[1], a[0], a[1], b[0], b[1]),
    )


def shape_distance(s1, s2) -> float:
    """两个形状铜皮之间的净距离（mm），<=0 表示接触/重叠。"""
    if isinstance(s1, Disk) and isinstance(s2, Disk):
        return math.hypot(s1.x - s2.x, s1.y - s2.y) - s1.r - s2.r
    if isinstance(s1, Disk) and isinstance(s2, Capsule):
        return point_seg_dist(s1.x, s1.y, s2.ax, s2.ay, s2.bx, s2.by) - s1.r - s2.r
    if isinstance(s1, Capsule) and isinstance(s2, Disk):
        return shape_distance(s2, s1)
    # Capsule-Capsule
    return (
        seg_seg_dist(
            (s1.ax, s1.ay), (s1.bx, s1.by), (s2.ax, s2.ay), (s2.bx, s2.by)
        )
        - s1.r
        - s2.r
    )
