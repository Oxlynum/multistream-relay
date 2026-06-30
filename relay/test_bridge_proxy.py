#!/usr/bin/env python3
"""End-to-end auth test for bridge_proxy.py (enterprise-audit SEC-03).

Proves the security-critical contract WITHOUT a GPU:
  1. A client with the CORRECT secret → its bytes reach the backend ffmpeg.
  2. A client with a WRONG secret → ZERO bytes reach the backend (dropped at the gateway).
  3. A raw TLS peer sending no/garbage preamble → ZERO bytes reach the backend.

Runs the real CLI (`python3 bridge_proxy.py server|client`) over loopback with a throwaway
self-signed cert, and a fake backend socket that counts what it receives. No pytest — plain
asserts, exits non-zero on failure (matches the repo's `npx tsx` test convention).
"""
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = os.path.join(HERE, "bridge_proxy.py")
GOOD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
BAD = "ffffffffffffffffffffffffffffffff"
PAYLOAD = b"MPEGTS-PAYLOAD-" + b"x" * 4000  # stand-in for the HEVC mpegts stream


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class FakeBackend:
    """Stands in for the GPU's local ffmpeg tcp listener — counts bytes per connection."""
    def __init__(self, port: int):
        self.port = port
        self.conns: list[bytes] = []
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", port))
        self._srv.listen(4)
        self._stop = False
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while not self._stop:
            try:
                c, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._drain, args=(c,), daemon=True).start()

    def _drain(self, c: socket.socket):
        buf = bytearray()
        try:
            while True:
                d = c.recv(65536)
                if not d:
                    break
                buf += d
        except OSError:
            pass
        finally:
            c.close()
            self.conns.append(bytes(buf))

    @property
    def total_bytes(self) -> int:
        return sum(len(b) for b in self.conns)

    def close(self):
        self._stop = True
        try:
            self._srv.close()
        except OSError:
            pass


def _make_cert(d: str) -> tuple[str, str]:
    cert, key = os.path.join(d, "t.crt"), os.path.join(d, "t.key")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"],
        check=True, capture_output=True,
    )
    return cert, key


def _wait_port(port: int, timeout: float = 5.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.05)
    return False


def _run_client(server_port: int, secret: str, payload: bytes) -> int:
    env = {**os.environ, "SLIMCAST_BRIDGE_SECRET": secret}
    p = subprocess.run(
        [sys.executable, PROXY, "client", "--connect-host", "127.0.0.1",
         "--connect-port", str(server_port)],
        input=payload, env=env, capture_output=True, timeout=15,
    )
    return p.returncode


MAGIC = b"SLIMCAST-BRIDGE/1:"


def _raw_tls_inject(server_port: int, preamble: bytes, payload: bytes) -> None:
    """An attacker who knows nothing: TLS-connects and sends garbage/no valid preamble."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        raw = socket.create_connection(("127.0.0.1", server_port), timeout=5)
        tls = ctx.wrap_socket(raw, server_hostname="127.0.0.1")
        tls.sendall(preamble + payload)
        time.sleep(0.5)
        tls.close()
    except OSError:
        pass


def _sustained_valid(server_port: int, secret: str, chunk1: bytes, chunk2: bytes, gap_s: float) -> None:
    """A VALID, long-lived connection: authenticate, send a chunk, idle past the old 5s
    backend-timeout, then send another chunk. Catches the regression where the backend
    socket's inherited connect-timeout tore the live stream down after ~5s."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    raw = socket.create_connection(("127.0.0.1", server_port), timeout=5)
    tls = ctx.wrap_socket(raw, server_hostname="127.0.0.1")
    tls.sendall(MAGIC + secret.encode() + b"\n")
    tls.sendall(chunk1)
    time.sleep(gap_s)
    tls.sendall(chunk2)   # if the splice died at ~5s this raises or is dropped → backend short
    time.sleep(0.4)
    tls.close()


def main() -> int:
    failures = 0
    with tempfile.TemporaryDirectory() as d:
        cert, key = _make_cert(d)
        server_port, backend_port = _free_port(), _free_port()
        backend = FakeBackend(backend_port)
        server = subprocess.Popen(
            [sys.executable, PROXY, "server", "--listen-port", str(server_port),
             "--backend-host", "127.0.0.1", "--backend-port", str(backend_port),
             "--cert-file", cert, "--key-file", key],
            env={**os.environ, "SLIMCAST_BRIDGE_SECRET": GOOD},
        )
        try:
            assert _wait_port(server_port), "gateway server did not come up"

            # 1) CORRECT secret → payload reaches the backend.
            rc = _run_client(server_port, GOOD, PAYLOAD)
            time.sleep(0.5)
            if rc == 0 and backend.total_bytes == len(PAYLOAD):
                print(f"PASS: valid secret delivered {backend.total_bytes} bytes to backend")
            else:
                print(f"FAIL: valid secret — rc={rc}, backend got {backend.total_bytes}/{len(PAYLOAD)}")
                failures += 1

            # 2) WRONG secret → nothing new reaches the backend.
            before = backend.total_bytes
            _run_client(server_port, BAD, PAYLOAD)
            time.sleep(0.5)
            if backend.total_bytes == before:
                print("PASS: wrong secret delivered 0 bytes to backend (rejected at gateway)")
            else:
                print(f"FAIL: wrong secret leaked {backend.total_bytes - before} bytes to backend")
                failures += 1

            # 3) Raw TLS peer with a bogus preamble → nothing new reaches the backend.
            before = backend.total_bytes
            _raw_tls_inject(server_port, b"GARBAGE-NO-MAGIC\n", PAYLOAD)
            time.sleep(0.5)
            if backend.total_bytes == before:
                print("PASS: bogus-preamble injection delivered 0 bytes to backend")
            else:
                print(f"FAIL: bogus preamble leaked {backend.total_bytes - before} bytes to backend")
                failures += 1

            # 4) SUSTAINED valid connection across a >5s idle gap → BOTH chunks reach the
            # backend (regression guard for the backend-timeout teardown that killed the
            # stream every ~5s). The backend silently never sends data back, so this only
            # passes if the reverse pump is NOT on a timeout.
            before = backend.total_bytes
            c1, c2 = b"C1-" + b"a" * 2000, b"C2-" + b"b" * 2000
            _sustained_valid(server_port, GOOD, c1, c2, gap_s=7.0)
            time.sleep(0.6)
            delivered = backend.total_bytes - before
            if delivered == len(c1) + len(c2):
                print(f"PASS: sustained connection survived a 7s idle gap, delivered {delivered} bytes")
            else:
                print(f"FAIL: sustained connection delivered {delivered}/{len(c1) + len(c2)} bytes "
                      "(stream torn down mid-session?)")
                failures += 1
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
            backend.close()

    print("ALL BRIDGE-PROXY ASSERTS PASSED" if failures == 0 else f"{failures} ASSERT(S) FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
