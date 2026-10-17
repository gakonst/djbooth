"""Loopback-only native UI fixture. Run once per test: python3 <this file>.

HTTP 8792 exposes test setup/control only. Library traffic uses pinned TLS on an
ephemeral port. Audio is valid PCM WAV; analysis is deliberately absent so the
real non-demo app cannot export this fixture through DJ Link.
"""
import hashlib
import io
import json
import math
import pathlib
import secrets
import ssl
import struct
import subprocess
import tempfile
import threading
import uuid
import wave
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit


def audio(frequency):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
        wav.writeframes(b"".join(struct.pack("<h", int(1200 * math.sin(2 * math.pi * frequency * i / 22050)))
                                 for i in range(22050 * 35)))
    return output.getvalue()


objects = {"a": audio(220), "b": audio(330), "c": audio(440), "d": audio(550)}
hashes = {key: hashlib.sha256(value).hexdigest() for key, value in objects.items()}


def cover():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = bytearray()
    for y in range(96):
        pixels.append(0)
        for x in range(96):
            color = (246, 96, 47) if x < 64 else (30, 205, 214)
            if 12 < x < 40 and 12 < y < 40:
                color = (255, 244, 220)
            if 60 < y < 72:
                color = (18, 32, 60)
            pixels.extend(color)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 96, 96, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


artwork = cover()
artwork_hash = hashlib.sha256(artwork).hexdigest()
library_id = "ui-" + uuid.uuid4().hex
token = secrets.token_hex(32)
audio_requests = []
artwork_requests = []
credential_requests = 0
catalog_requests = 0
offline = False


def track(identity, detail=False):
    titles = {"a": "First light", "b": "Night drive", "c": "Amber echoes", "d": "Before time"}
    value = {"id": identity, "title": titles[identity],
             "artist": "Hidden Artist" if identity == "c" else "Loopback Sessions",
             "album": "Dawn study" if identity == "a" else "After dark",
             "bpm": 123 if identity == "a" else 131,
             "key": "8A" if identity == "a" else "9A", "durationSeconds": 35,
             "artworkAvailable": False, "fileExists": True, "analyzed": False, "sourceRevision": "r1"}
    if identity != "d":
        # Same day, subsecond distinction, tied dates and an unknown date make
        # title order, day-only dates and unstable ties fail the UI regression.
        value["addedAt"] = "2026-10-17T12:30:00.100Z" if identity == "a" else "2026-10-17T12:30:00.900Z"
    if detail:
        value.update(mediaHash=hashes[identity], mediaExtension="wav",
                     waveform={"peaks": [0.2, 0.5, 0.8, 0.4] * 32, "source": "fixture", "durationSeconds": 35})
        if identity == "a":
            value.update(artworkHash=artwork_hash, artworkAvailable=True)
    return value


catalog = {"libraryID": library_id, "name": "Studio Mac", "tracks": [track(key) for key in objects], "playlists": [
    {"id": "sets-a", "name": "Sets", "parentId": "root", "type": "folder", "seq": 1, "trackIDs": []},
    {"id": "sets-b", "name": "Sets", "parentId": "root", "type": "folder", "seq": 2, "trackIDs": []},
    {"id": "empty", "name": "Empty folder", "parentId": "root", "type": "folder", "seq": 3, "trackIDs": []},
    {"id": "aba", "name": "Evening sequence", "parentId": "sets-a", "type": "playlist", "seq": 1, "trackIDs": ["a", "b", "a"]},
    {"id": "other", "name": "Other sequence", "parentId": "sets-b", "type": "smart", "seq": 1, "trackIDs": ["b"]},
]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log pairing credentials.

    def reply(self, status, body=b"", content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", content_type)
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)


class Library(Handler):
    def do_GET(self):
        global credential_requests, catalog_requests
        if self.headers.get("Authorization"):
            credential_requests += 1
        if self.headers.get("Authorization") != "Bearer " + token:
            return self.reply(401)
        if any(self.headers.get(name) for name in ["Origin", "Referer", "Sec-Fetch-Site"]):
            return self.reply(403)
        url = urlsplit(self.path)
        if url.path == "/pair/v1/catalog":
            catalog_requests += 1
            return self.reply(200, json.dumps(catalog).encode())
        parts = url.path.split("/")
        if len(parts) < 5 or parts[1:4] != ["pair", "v1", "tracks"]:
            return self.reply(404)
        identity = unquote(parts[4])
        if identity not in objects:
            return self.reply(404)
        if len(parts) == 5:
            return self.reply(200, json.dumps({"track": track(identity, True)}).encode())
        if parts[5:] == ["artwork"]:
            if identity != "a":
                return self.reply(404)
            if parse_qs(url.query).get("hash") != [artwork_hash]:
                return self.reply(409)
            artwork_requests.append(identity)
            return self.reply(200, artwork, "image/png")
        if parts[5:] != ["audio"] or parse_qs(url.query).get("hash") != [hashes[identity]]:
            return self.reply(409)
        audio_requests.append(identity)
        self.reply(200, objects[identity], "audio/wav")


class Control(Handler):
    def do_GET(self):
        if self.path == "/fixture":
            return self.reply(200, json.dumps(descriptor).encode())
        if self.path == "/status":
            return self.reply(200, json.dumps({"offline": offline, "audioRequests": audio_requests,
                                              "artworkRequests": artwork_requests,
                                              "catalogRequests": catalog_requests,
                                              "credentialRequests": credential_requests}).encode())
        self.reply(404)

    def do_POST(self):
        global offline, library
        if self.path == "/online":
            if offline:
                library = ThreadingHTTPServer(("127.0.0.1", port), Library)
                library.socket = context.wrap_socket(library.socket, server_side=True)
                threading.Thread(target=library.serve_forever, daemon=True).start()
                offline = False
            return self.reply(200, b'{"offline":false}')
        if self.path != "/offline":
            return self.reply(404)
        if not offline:
            library.shutdown()
            library.server_close()
            offline = True
        self.reply(200, b'{"offline":true}')


with tempfile.TemporaryDirectory(prefix="djbooth-paired-ui-") as directory:
    root = pathlib.Path(directory)
    cert, key = root / "cert.pem", root / "key.pem"
    subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=localhost"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    library = ThreadingHTTPServer(("127.0.0.1", 0), Library)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    library.socket = context.wrap_socket(library.socket, server_side=True)
    port = library.server_port
    descriptor = {"version": 1, "url": f"https://127.0.0.1:{port}",
                  "certificateSHA256": hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest(),
                  "token": token, "libraryID": library_id, "name": "Studio Mac"}
    threading.Thread(target=library.serve_forever, daemon=True).start()
    control = ThreadingHTTPServer(("127.0.0.1", 8792), Control)
    print("Paired UI fixture ready on loopback control port 8792", flush=True)
    try:
        control.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        control.server_close()
        if not offline:
            library.shutdown()
            library.server_close()
