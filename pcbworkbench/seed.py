"""内置示例板：首次启动（数据库为空）时创建，打开页面即可直接操作。

坐标单位 mm，板子约 70x50。示例刻意包含：
- +5V   ：顶层走线经过孔换到底层，完整布通（演示跨层连通）。
- GND   ：两段走线没接上，未布通。
- SIG_A/SIG_B：顶层平行走线铜皮净距 0.05mm，小于 0.2mm 净空规则。
- SIG_C ：底层走线横穿 +5V 底层走线，铜皮重叠形成短接。
"""
from __future__ import annotations

SAMPLE_DESIGN = {
    "name": "示例板 Demo Board",
    "units": "mm",
    "rules": {"clearance_mm": 0.2},
    "objects": [
        # +5V：顶层 -> 过孔 -> 底层，完整布通
        {"id": "P1", "kind": "pad", "net": "+5V", "layer": "multi",
         "x": 10, "y": 10, "diameter": 1.6},
        {"id": "T1", "kind": "trace", "net": "+5V", "layer": "top",
         "path": [[10, 10], [30, 10]], "width": 0.5},
        {"id": "V1", "kind": "via", "net": "+5V",
         "x": 30, "y": 10, "diameter": 1.0},
        {"id": "T2", "kind": "trace", "net": "+5V", "layer": "bottom",
         "path": [[30, 10], [30, 25]], "width": 0.5},
        {"id": "P2", "kind": "pad", "net": "+5V", "layer": "multi",
         "x": 30, "y": 25, "diameter": 1.6},
        # GND：两段走线之间留有缺口，未布通
        {"id": "P3", "kind": "pad", "net": "GND", "layer": "multi",
         "x": 10, "y": 30, "diameter": 1.6},
        {"id": "T3", "kind": "trace", "net": "GND", "layer": "top",
         "path": [[10, 30], [20, 30]], "width": 0.4},
        {"id": "P4", "kind": "pad", "net": "GND", "layer": "multi",
         "x": 45, "y": 30, "diameter": 1.6},
        {"id": "T4", "kind": "trace", "net": "GND", "layer": "top",
         "path": [[45, 30], [35, 30]], "width": 0.4},
        # SIG_A / SIG_B：顶层平行段铜皮净距 0.05mm，违反 0.2mm 净空
        {"id": "P5", "kind": "pad", "net": "SIG_A", "layer": "multi",
         "x": 10, "y": 42, "diameter": 1.0},
        {"id": "T5", "kind": "trace", "net": "SIG_A", "layer": "top",
         "path": [[10, 42], [40, 42]], "width": 0.3},
        {"id": "P6", "kind": "pad", "net": "SIG_A", "layer": "multi",
         "x": 40, "y": 42, "diameter": 1.0},
        {"id": "P7", "kind": "pad", "net": "SIG_B", "layer": "multi",
         "x": 14, "y": 44, "diameter": 1.0},
        {"id": "T6", "kind": "trace", "net": "SIG_B", "layer": "top",
         "path": [[14, 44], [20, 42.35], [36, 42.35], [40, 44]], "width": 0.3},
        {"id": "P8", "kind": "pad", "net": "SIG_B", "layer": "multi",
         "x": 40, "y": 44, "diameter": 1.0},
        # SIG_C：底层走线横穿 +5V 底层走线，形成短接
        {"id": "P9", "kind": "pad", "net": "SIG_C", "layer": "multi",
         "x": 25, "y": 20, "diameter": 1.2},
        {"id": "T8", "kind": "trace", "net": "SIG_C", "layer": "bottom",
         "path": [[25, 20], [35, 20]], "width": 0.4},
    ],
}


def seed_if_empty(store) -> str | None:
    """数据库为空时写入示例板，返回设计 id。"""
    if store.has_designs():
        return None
    return store.create_design(SAMPLE_DESIGN, design_id="demo")
