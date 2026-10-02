"""端到端 API 测试：保存 → 检查 → 重新打开的完整路径。

覆盖：层间连通（过孔）、同层接触连通、网络归属、净空/短接结论、
版本冲突、不完整设计拒绝、历史结果与版本绑定、局部修改不影响其他网络。
"""
from conftest import create_design, make_design, run_check, save_version


# ---------------------------------------------------------------- 示例板

def test_seed_design_available_and_checkable(client):
    resp = client.get("/api/designs")
    assert resp.status_code == 200
    designs = resp.json()["designs"]
    assert len(designs) == 1
    did = designs[0]["id"]

    design = client.get(f"/api/designs/{did}").json()
    assert design["latest_version"] == 1
    assert len(design["design"]["objects"]) > 0
    assert design["design"]["units"] == "mm"

    result = run_check(client, did)
    assert result["version"] == 1
    summary = result["summary"]
    # 示例板刻意包含：GND 未布通、SIG_A/SIG_B 净空违规、+5V/SIG_C 短接
    assert summary == {"short": 1, "clearance": 1, "unrouted": 1}

    unrouted = [f for f in result["findings"] if f["type"] == "unrouted"]
    assert unrouted[0]["net"] == "GND"
    assert len(unrouted[0]["islands"]) == 2

    clr = [f for f in result["findings"] if f["type"] == "clearance"][0]
    assert clr["objects"] == ["T5", "T6"]
    assert clr["layer"] == "top"
    assert abs(clr["distance_mm"] - 0.05) < 1e-6
    assert clr["rule"] == "clearance_mm"
    assert clr["limit_mm"] == 0.2

    short = [f for f in result["findings"] if f["type"] == "short"][0]
    assert short["objects"] == ["T2", "T8"]
    assert short["layer"] == "bottom"
    assert short["distance_mm"] == 0.0

    # +5V 经过孔跨层完整布通：全部对象同属一个铜岛
    assert result["nets"]["+5V"]["routed"] is True
    assert result["nets"]["+5V"]["islands"] == [["P1", "P2", "T1", "T2", "V1"]]
    assert result["nets"]["GND"]["routed"] is False


# ---------------------------------------------------------------- 层间连通

def test_cross_layer_projection_without_via_is_not_connected(client):
    """两段线在不同铜层投影相交，没有过孔就不导通。"""
    objects = [
        {"id": "P1", "kind": "pad", "net": "N", "layer": "top",
         "x": 0, "y": 0, "diameter": 2.0},
        {"id": "T1", "kind": "trace", "net": "N", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.5},
        # T2 在底层与 T1 投影十字相交，但没有过孔
        {"id": "T2", "kind": "trace", "net": "N", "layer": "bottom",
         "path": [[5, -5], [5, 5]], "width": 0.5},
        {"id": "P2", "kind": "pad", "net": "N", "layer": "bottom",
         "x": 5, "y": 5, "diameter": 2.0},
    ]
    did = create_design(client, objects)
    result = run_check(client, did)
    assert result["nets"]["N"]["routed"] is False
    assert len(result["nets"]["N"]["islands"]) == 2
    unrouted = [f for f in result["findings"] if f["type"] == "unrouted"]
    assert len(unrouted) == 1 and unrouted[0]["net"] == "N"

    # 加上过孔后（保存为新版本再检查）应布通
    design = client.get(f"/api/designs/{did}").json()["design"]
    design["objects"].append(
        {"id": "V1", "kind": "via", "net": "N", "x": 5, "y": 0, "diameter": 1.0})
    resp = save_version(client, did, 1, design)
    assert resp.status_code == 201
    result2 = run_check(client, did)
    assert result2["version"] == 2
    assert result2["nets"]["N"]["routed"] is True
    assert result2["nets"]["N"]["islands"] == [["P1", "P2", "T1", "T2", "V1"]]
    assert not [f for f in result2["findings"] if f["type"] == "unrouted"]


def test_same_layer_endpoint_touch_counts_as_connected(client):
    """同层线端与焊盘边缘接触需要计入连接。"""
    objects = [
        {"id": "P1", "kind": "pad", "net": "N", "layer": "top",
         "x": 0, "y": 0, "diameter": 2.0},
        # 线端 (1,0) 恰好落在半径 1.0 的焊盘边缘上
        {"id": "T1", "kind": "trace", "net": "N", "layer": "top",
         "path": [[1.0, 0], [5, 0]], "width": 0.4},
        {"id": "P2", "kind": "pad", "net": "N", "layer": "top",
         "x": 5, "y": 0, "diameter": 2.0},
    ]
    did = create_design(client, objects)
    result = run_check(client, did)
    assert result["nets"]["N"]["routed"] is True
    assert result["nets"]["N"]["islands"] == [["P1", "P2", "T1"]]
    assert result["findings"] == []


