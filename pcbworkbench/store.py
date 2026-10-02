"""SQLite 持久化：设计、不可变版本快照、按版本绑定的检查结果。

- 每次保存产生一个递增的不可变版本（version），完整快照存 JSON。
- 保存时必须带上 base_version，不等于当前最新版本则抛 ConflictError，
  由接口层转成 409，避免后保存的窗口无提示覆盖另一窗口的改动。
- 检查结果绑定 (design_id, version)，旧版结果永远指向旧版快照里的对象 id，
  不会悄悄解析到新版对象上。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS designs(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS versions(
    design_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY(design_id, version)
);
CREATE TABLE IF NOT EXISTS checks(
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    result TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""


class ConflictError(Exception):
    def __init__(self, latest_version: int):
        super().__init__(f"base_version 已过期，当前最新版本为 {latest_version}")
        self.latest_version = latest_version


class NotFoundError(Exception):
    pass


class Store:
    def __init__(self, path: str):
        # RLock：get_design 等方法内部会调用其他加锁方法
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self):
        self._conn.close()

    # ------------------------------------------------------------ 设计

    def create_design(self, data: dict, design_id: str | None = None) -> str:
        did = design_id or uuid.uuid4().hex[:12]
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO designs(id, name, created_at) VALUES(?,?,?)",
                (did, data["name"], now),
            )
            self._conn.execute(
                "INSERT INTO versions(design_id, version, data, created_at) VALUES(?,?,?,?)",
                (did, 1, json.dumps(data), now),
            )
            self._conn.commit()
        return did

    def has_designs(self) -> bool:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM designs").fetchone()
        return row["n"] > 0

    def list_designs(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT d.id, d.name, MAX(v.version) AS latest_version
                FROM designs d JOIN versions v ON v.design_id = d.id
                GROUP BY d.id, d.name
                ORDER BY d.created_at
                """
            ).fetchall()
        return [dict(r) for r in rows]

    def _latest_version(self, design_id: str) -> int:
        row = self._conn.execute(
            "SELECT MAX(version) AS v FROM versions WHERE design_id=?", (design_id,)
        ).fetchone()
        if row is None or row["v"] is None:
            raise NotFoundError(design_id)
        return row["v"]

    def get_design(self, design_id: str) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, name FROM designs WHERE id=?", (design_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(design_id)
            latest = self._latest_version(design_id)
            data = self.get_version(design_id, latest)
        return {
            "id": row["id"],
            "name": row["name"],
            "latest_version": latest,
            "design": data,
        }

    def get_version(self, design_id: str, version: int) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM versions WHERE design_id=? AND version=?",
                (design_id, version),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"{design_id}@v{version}")
        return json.loads(row["data"])

    def add_version(self, design_id: str, base_version: int, data: dict) -> int:
        with self._lock:
            latest = self._latest_version(design_id)
            if base_version != latest:
                raise ConflictError(latest)
            new_version = latest + 1
            self._conn.execute(
                "INSERT INTO versions(design_id, version, data, created_at) VALUES(?,?,?,?)",
                (design_id, new_version, json.dumps(data), time.time()),
            )
            self._conn.execute(
                "UPDATE designs SET name=? WHERE id=?", (data["name"], design_id)
            )
            self._conn.commit()
        return new_version

    # ------------------------------------------------------------ 检查结果

    def save_check(self, design_id: str, version: int, result: dict) -> str:
        check_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._conn.execute(
                "INSERT INTO checks(id, design_id, version, result, created_at)"
                " VALUES(?,?,?,?,?)",
                (check_id, design_id, version, json.dumps(result), time.time()),
            )
            self._conn.commit()
        return check_id

    def list_checks(self, design_id: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, version, result, created_at FROM checks"
                " WHERE design_id=? ORDER BY created_at DESC, id DESC",
                (design_id,),
            ).fetchall()
        out = []
        for r in rows:
            result = json.loads(r["result"])
            out.append(
                {
                    "id": r["id"],
                    "version": r["version"],
                    "created_at": r["created_at"],
                    "summary": result["summary"],
                }
            )
        return out

    def get_check(self, design_id: str, check_id: str) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, version, result, created_at FROM checks"
                " WHERE id=? AND design_id=?",
                (check_id, design_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(check_id)
        result = json.loads(row["result"])
        result.update(
            {"id": row["id"], "design_id": design_id, "version": row["version"],
             "created_at": row["created_at"]}
        )
        return result
