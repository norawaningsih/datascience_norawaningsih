"""RupiahCast Pro LSTM — Vercel-compatible FastAPI entrypoint."""
from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from engine.numpy_lstm import run_forecast

APP_NAME = "RupiahCast Pro LSTM"
APP_VERSION = "4.0.0"
ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
INDEX = PUBLIC / "index.html"

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


def _safe_public_file(base: Path, relative: str) -> Path:
    candidate = (base / relative).resolve()
    if base.resolve() not in candidate.parents and candidate != base.resolve():
        raise HTTPException(status_code=404, detail="File tidak ditemukan.")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="File tidak ditemukan.")
    return candidate


@app.get("/api/health")
@app.get("/health.php", include_in_schema=False)
def health() -> dict[str, Any]:
    try:
        import numpy as np
        numpy_version = np.__version__
    except Exception:
        numpy_version = "unavailable"
    return {
        "status": "ok",
        "app": APP_NAME,
        "version": APP_VERSION,
        "checks": {
            "python_version": platform.python_version(),
            "numpy_version": numpy_version,
            "lstm_available": numpy_version != "unavailable",
            "runtime": "Vercel Python" if os.getenv("VERCEL") else "Local FastAPI",
            "storage": "Browser localStorage",
        },
    }


@app.post("/api/lstm")
def lstm_forecast(payload: dict[str, Any] = Body(...)) -> JSONResponse:
    try:
        result = run_forecast(payload)
        return JSONResponse(result)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # Friendly error returned to the dashboard.
        raise HTTPException(status_code=500, detail=f"Engine LSTM gagal: {exc}") from exc


@app.get("/assets/{asset_path:path}", include_in_schema=False)
def assets(asset_path: str) -> FileResponse:
    path = _safe_public_file(PUBLIC / "assets", asset_path)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/data/{data_path:path}", include_in_schema=False)
def data_files(data_path: str) -> FileResponse:
    path = _safe_public_file(PUBLIC / "data", data_path)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/index.html", include_in_schema=False)
def index_html() -> FileResponse:
    return FileResponse(INDEX, media_type="text/html", headers={"Cache-Control": "no-cache"})


# Keep every legacy PHP URL so bookmarks and the existing visual navigation do
# not change after the architecture migration.
LEGACY_PAGES = (
    "/",
    "/index.php",
    "/datasets.php",
    "/dataset.php",
    "/upload.php",
    "/forecast.php",
    "/history.php",
    "/lstm_setup.php",
)

for _path in LEGACY_PAGES:
    app.add_api_route(
        _path,
        index_html,
        methods=["GET"],
        include_in_schema=False,
        name="spa_" + (_path.strip("/").replace(".", "_") or "root"),
    )


@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str) -> FileResponse:
    # Unknown frontend routes still load the app shell; API routes are matched
    # above and therefore never reach this fallback.
    return FileResponse(INDEX, media_type="text/html", headers={"Cache-Control": "no-cache"})
