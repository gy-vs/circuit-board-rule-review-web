"""FastAPI 接口：设计版本管理 + 规则检查 + 静态页面。

接口一览：
  GET    /api/designs                          设计列表
  POST   /api/designs                          新建设计（body: {name, data?}）
  GET    /api/designs/{did}                    最新版本完整设计
  GET    /api/designs/{did}/versions/{v}       指定版本快照
  PUT    /api/designs/{did}/versions           保存新版本（body: {base_version, data}）
  POST   /api/designs/{did}/checks             对某版本运行检查（body: {version?}）
  GET    /api/designs/{did}/checks             检查历史列表
  GET    /api/designs/{did}/checks/{cid}       某次检查完整结果
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .checks import run_checks, validate_design
from .seed import seed_if_empty
from .store import ConflictError, NotFoundError, Store

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def _error(status: int, detail: str, **extra) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail, **extra})


def create_app(db_path: str = "pcbworkbench.db") -> FastAPI:
    store = Store(db_path)
    seed_if_empty(store)
    app = FastAPI(title="PCB 走线审阅工作台")

    @app.exception_handler(NotFoundError)
    async def not_found(_req: Request, exc: NotFoundError):
        return _error(404, f"未找到: {exc}")

    # ------------------------------------------------------------ 设计

    @app.get("/api/designs")
    def list_designs():
        return {"designs": store.list_designs()}

    @app.post("/api/designs", status_code=201)
    def create_design(body: dict):
        name = body.get("name")
        data = body.get("data")
        if data is None:
            if not isinstance(name, str) or not name.strip():
                return _error(422, "缺少设计名称", errors=[{"object": None, "message": "name 不能为空"}])
            data = {"name": name.strip(), "units": "mm",
                    "rules": {"clearance_mm": 0.2}, "objects": []}
        errors = validate_design(data)
        if errors:
            return _error(422, "设计不完整，无法保存", errors=errors)
        did = store.create_design(data)
        return {"id": did, "version": 1}

    @app.get("/api/designs/{did}")
    def get_design(did: str):
        return store.get_design(did)

    @app.get("/api/designs/{did}/versions/{version}")
    def get_version(did: str, version: int):
        return {"design_id": did, "version": version,
                "data": store.get_version(did, version)}

    @app.put("/api/designs/{did}/versions", status_code=201)
    def save_version(did: str, body: dict):
        base_version = body.get("base_version")
        data = body.get("data")
        if not isinstance(base_version, int):
            return _error(422, "缺少 base_version（乐观并发控制）")
        errors = validate_design(data)
        if errors:
            return _error(422, "设计不完整，无法保存", errors=errors)
        try:
            new_version = store.add_version(did, base_version, data)
        except ConflictError as exc:
            return _error(
                409,
                "保存冲突：设计已被其他窗口更新",
                latest_version=exc.latest_version,
            )
        return {"design_id": did, "version": new_version}

    # ------------------------------------------------------------ 检查

    @app.post("/api/designs/{did}/checks", status_code=201)
    def run_check(did: str, body: dict | None = None):
        version = (body or {}).get("version")
        if version is None:
            version = store.get_design(did)["latest_version"]
        data = store.get_version(did, version)
        result = run_checks(data)
        check_id = store.save_check(did, version, result)
        return store.get_check(did, check_id)

    @app.get("/api/designs/{did}/checks")
    def list_checks(did: str):
        store.get_design(did)  # 404 if missing
        return {"checks": store.list_checks(did)}

    @app.get("/api/designs/{did}/checks/{check_id}")
    def get_check(did: str, check_id: str):
        return store.get_check(did, check_id)

    # ------------------------------------------------------------ 页面

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
