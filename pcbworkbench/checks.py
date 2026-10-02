"""设计校验、多铜层连通性分析与规则检查（DRC）。

核心语义：
- 连通只认几何接触，网络名相同不意味着导通。
- 过孔贯穿全部铜层；multi 焊盘在顶层和底层都有铜；普通焊盘/走线只属于一层。
- 同层铜皮净距离 <= CONNECT_EPS 视为接触导通；跨层投影相交但不放过孔不导通。
- 不同网络：净距离 <= CONNECT_EPS 判为短接（short）；
  CONNECT_EPS < 净距离 < clearance_mm 判为净空违规（clearance）。
- 同一网络的焊盘分布在多个互不相连的铜岛中，判为未布通（unrouted）。
"""
from __future__ import annotations

from .geometry import CONNECT_EPS, Capsule, Disk, shape_distance

LAYERS = ("top", "bottom")
PAD_LAYERS = ("top", "bottom", "multi")
OBJECT_KINDS = ("trace", "pad", "via")


# ---------------------------------------------------------------- 校验

def validate_design(data) -> list[dict]:
    """返回错误列表 [{object, message}]；空列表表示设计完整可检查。"""
    errors = []

    def err(obj_id, msg):
        errors.append({"object": obj_id, "message": msg})

    if not isinstance(data, dict):
        return [{"object": None, "message": "设计数据必须是对象"}]
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        err(None, "设计名称不能为空")
    rules = data.get("rules")
    if not isinstance(rules, dict) or not _is_nonneg_number(rules.get("clearance_mm")):
        err(None, "rules.clearance_mm 必须是非负数值（mm）")
    objects = data.get("objects")
    if not isinstance(objects, list):
        err(None, "objects 必须是数组")
        return errors

    seen = set()
    for obj in objects:
        if not isinstance(obj, dict):
            err(None, "对象必须是 JSON 对象")
            continue
        oid = obj.get("id")
        if not isinstance(oid, str) or not oid:
            err(None, "对象缺少 id")
            continue
        if oid in seen:
            err(oid, f"对象 id 重复: {oid}")
        seen.add(oid)

        kind = obj.get("kind")
        if kind not in OBJECT_KINDS:
            err(oid, f"未知对象类型: {kind!r}（应为 trace/pad/via）")
            continue
        net = obj.get("net")
        if not isinstance(net, str) or not net:
            err(oid, f"{oid}: 缺少网络归属（net）")

        if kind == "trace":
            if obj.get("layer") not in LAYERS:
                err(oid, f"{oid}: 走线层必须是 top 或 bottom")
            path = obj.get("path")
            if (
                not isinstance(path, list)
                or len(path) < 2
                or not all(_is_point(p) for p in path)
            ):
                err(oid, f"{oid}: 走线需要至少 2 个 [x, y] 坐标点")
            if not _is_pos_number(obj.get("width")):
                err(oid, f"{oid}: 走线宽度 width 必须是正数（mm）")
        elif kind == "pad":
            if obj.get("layer") not in PAD_LAYERS:
                err(oid, f"{oid}: 焊盘层必须是 top/bottom/multi")
            if not (_is_number(obj.get("x")) and _is_number(obj.get("y"))):
                err(oid, f"{oid}: 焊盘需要数值坐标 x/y（mm）")
            if not _is_pos_number(obj.get("diameter")):
                err(oid, f"{oid}: 焊盘直径 diameter 必须是正数（mm）")
        elif kind == "via":
            if not (_is_number(obj.get("x")) and _is_number(obj.get("y"))):
                err(oid, f"{oid}: 过孔需要数值坐标 x/y（mm）")
            if not _is_pos_number(obj.get("diameter")):
                err(oid, f"{oid}: 过孔直径 diameter 必须是正数（mm）")
    return errors


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_pos_number(v):
    return _is_number(v) and v > 0


def _is_nonneg_number(v):
    return _is_number(v) and v >= 0


def _is_point(p):
    return (
        isinstance(p, list)
        and len(p) == 2
        and _is_number(p[0])
        and _is_number(p[1])
    )


# ---------------------------------------------------------------- 层与形状

def object_shapes(obj) -> dict:
    """对象 -> {层名: [形状]}。过孔与 multi 焊盘同时出现在两层。"""
    kind = obj["kind"]
    if kind == "trace":
        r = obj["width"] / 2.0
        pts = obj["path"]
        caps = [
            Capsule(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r)
            for i in range(len(pts) - 1)
        ]
        return {obj["layer"]: caps}
    if kind == "pad":
        disk = Disk(obj["x"], obj["y"], obj["diameter"] / 2.0)
        layers = LAYERS if obj["layer"] == "multi" else (obj["layer"],)
        return {layer: [disk] for layer in layers}
    if kind == "via":
        disk = Disk(obj["x"], obj["y"], obj["diameter"] / 2.0)
        return {layer: [disk] for layer in LAYERS}
    raise ValueError(f"unknown kind: {kind}")