def test_net_name_alone_does_not_connect(client):
    """网络名相同但几何上分离的铜皮不视为连通。"""
    objects = [
        {"id": "P1", "kind": "pad", "net": "N", "layer": "top",
         "x": 0, "y": 0, "diameter": 1.5},
        {"id": "P2", "kind": "pad", "net": "N", "layer": "top",
         "x": 10, "y": 0, "diameter": 1.5},
    ]
    did = create_design(client, objects)
    result = run_check(client, did)
    assert result["nets"]["N"]["routed"] is False
    assert len(result["nets"]["N"]["islands"]) == 2


# ---------------------------------------------------------------- 净空与短接

def test_clearance_reports_exact_pair_layer_and_distance(client):
    objects = [
        {"id": "TA", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.3},
        {"id": "TB", "kind": "trace", "net": "B", "layer": "top",
         "path": [[0, 0.4], [10, 0.4]], "width": 0.3},
    ]
    did = create_design(client, objects, clearance=0.2)
    result = run_check(client, did)
    assert len(result["findings"]) == 1
    f = result["findings"][0]
    assert f["type"] == "clearance"
    assert f["objects"] == ["TA", "TB"]       # 指出具体两处对象
    assert f["layer"] == "top"                # 以及所在铜层
    assert abs(f["distance_mm"] - 0.1) < 1e-6  # 实测净距 0.1mm
    assert f["nets"] == ["A", "B"]

    # 拉开到净距 0.3mm 后违规消失
    design = client.get(f"/api/designs/{did}").json()["design"]
    design["objects"][1]["path"] = [[0, 0.6], [10, 0.6]]
    assert save_version(client, did, 1, design).status_code == 201
    result2 = run_check(client, did)
    assert result2["findings"] == []


def test_clearance_only_applies_on_shared_layer(client):
    """不同层的铜皮即使投影重叠也不产生净空违规（属于不同网络时）。"""
    objects = [
        {"id": "TA", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.5},
        {"id": "TB", "kind": "trace", "net": "B", "layer": "bottom",
         "path": [[5, -5], [5, 5]], "width": 0.5},
    ]
    did = create_design(client, objects)
    result = run_check(client, did)
    assert result["findings"] == []


def test_overlapping_copper_is_short_not_clearance(client):
    objects = [
        {"id": "TA", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.4},
        {"id": "TB", "kind": "trace", "net": "B", "layer": "top",
         "path": [[5, -1], [5, 1]], "width": 0.4},
    ]
    did = create_design(client, objects)
    result = run_check(client, did)
    assert len(result["findings"]) == 1
    f = result["findings"][0]
    assert f["type"] == "short"
    assert f["distance_mm"] == 0.0
    assert f["layer"] == "top"
    assert f["objects"] == ["TA", "TB"]


def test_clearance_rule_change_takes_effect(client):
    objects = [
        {"id": "TA", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.3},
        {"id": "TB", "kind": "trace", "net": "B", "layer": "top",
         "path": [[0, 0.4], [10, 0.4]], "width": 0.3},
    ]
    did = create_design(client, objects, clearance=0.05)
    assert run_check(client, did)["findings"] == []
    # 收紧净空规则到 0.2mm 后，净距 0.1mm 变成违规
    design = client.get(f"/api/designs/{did}").json()["design"]
    design["rules"]["clearance_mm"] = 0.2
    assert save_version(client, did, 1, design).status_code == 201
    result = run_check(client, did)
    assert [f["type"] for f in result["findings"]] == ["clearance"]


# ---------------------------------------------------------------- 版本与持久化

def test_version_conflict_detected(client):
    did = create_design(client, [])
    design = client.get(f"/api/designs/{did}").json()["design"]

    design["rules"]["clearance_mm"] = 0.3
    resp = save_version(client, did, 1, design)
    assert resp.status_code == 201 and resp.json()["version"] == 2

    # 模拟另一个窗口仍基于 v1 保存 → 409，不能无提示覆盖
    design["rules"]["clearance_mm"] = 0.5
    resp = save_version(client, did, 1, design)
    assert resp.status_code == 409
    assert resp.json()["latest_version"] == 2

    # 基于最新版本保存则成功
    resp = save_version(client, did, 2, design)
    assert resp.status_code == 201 and resp.json()["version"] == 3


def test_reopen_returns_saved_version(client):
    objects = [
        {"id": "T1", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.3},
    ]
    did = create_design(client, objects)
    design = client.get(f"/api/designs/{did}").json()["design"]
    design["objects"][0]["path"] = [[1, 1], [11, 1]]
    assert save_version(client, did, 1, design).status_code == 201

    # 重新打开：最新版本是修改后的 v2，v1 快照保持原样
    reopened = client.get(f"/api/designs/{did}").json()
    assert reopened["latest_version"] == 2
    assert reopened["design"]["objects"][0]["path"] == [[1, 1], [11, 1]]
    v1 = client.get(f"/api/designs/{did}/versions/1").json()["data"]
    assert v1["objects"][0]["path"] == [[0, 0], [10, 0]]


