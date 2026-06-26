"""
app.py — control-panel API + web UI for the multistream relay.

Serves a single-page control panel and a small JSON API to edit stream keys,
bitrate, resolution and FPS per platform, and to start/stop/restart the pipeline.

Run:
    RELAY_PASSWORD=yourpass uvicorn app:app --host 0.0.0.0 --port 8080
"""

from __future__ import annotations

import os
import secrets

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel

import supervisor as sup_mod

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML = os.path.join(HERE, "static", "index.html")

PASSWORD = os.environ.get("RELAY_PASSWORD", "")
USERNAME = os.environ.get("RELAY_USERNAME", "admin")
# Optional shared token for the OBS browser dock (it can't show a login prompt).
# Put it in the dock URL as ?token=...   Defaults to the password if unset.
TOKEN = os.environ.get("RELAY_TOKEN", "") or PASSWORD

app = FastAPI(title="Multistream Relay Control")
# auto_error=False so a missing Authorization header doesn't 401 before we
# get a chance to check the ?token= query param used by the OBS dock.
security = HTTPBasic(auto_error=False)

# Fallback used only when app.py is run standalone (not via agent.py).
# When agent.py runs uvicorn in-process it calls sup_mod.set_active() first,
# so get_active() returns the live pipeline supervisor and _fallback is unused.
_fallback_supervisor = sup_mod.Supervisor()


def _sup() -> sup_mod.Supervisor:
    return sup_mod.get_active() or _fallback_supervisor


# ---- auth ----------------------------------------------------------------
def require_auth(
    request: Request,
    creds: HTTPBasicCredentials | None = Depends(security),
) -> str:
    if not PASSWORD:
        # Fail closed: refuse to run unprotected since this manages stream keys.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="RELAY_PASSWORD is not set; the panel refuses to run unprotected.",
        )

    # 1) token in query string (OBS custom browser dock)
    token = request.query_params.get("token", "")
    if token and secrets.compare_digest(token, TOKEN):
        return "token"

    # 2) HTTP Basic (normal browser)
    if creds is not None:
        ok_user = secrets.compare_digest(creds.username, USERNAME)
        ok_pass = secrets.compare_digest(creds.password, PASSWORD)
        if ok_user and ok_pass:
            return creds.username

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Basic"},
    )


# ---- models --------------------------------------------------------------
class Output(BaseModel):
    name: str
    enabled: bool = True
    mode: str = "transcode"          # "transcode" | "passthrough"
    url: str = ""
    key: str = ""
    bitrate_kbps: int = 8000
    width: int | None = 1920
    height: int | None = 1080
    fps: int = 60


class Config(BaseModel):
    outputs: list[Output]


class ControlAction(BaseModel):
    action: str                      # "start" | "stop" | "restart"
    grace: bool = False              # if stopping, defer by the grace period


# ---- lifecycle -----------------------------------------------------------
@app.on_event("startup")
def _startup() -> None:
    # By default the relay stays idle until OBS starts publishing (MediaMTX
    # fires the start hook). Set RELAY_AUTOSTART=1 to run immediately instead.
    if os.environ.get("RELAY_AUTOSTART", "0") != "1":
        return
    try:
        cfg = sup_mod.load_config()
        _sup().apply(cfg)
    except FileNotFoundError:
        pass  # no config yet; user will create one via the UI


@app.on_event("shutdown")
def _shutdown() -> None:
    _sup().stop_all()


# ---- routes --------------------------------------------------------------
@app.get("/")
def index(_: str = Depends(require_auth)):
    return FileResponse(INDEX_HTML)


@app.get("/api/config")
def get_config(_: str = Depends(require_auth)):
    try:
        return sup_mod.load_config()
    except FileNotFoundError:
        return {"outputs": []}


@app.post("/api/config")
def set_config(cfg: Config, _: str = Depends(require_auth)):
    data = cfg.model_dump()
    sup_mod.save_config(data)
    _sup().apply(data)
    return {"ok": True}


@app.post("/api/control")
def control(req: ControlAction, _: str = Depends(require_auth)):
    if req.action == "stop":
        if req.grace:
            # OBS dropped: defer the stop so a quick reconnect cancels it.
            _sup().schedule_stop()
        else:
            _sup().cancel_pending_stop()
            _sup().stop_all()
    elif req.action in ("start", "restart"):
        # OBS (re)connected: cancel any pending grace-period stop first.
        _sup().cancel_pending_stop()
        try:
            cfg = sup_mod.load_config()
        except FileNotFoundError:
            raise HTTPException(400, "No config saved yet")
        if req.action == "restart":
            _sup().restart_all(cfg)
        else:
            _sup().apply(cfg)
    else:
        raise HTTPException(400, f"Unknown action: {req.action}")
    return {"ok": True}


@app.get("/api/status")
def get_status(_: str = Depends(require_auth)):
    return {"outputs": _sup().status()}


@app.get("/api/logs/{name}")
def get_logs(name: str, _: str = Depends(require_auth)):
    return JSONResponse({"name": name, "lines": _sup().logs(name)})
