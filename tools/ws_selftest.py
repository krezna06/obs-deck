#!/usr/bin/env python3
"""
A dependency-free obs-websocket v5 client, used to prove that the mock server's
handshake and frame encoding are correct by talking to it with completely
independent code (Python's stdlib only -- no `websockets` package).

It performs the real sequence:
  RFC6455 handshake -> op 0 Hello -> op 1 Identify (SHA-256 challenge auth)
  -> op 2 Identified -> op 6 GetSceneList -> op 7 RequestResponse

Usage:  python tools/ws_selftest.py [host] [port] [password]
        python tools/ws_selftest.py 127.0.0.1 4455 pw --json=report.json

Exit code 0 = all checks passed.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import sys

argv = [a for a in sys.argv[1:] if not a.startswith("--json=")]
JSON_PATH = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--json=")), None)

HOST = argv[0] if len(argv) > 0 else "127.0.0.1"
PORT = int(argv[1]) if len(argv) > 1 else 4455
PASSWORD = argv[2] if len(argv) > 2 else "test-password"
GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F"

failures = []
results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    if ok:
        print(f"  ok   {name}")
    else:
        failures.append(f"{name} -- {detail}")
        print(f"  FAIL {name} -- {detail}")


def write_report(exit_code):
    if not JSON_PATH:
        return
    try:
        with open(JSON_PATH, "w", encoding="utf-8") as fh:
            json.dump({
                "host": HOST,
                "port": PORT,
                "exitCode": exit_code,
                "passed": sum(1 for r in results if r["ok"]),
                "failed": sum(1 for r in results if not r["ok"]),
                "checks": results,
            }, fh, indent=2)
    except OSError as exc:
        print(f"  (could not write {JSON_PATH}: {exc})")


class RawWebSocket:
    """Minimal RFC6455 client: text frames out (masked), text frames in."""

    def __init__(self, host, port, timeout=5.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._handshake(host, port)

    def _handshake(self, host, port):
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())

        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("connection closed during handshake")
            buf += chunk

        head, _, rest = buf.partition(b"\r\n\r\n")
        self.buffer = rest
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0]

        if "101" not in status:
            raise RuntimeError(f"expected 101, got: {status}")

        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        expected = base64.b64encode(
            hashlib.sha1((key + GUID).encode()).digest()
        ).decode()
        if headers.get("sec-websocket-accept") != expected:
            raise RuntimeError(
                f"bad Sec-WebSocket-Accept: {headers.get('sec-websocket-accept')} != {expected}"
            )
        self.accept_ok = True

    def send_text(self, text):
        payload = text.encode()
        header = bytearray([0x81])  # FIN + text
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _read_exact(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("connection closed mid-frame")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def recv_text(self):
        for _ in range(64):
            b0, b1 = self._read_exact(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            if masked:
                raise RuntimeError("server frames must not be masked")
            payload = self._read_exact(length)

            if opcode == 0x8:
                code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else None
                raise RuntimeError(f"server closed the connection (code {code})")
            if opcode == 0x9:  # ping -> pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x1 and fin:
                return payload.decode()
        raise RuntimeError("no text frame received")


def sha256_b64(text):
    """base64 of a SHA-256 digest -- what obs-websocket v5 actually expects."""
    return base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()


def main():
    print(f"\nRaw RFC6455 obs-websocket client -> {HOST}:{PORT}")
    ws = RawWebSocket(HOST, PORT)
    check("RFC6455 handshake accepted with a valid Sec-WebSocket-Accept", ws.accept_ok)

    hello = json.loads(ws.recv_text())
    check("server sent op 0 Hello", hello.get("op") == 0, json.dumps(hello)[:120])
    check("Hello declares obs-websocket 5.x", str(hello["d"].get("obsWebSocketVersion", "")).startswith("5"),
          str(hello["d"].get("obsWebSocketVersion")))
    check("Hello advertises rpcVersion 1", hello["d"].get("rpcVersion") == 1)

    auth = hello["d"].get("authentication")
    check("Hello carried salt + challenge", bool(auth and auth.get("salt") and auth.get("challenge")))

    identify = {"rpcVersion": 1}
    if auth:
        secret = sha256_b64(PASSWORD + auth["salt"])
        identify["authentication"] = sha256_b64(secret + auth["challenge"])
        check("auth response is a base64 SHA-256 digest, not hex",
              len(identify["authentication"]) == 44 and identify["authentication"].endswith("="),
              identify["authentication"])
    ws.send_text(json.dumps({"op": 1, "d": identify}))

    identified = json.loads(ws.recv_text())
    check("server accepted the password and sent op 2 Identified",
          identified.get("op") == 2, json.dumps(identified)[:120])

    ws.send_text(json.dumps({
        "op": 6,
        "d": {"requestType": "GetSceneList", "requestId": "selftest-1", "requestData": {}},
    }))
    resp = json.loads(ws.recv_text())
    check("server answered op 7", resp.get("op") == 7, json.dumps(resp)[:120])
    check("RequestResponse echoes our requestId", resp["d"].get("requestId") == "selftest-1")
    check("requestStatus.result is true", resp["d"]["requestStatus"].get("result") is True,
          json.dumps(resp["d"].get("requestStatus")))

    scenes = [s["sceneName"] for s in resp["d"]["responseData"].get("scenes", [])]
    check("scene list came back over real frames", "CAM TALK" in scenes, str(scenes))
    check("currentProgramSceneName present",
          bool(resp["d"]["responseData"].get("currentProgramSceneName")))

    # A second request proves the connection keeps working frame after frame.
    ws.send_text(json.dumps({
        "op": 6,
        "d": {"requestType": "GetTransitionList", "requestId": "selftest-2", "requestData": {}},
    }))
    resp2 = json.loads(ws.recv_text())
    names = [t["transitionName"] for t in resp2["d"]["responseData"].get("transitions", [])]
    check("a second request on the same socket works", "Fade" in names, str(names))

    # Exercise a larger payload (>125 bytes) to test the 16-bit length form.
    ws.send_text(json.dumps({
        "op": 6,
        "d": {"requestType": "GetSourceScreenshot",
              "requestId": "selftest-3",
              "requestData": {"sourceName": "CAM TALK", "imageFormat": "jpeg",
                              "imageWidth": 960, "imageHeight": 540}},
    }))
    resp3 = json.loads(ws.recv_text())
    check("a larger response frame decodes correctly",
          str(resp3["d"]["responseData"].get("imageData", "")).startswith("data:image/jpeg"),
          str(resp3["d"]["responseData"])[:80])

    ws.sock.close()

    # A second connection with the wrong password must be refused with op 9.
    bad = RawWebSocket(HOST, PORT)
    hello2 = json.loads(bad.recv_text())
    a2 = hello2["d"].get("authentication")
    wrong = {"rpcVersion": 1}
    if a2:
        wrong["authentication"] = sha256_b64(sha256_b64("definitely-not-the-password" + a2["salt"]) + a2["challenge"])
    bad.send_text(json.dumps({"op": 1, "d": wrong}))
    try:
        reply = json.loads(bad.recv_text())
        check("wrong password is refused with op 9 AuthenticationFailure",
              reply.get("op") == 9, json.dumps(reply)[:120])
    except RuntimeError as exc:
        # The server is also allowed to just close the socket.
        check("wrong password is refused (server closed the connection)",
              "closed the connection" in str(exc), str(exc))
    bad.sock.close()

    return 0 if not failures else 1


if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:  # noqa: BLE001
        results.append({"name": "client ran", "ok": False, "detail": f"{type(exc).__name__}: {exc}"})
        print(f"  FAIL exception: {type(exc).__name__}: {exc}")
        code = 1
    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print("  -", f)
    else:
        print("all raw-frame checks passed")
    print("=" * 60)
    write_report(code)
    sys.exit(code)
