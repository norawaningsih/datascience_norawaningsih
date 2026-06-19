"""RupiahCast Pro LSTM — Vercel-compatible FastAPI API.

The dashboard is served by Vercel's CDN from public/index.html. This module only
handles API routes, so static files are not read from the serverless function.
"""
from __future__ import annotations

import os
import platform
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse

APP_NAME = "RupiahCast Pro LSTM"
APP_VERSION = "4.0.1"

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    """Fallback when the root rewrite is bypassed."""
    return RedirectResponse(url="/index.html", status_code=307)


@app.get("/api/health")
@app.get("/health.php", include_in_schema=False)
def health() -> dict[str, Any]:
    try:
        import numpy as np

        numpy_version = np.__version__
        numpy_status = "ok"
    except Exception as exc:  # Keep diagnostics available even if NumPy fails.
        numpy_version = "unavailable"
        numpy_status = f"error: {type(exc).__name__}: {exc}"

    return {
        "status": "ok",
        "app": APP_NAME,
        "version": APP_VERSION,
        "checks": {
            "python_version": platform.python_version(),
            "numpy_version": numpy_version,
            "numpy_status": numpy_status,
            "lstm_available": numpy_version != "unavailable",
            "runtime": "Vercel Python" if os.getenv("VERCEL") else "Local FastAPI",
            "storage": "Browser localStorage",
        },
    }


@app.post("/api/lstm")
def lstm_forecast(payload: dict[str, Any] = Body(...)) -> JSONResponse:
    try:
        # Import lazily so a numerical-runtime issue cannot take down the UI or
        # the health endpoint during function startup.
        from engine.numpy_lstm import run_forecast

        result = run_forecast(payload)
        return JSONResponse(result)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Engine LSTM gagal: {type(exc).__name__}: {exc}",
        ) from exc
