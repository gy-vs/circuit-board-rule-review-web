"""几何内核单元测试：距离与接触判定（单位 mm）。"""
import math

from pcbworkbench.geometry import (
    CONNECT_EPS,
    Capsule,
    Disk,
    point_seg_dist,
    seg_seg_dist,
    shape_distance,
)


def test_point_seg_dist_basic():
    assert point_seg_dist(0, 1, -1, 0, 1, 0) == 1.0
    assert point_seg_dist(5, 0, 0, 0, 1, 0) == 4.0  # 端点之外


def test_seg_seg_dist_parallel():
    d = seg_seg_dist((0, 0), (10, 0), (0, 0.4), (10, 0.4))
    assert math.isclose(d, 0.4, abs_tol=1e-9)


def test_seg_seg_dist_intersecting_is_zero():
    assert seg_seg_dist((0, 0), (10, 0), (5, -1), (5, 1)) == 0.0


def test_seg_seg_dist_endpoint_touch_is_zero():
    assert seg_seg_dist((0, 0), (1, 0), (1, 0), (2, 1)) == 0.0


def test_capsule_capsule_net_distance():
    # 两条 0.3mm 宽的平行线，中心距 0.4 → 铜皮净距 0.1
    a = Capsule(0, 0, 10, 0, 0.15)
    b = Capsule(0, 0.4, 10, 0.4, 0.15)
    assert math.isclose(shape_distance(a, b), 0.1, abs_tol=1e-9)


def test_disk_disk_net_distance():
    a = Disk(0, 0, 1.0)
    b = Disk(3.0, 0, 0.5)
    assert math.isclose(shape_distance(a, b), 1.5, abs_tol=1e-9)


def test_trace_endpoint_on_pad_edge_is_contact():
    # 线端恰好落在焊盘边缘：净距离为 0，应计入连接
    pad = Disk(0, 0, 1.0)
    seg = Capsule(1.0, 0, 5, 0, 0.2)
    d = shape_distance(pad, seg)
    assert d <= CONNECT_EPS


def test_capsule_disk_separated():
    pad = Disk(0, 0, 0.5)
    seg = Capsule(2.0, 0, 5, 0, 0.25)
    assert math.isclose(shape_distance(pad, seg), 1.25, abs_tol=1e-9)
