#!/usr/bin/env python3
"""Local IPTV Xtream player server — proxies Xtream Codes API and streams."""

from __future__ import annotations

import json
import os
import ssl
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8787"))
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 25


def fetch(url: str, timeout: int = TIMEOUT):
    req = Request(url, headers={"User-Agent": "IPTV-Xtream/1.0"})
    return urlopen(req, timeout=timeout, context=CTX)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api":
            return self.handle_api(parsed)
        if parsed.path == "/fetch":
            return self.handle_fetch(parsed)
        if parsed.path == "/stream":
            return self.handle_stream(parsed)
        if parsed.path in ("/", "/index.html"):
            return self.serve_file("index.html", "text/html; charset=utf-8")
        return super().do_GET()

    def serve_file(self, name, ctype):
        path = os.path.join(ROOT, name)
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def query(self, parsed):
        q = parse_qs(parsed.query)
        return {k: v[0] if v else "" for k, v in q.items()}

    def handle_api(self, parsed):
        q = self.query(parsed)
        server = (q.get("server") or "").rstrip("/")
        user = q.get("username") or ""
        password = q.get("password") or ""
        if not server or not user or not password:
            return self.json_err(400, "missing credentials")
        action = q.get("action") or ""
        url = f"{server}/player_api.php?username={user}&password={password}"
        if action:
            url += f"&action={action}"
        for key in ("category_id", "stream_id", "vod_id", "series_id", "limit"):
            if q.get(key):
                url += f"&{key}={q[key]}"
        try:
            with fetch(url) as resp:
                raw = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except HTTPError as e:
            body = e.read() if e.fp else b""
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(body or json.dumps({"error": str(e)}).encode())
        except Exception as e:
            self.json_err(502, str(e))

    def handle_fetch(self, parsed):
        q = self.query(parsed)
        target = unquote(q.get("url") or "")
        if not target.startswith("http"):
            return self.json_err(400, "bad url")
        try:
            with fetch(target, timeout=45) as resp:
                raw = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except Exception as e:
            self.json_err(502, str(e))

    def handle_stream(self, parsed):
        q = self.query(parsed)
        server = (q.get("server") or "").rstrip("/")
        user = q.get("username") or ""
        password = q.get("password") or ""
        kind = q.get("kind") or "live"
        sid = q.get("id") or ""
        ext = (q.get("ext") or "m3u8").lstrip(".")
        direct = q.get("url")
        if direct:
            target = unquote(direct)
        else:
            folder = {"live": "live", "movie": "movie", "series": "series"}.get(kind, "live")
            target = f"{server}/{folder}/{user}/{password}/{sid}.{ext}"
        try:
            self.proxy_media(target, server)
        except HTTPError as e:
            # fallback: live without folder / ts instead of m3u8
            if kind == "live" and ext == "m3u8":
                alt = f"{server}/live/{user}/{password}/{sid}.ts"
                try:
                    return self.proxy_media(alt, server)
                except Exception:
                    pass
            self.send_response(e.code)
            self.end_headers()
        except Exception as e:
            self.json_err(502, str(e))

    def proxy_media(self, target, server):
        req = Request(target, headers={"User-Agent": "IPTV-Xtream/1.0", "Accept": "*/*"})
        resp = urlopen(req, timeout=40, context=CTX)
        ctype = resp.headers.get("Content-Type", "application/octet-stream")
        data_header = resp.peek() if hasattr(resp, "peek") else b""
        is_playlist = "mpegurl" in ctype.lower() or target.endswith(".m3u8")
        self.send_response(200)
        if is_playlist:
            raw = resp.read()
            text = raw.decode("utf-8", "ignore")
            rewritten = []
            for line in text.splitlines():
                if line and not line.startswith("#"):
                    abs_url = urljoin(target, line.strip())
                    proxied = f"/stream?url={quote(abs_url, safe='')}"
                    rewritten.append(proxied)
                else:
                    rewritten.append(line)
            out = ("\n".join(rewritten) + "\n").encode("utf-8")
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        else:
            self.send_header("Content-Type", ctype)
            length = resp.headers.get("Content-Length")
            if length:
                self.send_header("Content-Length", length)
            self.end_headers()
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        resp.close()

    def json_err(self, code, msg):
        raw = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main():
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"IPTV اكستريم شغال على http://127.0.0.1:{PORT}")
    print("من نفس الشبكة: http://IP-الكمبيوتر:%s" % PORT)
    print("من أي مكان: نزّل ngrok وبعدين: ngrok http %s" % PORT)
    print("افتح الرابط في Chrome أو Safari.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nتم الإيقاف")


if __name__ == "__main__":
    main()
