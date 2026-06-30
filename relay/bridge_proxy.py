#!/usr/bin/env python3
"""Authenticating gateway for the VPS↔GPU mpegts bridge (enterprise-audit SEC-03).

The GPU's mpegts-over-TLS bridge listener on :8899 is a PUBLIC port (Vast/RunPod map it
to the host IP). Today ffmpeg terminates that TLS and authenticates NOTHING: anyone who
finds the ephemeral GPU IP:8899 during a live session can push their own mpegts, which the
GPU transcodes and the hub fans out into the victim's platforms. The web layer already
mints + delivers a per-session `bridge_secret` (SLIMCAST_BRIDGE_SECRET) to both ends — it
was simply never enforced (a `grep bridge_secret relay/` returned nothing). This module is
that enforcement.

Two modes, one shared pre-shared-secret handshake (constant-time compared):

  server  (GPU side)  — terminate TLS on the PUBLIC port, read a one-line secret preamble,
                        and ONLY on a match splice the connection to ffmpeg listening on a
                        PRIVATE localhost port (plaintext). A wrong/absent secret is dropped
                        before a single mpegts byte reaches the transcoder. ffmpeg never sees
                        an unauthenticated peer.
  client  (hub side)  — the hub's per-tenant `-c copy` ffmpeg writes mpegts to THIS process
                        over a localhost pipe; we open TLS to the GPU's public port, send the
                        secret preamble, then pump the stream through.

The secret is read from the SLIMCAST_BRIDGE_SECRET env var (NOT argv) so it never appears in
`ps`, `docker logs`, or the supervisor's `$ <cmd>` echo. Self-signed TLS (the GPU generates
its own cert at boot); the client does not verify it (encryption-in-transit + the PSK is the
auth, matching the pre-existing ffmpeg-tls-client behavior).

Wire-up is gated behind SLIMCAST_BRIDGE_AUTH in agent.py / supervisor.py — default OFF keeps
the (still un-live-proven) baseline bridge byte-identical; flip it ON for gputest Phase 2.
"""
from __future__ import annotations

import hmac
import os
import socket
import ssl
import sys
import threading
import time

MAGIC = b"SLIMCAST-BRIDGE/1:"   # preamble prefix; lets the server reject random scanners fast
MAX_PREAMBLE = 512              # hard cap on the preamble line so a peer can't stream us forever
PUMP_BUF = 65536
BACKEND_DIAL_TIMEOUT_S = 5.0    # total budget to reach the local ffmpeg (it may be mid-restart)
HANDSHAKE_TIMEOUT_S = 10.0      # total budget for the TLS handshake + secret preamble
# After auth, reap a connection whose mpegts source has gone silent this long. A live stream
# pushes continuously (every few ms), so this only ever fires on a genuinely dead source — and
# it must be set EXPLICITLY because the post-auth sockets otherwise have no read timeout (the
# backend's inherited connect-timeout is cleared to stop it from tearing down the live stream).
BRIDGE_IDLE_TIMEOUT_S = 30.0


def _log(msg: str) -> None:
    # stderr → docker logs (the GPU/hub roles mirror it). Never logs the secret.
    print(f"[bridge_proxy] {msg}", file=sys.stderr, flush=True)


def _secret() -> bytes:
    s = os.environ.get("SLIMCAST_BRIDGE_SECRET", "").strip()
    return s.encode()


def _read_preamble_line(sock: socket.socket) -> bytes | None:
    """Read one newline-terminated preamble line, byte-by-byte so we never consume any
    mpegts payload that follows it. Returns the line WITHOUT the trailing newline, or None
    on EOF / overflow / timeout."""
    buf = bytearray()
    deadline = time.monotonic() + HANDSHAKE_TIMEOUT_S
    while len(buf) < MAX_PREAMBLE:
        if time.monotonic() > deadline:
            return None   # slow-loris: a peer trickling the preamble can't pin us past the budget
        try:
            b = sock.recv(1)
        except (OSError, ssl.SSLError):
            return None
        if not b:
            return None
        if b == b"\n":
            return bytes(buf)
        buf += b
    return None   # overflow → no newline within the cap → reject


def _pump(src: socket.socket, dst: socket.socket, done: threading.Event) -> None:
    try:
        while not done.is_set():
            data = src.recv(PUMP_BUF)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        done.set()
        # Half-close the destination so the other side sees EOF promptly.
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _splice(a: socket.socket, b: socket.socket) -> None:
    """Bidirectionally pump until either side closes (mpegts is one-way, but a clean
    bidirectional splice also tears down promptly on backend EOF)."""
    done = threading.Event()
    t1 = threading.Thread(target=_pump, args=(a, b, done), daemon=True)
    t2 = threading.Thread(target=_pump, args=(b, a, done), daemon=True)
    t1.start(); t2.start()
    done.wait()
    for s in (a, b):
        try:
            s.close()
        except OSError:
            pass


def _dial_backend(host: str, port: int) -> socket.socket | None:
    """Connect to the local ffmpeg, retrying briefly — ffmpeg may be between restarts
    (the supervisor relaunches its tcp listener after each stream end)."""
    deadline = time.monotonic() + BACKEND_DIAL_TIMEOUT_S
    delay = 0.1
    while time.monotonic() < deadline:
        try:
            return socket.create_connection((host, port), timeout=5.0)
        except OSError:
            time.sleep(delay)
            delay = min(delay * 2, 1.0)
    return None


