"""Ephemeral loopback-only TLS fixture for the native paired-library contract."""
import hashlib
import json
import pathlib
import ssl
import struct
import subprocess
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

root = pathlib.Path(sys.argv[1])
cert, key = root / "cert.pem", root / "key.pem"
subprocess.run([
    "/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=localhost",
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
objects = {kind: ("paired fixture " + kind).encode() for kind in ["audio", "dat", "ext", "twoEx"]}
detail_reads = {}
attempts = {}
lock = threading.Lock()
active = 0


def png(red):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = bytes([0, red, 0, 0, 0, 200, 0, 0, 0, 240] * 2)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 3, 2, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


cover = png(255)


def track_objects(identity):
    if identity == "local-analysis":
        return {**objects, **{kind: (root / ("waveform." + kind)).read_bytes() for kind in ["dat", "ext"]}}
    if identity.startswith("capped-"):
        return {kind: (identity + " " + kind).encode() for kind in objects}
    return objects


def track(identity, revision="r1"):
    hashes = {kind: hashlib.sha256(data).hexdigest() for kind, data in track_objects(identity).items()}
    value = {
        "id": identity, "title": "Mac recording", "artworkAvailable": False,
        "fileExists": True, "analyzed": True, "sourceRevision": revision,
        "mediaHash": hashes["audio"], "mediaExtension": "wav",
        "analysis": {"mediaHash": hashes["audio"], **{kind: hashes[kind] for kind in ["dat", "ext", "twoEx"]}},
        "waveform": {"peaks": [0.2, 0.8], "source": "rekordbox"},
    }
    if identity in ["local-analysis", "no-waveform"]:
        value.pop("waveform")
        value["durationSeconds"] = 3.5
    if identity.startswith("art-"):
        data = b"not an image" if identity == "art-invalid-image" else cover
        value["artworkHash"] = hashlib.sha256(data).hexdigest()
        value["artworkAvailable"] = True
        if identity == "art-malformed-hash":
            value["artworkHash"] = "not-a-hash"
    return value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body=b"", headers=None):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global active
        url = urlsplit(self.path)
        authorized = self.headers.get("Authorization") == "Bearer " + "b" * 64
        with lock:
            rejected = active >= 4
            if not rejected:
                active += 1
            attempts[url.path] = attempts.get(url.path, 0) + 1
            attempt = attempts[url.path]
            # Never write credentials, even fixture credentials, to the log.
            with (root / "requests.jsonl").open("a") as log:
                log.write(json.dumps({"path": url.path, "query": parse_qs(url.query), "authorized": authorized,
                                      "active": active, "rejected": rejected}) + "\n")
        if rejected:
            return self.reply(503, b'{"error":"BUSY"}')
        try:
            if "/capped-" in url.path:
                time.sleep(0.06)
            if "/blocked-" in url.path:
                deadline = time.monotonic() + 10
                while not (root / "release").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
            self.handle_get(url, authorized, attempt)
        finally:
            with lock:
                active -= 1

    def handle_get(self, url, authorized, attempt):
        browser_headers = any(self.headers.get(name) for name in ["Origin", "Referer", "Sec-Fetch-Site"])
        if not authorized or browser_headers:
            return self.reply(401)
        if url.path.endswith("/always-busy") or url.path.endswith("/busy-forever/audio"):
            return self.reply(503, b'{"error":"UNAVAILABLE"}')
        if any(url.path.endswith(suffix) for suffix in ["/busy-detail", "/busy-audio/audio", "/busy-ext/analysis/ext"]) and attempt <= 2:
            return self.reply(503, b'{"error":"BUSY"}')
        if url.path.endswith("/unauthorized"):
            return self.reply(401, b'{"error":"UNAUTHORIZED"}')
        if url.path.endswith("/server-error"):
            return self.reply(500, b'{"error":"SERVER_ERROR"}')
        if url.path == "/pair/v1/catalog":
            return self.reply(200, json.dumps({"libraryID": "mac", "name": "Studio Mac", "tracks": [track("ok")], "playlists": []}).encode())
        parts = url.path.split("/")
        if len(parts) < 5 or parts[1:4] != ["pair", "v1", "tracks"]:
            return self.reply(404)
        identity = unquote(parts[4])
        if identity.startswith("redirect-"):
            origin = f"https://127.0.0.1:{self.server.server_port}"
            if identity == "redirect-host":
                origin = f"https://localhost:{self.server.server_port}"
            if identity == "redirect-http":
                origin = f"http://127.0.0.1:{self.server.server_port}"
            return self.reply(302, headers={"Location": origin + "/sink"})
        if len(parts) == 5:
            detail_reads[identity] = detail_reads.get(identity, 0) + 1
            revision = "r2" if identity == "revision-race" and detail_reads[identity] > 1 else "r1"
            value = track(identity, revision)
            if identity == "unbound":
                value["analysis"]["mediaHash"] = "0" * 64
            if identity == "audio-only":
                value.pop("analysis")
            return self.reply(200, json.dumps({"track": value}).encode())
        if identity == "audio-redirect":
            return self.reply(302, headers={"Location": f"https://127.0.0.1:{self.server.server_port}/sink"})
        if parts[5:] == ["artwork"]:
            if parse_qs(url.query).get("hash") != [track(identity)["artworkHash"]]:
                return self.reply(409)
            if identity == "art-missing":
                return self.reply(404)
            if identity == "art-redirect":
                return self.reply(302, headers={"Location": f"https://localhost:{self.server.server_port}/sink"})
            if identity == "art-large-stream":
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Connection", "close")
                self.end_headers()
                return self.wfile.write(b"x" * (5 * 1024 * 1024 + 1))
            body = cover
            if identity == "art-invalid-image":
                body = b"not an image"
            if identity == "art-corrupt":
                body = png(100)
            if identity == "art-large-header":
                body = b"x" * (5 * 1024 * 1024 + 1)
            return self.reply(200, body, {"Content-Type": "text/html" if identity == "art-bad-mime" else "image/png"})
        kind = parts[5] if len(parts) == 6 else parts[6]
        query = parse_qs(url.query)
        data = track_objects(identity)
        hashes = {kind: hashlib.sha256(body).hexdigest() for kind, body in data.items()}
        if kind not in hashes or query.get("hash") != [hashes[kind]]:
            return self.reply(409)
        if kind != "audio" and query.get("mediaHash") != [hashes["audio"]]:
            return self.reply(400)
        body = b"corrupt bytes" if identity == "bad-" + kind else data[kind]
        return self.reply(200, body)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
der = ssl.PEM_cert_to_DER_cert(cert.read_text())
(root / "ready.json").write_text(json.dumps({
    "port": server.server_port, "certificateSHA256": hashlib.sha256(der).hexdigest(),
}))
server.serve_forever()
