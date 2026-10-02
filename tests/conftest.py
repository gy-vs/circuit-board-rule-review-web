import pytest
from fastapi.testclient import TestClient

from pcbworkbench.app import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def make_design(objects, clearance=0.2, name="测试板"):
    return {
        "name": name,
        "units": "mm",
        "rules": {"clearance_mm": clearance},
        "objects": objects,
    }


def create_design(client, objects, clearance=0.2, name="测试板"):
    resp = client.post("/api/designs", json={
        "name": name,
        "data": make_design(objects, clearance, name),
    })
    assert resp.status_code == 201, resp.json()
    return resp.json()["id"]


def run_check(client, design_id, version=None):
    body = {} if version is None else {"version": version}
    resp = client.post(f"/api/designs/{design_id}/checks", json=body)
    assert resp.status_code == 201, resp.json()
    return resp.json()


def save_version(client, design_id, base_version, data):
    return client.put(f"/api/designs/{design_id}/versions",
                      json={"base_version": base_version, "data": data})
