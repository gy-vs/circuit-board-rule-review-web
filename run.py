"""本地启动入口：python3 run.py 后访问 http://127.0.0.1:8000"""
import uvicorn

from pcbworkbench.app import create_app

if __name__ == "__main__":
    uvicorn.run(create_app("pcbworkbench.db"), host="127.0.0.1", port=8000)