def pair_layer_distances(obj1, obj2) -> dict:
    """两个对象在每个共同铜层上的最小净距离：{层名: mm}。"""
    shapes1 = object_shapes(obj1)
    shapes2 = object_shapes(obj2)
    out = {}
    for layer in LAYERS:
        if layer in shapes1 and layer in shapes2:
            out[layer] = min(
                shape_distance(a, b)
                for a in shapes1[layer]
                for b in shapes2[layer]
            )
    return out


# ---------------------------------------------------------------- 连通性

class _UnionFind:
    def __init__(self, ids):
        self.parent = {i: i for i in ids}

    def find(self, x):
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def build_nets(objects) -> dict:
    """按网络分组做几何连通分析。

    返回 {net: {"islands": [[对象id...]], "pads": [焊盘id...], "routed": bool}}
    铜岛只由几何接触合并而成，与网络名无关（网络名只是分组依据）。
    """
    by_net: dict[str, list] = {}
    for obj in objects:
        by_net.setdefault(obj["net"], []).append(obj)

    nets = {}
    for net, objs in by_net.items():
        uf = _UnionFind(o["id"] for o in objs)
        for i in range(len(objs)):
            for j in range(i + 1, len(objs)):
                dists = pair_layer_distances(objs[i], objs[j])
                if any(d <= CONNECT_EPS for d in dists.values()):
                    uf.union(objs[i]["id"], objs[j]["id"])
        groups: dict[str, list] = {}
        for o in objs:
            groups.setdefault(uf.find(o["id"]), []).append(o["id"])
        islands = sorted((sorted(ids) for ids in groups.values()), key=lambda g: (len(g), g))
        islands.sort(key=lambda g: (-len(g), g))
        pads = sorted(o["id"] for o in objs if o["kind"] == "pad")
        pad_set = set(pads)
        pad_islands = [isl for isl in islands if pad_set & set(isl)]
        nets[net] = {
            "islands": islands,
            "pads": pads,
            "routed": len(pad_islands) <= 1,
        }
    return nets


# ---------------------------------------------------------------- 规则检查

def run_checks(design) -> dict:
    """对一份完整设计运行检查，返回可解释的结果。"""
    objects = design["objects"]
    clearance = design["rules"]["clearance_mm"]
    nets = build_nets(objects)
    findings: list[dict] = []

    # 1) 未布通网络：同一网络的焊盘落在多个铜岛
    for net in sorted(nets):
        info = nets[net]
        pad_set = set(info["pads"])
        pad_islands = [isl for isl in info["islands"] if pad_set & set(isl)]
        if len(pad_islands) > 1:
            flat = sorted(pid for isl in pad_islands for pid in isl)
            findings.append(
                {
                    "id": f"unrouted:{net}",
                    "type": "unrouted",
                    "net": net,
                    "layer": None,
                    "objects": flat,
                    "nets": [net],
                    "islands": pad_islands,
                    "pads": [p for p in info["pads"]],
                    "rule": "connectivity",
                    "detail": (
                        f"网络 {net} 的 {len(info['pads'])} 个焊盘分布在 "
                        f"{len(pad_islands)} 个互不相连的铜岛中，尚未布通"
                    ),
                }
            )

    # 2) 不同网络之间的净空违规与短接（逐层判定）
    by_id = {o["id"]: o for o in objects}
    ids = sorted(by_id)
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            o1, o2 = by_id[ids[i]], by_id[ids[j]]
            if o1["net"] == o2["net"]:
                continue
            for layer, dist in pair_layer_distances(o1, o2).items():
                if dist < clearance - 1e-9:
                    ftype = "short" if dist <= CONNECT_EPS else "clearance"
                    measured = round(max(dist, 0.0), 6)
                    if ftype == "short":
                        detail = (
                            f"{o1['net']} 的 {o1['id']} 与 {o2['net']} 的 {o2['id']} "
                            f"在 {layer} 层铜皮接触/重叠（净距离 {measured} mm），形成短接"
                        )
                    else:
                        detail = (
                            f"{o1['net']} 的 {o1['id']} 与 {o2['net']} 的 {o2['id']} "
                            f"在 {layer} 层净距离 {measured} mm，"
                            f"小于净空规则 {clearance} mm"
                        )
                    findings.append(
                        {
                            "id": f"{ftype}:{layer}:{o1['id']}:{o2['id']}",
                            "type": ftype,
                            "net": None,
                            "layer": layer,
                            "objects": [o1["id"], o2["id"]],
                            "nets": sorted({o1["net"], o2["net"]}),
                            "distance_mm": measured,
                            "rule": "clearance_mm",
                            "limit_mm": clearance,
                            "detail": detail,
                        }
                    )

    findings.sort(key=lambda f: ({"short": 0, "clearance": 1, "unrouted": 2}[f["type"]], f["id"]))
    return {
        "units": "mm",
        "rules": dict(design["rules"]),
        "nets": nets,
        "findings": findings,
        "summary": {
            "short": sum(1 for f in findings if f["type"] == "short"),
            "clearance": sum(1 for f in findings if f["type"] == "clearance"),
            "unrouted": sum(1 for f in findings if f["type"] == "unrouted"),
        },
    }