def _handle_server_conn(raw: socket.socket, ctx: ssl.SSLContext, backend_host: str,
                        backend_port: int, secret: bytes) -> None:
    peer = ""
    try:
        peer = f"{raw.getpeername()[0]}"
    except OSError:
        pass
    tls: socket.socket | None = None
    try:
        raw.settimeout(HANDSHAKE_TIMEOUT_S)
        try:
            tls = ctx.wrap_socket(raw, server_side=True)
        except (ssl.SSLError, OSError) as e:
            _log(f"tls handshake failed from {peer}: {e}")
            raw.close()
            return
        line = _read_preamble_line(tls)
        # Reject anything that doesn't present the exact preamble — no mpegts byte is forwarded
        # on failure. The MAGIC prefix is a fast public-prefix screen; the SECRET is compared
        # in constant time (hmac.compare_digest) so a reject leaks no timing about the secret.
        ok = (
            line is not None
            and line.startswith(MAGIC)
            and len(secret) > 0
            and hmac.compare_digest(line[len(MAGIC):], secret)
        )
        if not ok:
            _log(f"AUTH REJECT from {peer} (bad/absent bridge secret)")
            tls.close()
            return
        backend = _dial_backend(backend_host, backend_port)
        if backend is None:
            _log(f"backend ffmpeg unreachable at {backend_host}:{backend_port} — dropping {peer}")
            tls.close()
            return
        _log(f"AUTH OK {peer} → splicing to {backend_host}:{backend_port}")
        # CLEAR the backend's inherited connect-timeout: ffmpeg's input socket never sends data
        # back, so a lingering timeout would make the reverse pump's recv() raise after a few
        # seconds and tear down the LIVE stream (crash-loop). The forward (mpegts) direction
        # instead carries an idle timeout, so a dead source is still reaped.
        backend.settimeout(None)
        tls.settimeout(BRIDGE_IDLE_TIMEOUT_S)
        _splice(tls, backend)
    except Exception as e:   # noqa: BLE001 — a handler must never kill the accept loop
        _log(f"server conn error from {peer}: {e}")
        for s in (tls, raw):
            try:
                if s:
                    s.close()
            except OSError:
                pass


def run_server(listen_port: int, backend_host: str, backend_port: int,
               cert_file: str, key_file: str) -> int:
    secret = _secret()
    if not secret:
        _log("FATAL: SLIMCAST_BRIDGE_SECRET is empty — refusing to start an open gateway")
        return 2
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", listen_port))
    srv.listen(8)
    _log(f"listening (tls) on 0.0.0.0:{listen_port} → ffmpeg {backend_host}:{backend_port}")
    while True:
        try:
            conn, _ = srv.accept()
        except OSError as e:
            _log(f"accept failed: {e}")
            continue
        # Thread per connection so a slow handshake / reconnect overlap can't wedge the loop.
        threading.Thread(
            target=_handle_server_conn,
            args=(conn, ctx, backend_host, backend_port, secret),
            daemon=True,
        ).start()


def run_client(connect_host: str, connect_port: int) -> int:
    """Read mpegts from stdin, open TLS to the GPU gateway, send the secret preamble, pump.
    One-shot: when ffmpeg (our stdin) ends, we exit and the supervisor restarts the pair."""
    secret = _secret()
    if not secret:
        _log("FATAL: SLIMCAST_BRIDGE_SECRET is empty — cannot authenticate to the GPU")
        return 2
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # Self-signed GPU cert — encryption only; the PSK preamble is the auth (matches the
    # pre-existing ffmpeg-tls-client behavior, which also did not verify the GPU cert).
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        raw = socket.create_connection((connect_host, connect_port), timeout=10.0)
    except OSError as e:
        _log(f"connect to GPU {connect_host}:{connect_port} failed: {e}")
        return 1
    try:
        tls = ctx.wrap_socket(raw, server_hostname=connect_host)
    except (ssl.SSLError, OSError) as e:
        _log(f"tls handshake to GPU failed: {e}")
        raw.close()
        return 1
    try:
        tls.sendall(MAGIC + secret + b"\n")
        stdin = sys.stdin.buffer
        while True:
            # read1: return as soon as ANY mpegts is available (vs read() which blocks for a
            # full PUMP_BUF or EOF) — keeps bridge latency low on a live stream.
            chunk = stdin.read1(PUMP_BUF)
            if not chunk:
                break
            tls.sendall(chunk)
    except OSError as e:
        _log(f"client pump ended: {e}")
        return 1
    finally:
        try:
            tls.close()
        except OSError:
            pass
    return 0


def main(argv: list[str]) -> int:
    import argparse
    p = argparse.ArgumentParser(description="SlimCast VPS↔GPU bridge auth gateway")
    sub = p.add_subparsers(dest="mode", required=True)

    ps = sub.add_parser("server", help="GPU side: authenticate then splice to local ffmpeg")
    ps.add_argument("--listen-port", type=int, required=True)
    ps.add_argument("--backend-host", default="127.0.0.1")
    ps.add_argument("--backend-port", type=int, required=True)
    ps.add_argument("--cert-file", required=True)
    ps.add_argument("--key-file", required=True)

    pc = sub.add_parser("client", help="hub side: send secret then pump stdin to the GPU")
    pc.add_argument("--connect-host", required=True)
    pc.add_argument("--connect-port", type=int, required=True)

    args = p.parse_args(argv)
    if args.mode == "server":
        return run_server(args.listen_port, args.backend_host, args.backend_port,
                          args.cert_file, args.key_file)
    return run_client(args.connect_host, args.connect_port)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