def test_incomplete_design_rejected_and_not_saved(client):
    did = create_design(client, [])
    bad = make_design([
        {"id": "T1", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0]], "width": 0.3},                    # 只有 1 个点
        {"id": "T2", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [5, 0]], "width": 0},              # 线宽为 0
        {"id": "P1", "kind": "pad", "net": "A", "layer": "top",
         "x": 0, "y": 0},                                    # 缺直径
        {"id": "V1", "kind": "via", "x": 1, "y": 1,
         "diameter": 0.8},                                   # 缺网络归属
    ])
    resp = save_version(client, did, 1, bad)
    assert resp.status_code == 422
    errors = resp.json()["errors"]
    bad_ids = {e["object"] for e in errors}
    assert {"T1", "T2", "P1", "V1"} <= bad_ids
    # 设计未被保存，仍是 v1
    assert client.get(f"/api/designs/{did}").json()["latest_version"] == 1


def test_untouched_nets_keep_identity_and_conclusions(client):
    """修改局部走线后，未涉及网络的检查结论与对象身份不变。"""
    did = client.get("/api/designs").json()["designs"][0]["id"]
    r1 = run_check(client, did)

    # 只修改 GND 的 T3（把它延长），其他不动
    design = client.get(f"/api/designs/{did}").json()["design"]
    t3 = next(o for o in design["objects"] if o["id"] == "T3")
    t3["path"] = [[10, 30], [22, 30]]
    assert save_version(client, did, 1, design).status_code == 201
    r2 = run_check(client, did)

    def pair_findings(result):
        return {f["id"]: f for f in result["findings"] if f["type"] != "unrouted"}

    f1, f2 = pair_findings(r1), pair_findings(r2)
    # SIG_A/SIG_B 净空与 +5V/SIG_C 短接的结论逐项一致
    assert set(f1) == set(f2)
    for fid in f1:
        assert f1[fid]["objects"] == f2[fid]["objects"]
        assert f1[fid]["layer"] == f2[fid]["layer"]
        assert f1[fid]["distance_mm"] == f2[fid]["distance_mm"]
    # 未涉及网络的对象身份与铜岛划分不变
    for net in ("+5V", "SIG_A", "SIG_B", "SIG_C"):
        assert r1["nets"][net] == r2["nets"][net]
    # GND 仍未布通（缺口还在）
    assert r2["nets"]["GND"]["routed"] is False


def test_results_bound_to_their_version(client):
    """旧版检查结果继续可查，且始终指向旧版快照中的对象。"""
    did = client.get("/api/designs").json()["designs"][0]["id"]
    c1 = run_check(client, did)
    assert any(f["type"] == "short" for f in c1["findings"])

    # 把 SIG_C 的 T8 移走消除短接，保存 v2 并重新检查
    design = client.get(f"/api/designs/{did}").json()["design"]
    t8 = next(o for o in design["objects"] if o["id"] == "T8")
    t8["path"] = [[25, 27], [35, 27]]
    assert save_version(client, did, 1, design).status_code == 201
    c2 = run_check(client, did)
    assert not any(f["type"] == "short" for f in c2["findings"])

    # 历史里两份结果各归各的版本
    checks = client.get(f"/api/designs/{did}/checks").json()["checks"]
    by_id = {c["id"]: c for c in checks}
    assert by_id[c1["id"]]["version"] == 1
    assert by_id[c2["id"]]["version"] == 2

    # 旧结果原样保留：仍报告 T2/T8 短接，对象定位基于 v1 快照坐标
    old = client.get(f"/api/designs/{did}/checks/{c1['id']}").json()
    short = [f for f in old["findings"] if f["type"] == "short"]
    assert len(short) == 1 and short[0]["objects"] == ["T2", "T8"]
    v1 = client.get(f"/api/designs/{did}/versions/1").json()["data"]
    v1_t8 = next(o for o in v1["objects"] if o["id"] == "T8")
    assert v1_t8["path"] == [[25, 20], [35, 20]]

    # 显式对旧版本重跑检查，结论与当时一致
    recheck = run_check(client, did, version=1)
    assert recheck["version"] == 1
    assert [f["id"] for f in recheck["findings"]] == [f["id"] for f in c1["findings"]]


def test_zoom_independent_geometry(client):
    """服务端只接收 mm 坐标，画布缩放这类视图参数不影响结论（无缩放参数可传）。"""
    objects = [
        {"id": "TA", "kind": "trace", "net": "A", "layer": "top",
         "path": [[0, 0], [10, 0]], "width": 0.3},
        {"id": "TB", "kind": "trace", "net": "B", "layer": "top",
         "path": [[0, 0.4], [10, 0.4]], "width": 0.3},
    ]
    did = create_design(client, objects)
    r1 = run_check(client, did)
    r2 = run_check(client, did)  # 重复计算结论确定一致
    assert r1["findings"] == r2["findings"]
