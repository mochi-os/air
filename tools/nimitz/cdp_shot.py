#!/usr/bin/env python3
"""CDP-driven furball capture — real-time replacement for the --virtual-time-budget
one-shot, which Chrome 141 broke (virtual time now expires before the first canvas
paint; --enable-unsafe-swiftshader is also required for software WebGL at all).

Waits a real-time window (assets load + a few frames) then captures. All furball dev
query hooks require developer=1; &fly=1 skips the menu into a mission. The engine's
&probe=x,y hook prints the model coordinate/material under a viewport pixel on the dev HUD.

Usage: cdp_shot.py "<query-string>" <out.png> [wait-s]

IMPORTANT: chrome leaks a temp profile + process per run if the SIGTERM misses; a pileup
exhausts the sandbox (bwrap fails on `true`). If captures start failing, pkill -9 -f chrome
and rm -rf /tmp/cdpshot* before retrying.
"""
import json, subprocess, sys, threading, time, http.client, urllib.request, base64, tempfile, os, signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import websocket

ROOT = Path("/home/alistair/mochi")
UP = ("localhost", 8081)
PORT = 18099
DEBUG_PORT = 18123

sess = subprocess.check_output([str(ROOT/"claude/scripts/get-token.sh"), "admin", "1"]).decode().strip()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self): self.fwd("GET")
    def do_POST(self): self.fwd("POST")
    def fwd(self, method):
        body = None
        n = int(self.headers.get("Content-Length") or 0)
        if n: body = self.rfile.read(n)
        c = http.client.HTTPConnection(*UP, timeout=30)
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "cookie", "accept-encoding")}
        hdrs["Cookie"] = f"session={sess}"
        hdrs["Host"] = f"{UP[0]}:{UP[1]}"
        c.request(method, self.path, body=body, headers=hdrs)
        r = c.getresponse()
        data = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() in ("transfer-encoding", "content-length", "connection"): continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def main():
    query, out = sys.argv[1], sys.argv[2]
    wait_s = float(sys.argv[3]) if len(sys.argv) > 3 else 150.0
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/furball/?{query}"
    prof = tempfile.mkdtemp(prefix="cdpshot")
    chrome = subprocess.Popen(["google-chrome", "--headless=new", "--disable-gpu",
        "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox",
        f"--remote-debugging-port={DEBUG_PORT}", "--remote-allow-origins=*", f"--user-data-dir={prof}",
        "--window-size=1920,1080", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=2))
                break
            except Exception:
                time.sleep(0.3)
        req = urllib.request.Request(f"http://127.0.0.1:{DEBUG_PORT}/json/new?{urllib.request.quote(url, safe='')}", method="PUT")
        page = json.load(urllib.request.urlopen(req, timeout=10))
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=wait_s+30)
        mid = [0]
        def send(method, params=None):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
            return mid[0]
        send("Runtime.enable"); send("Page.enable")
        loaded = False
        t0 = time.time()
        deadline = t0 + wait_s
        while time.time() < deadline:
            ws.settimeout(max(1.0, deadline - time.time()))
            try:
                msg = json.loads(ws.recv())
            except Exception:
                break
            if msg.get("method") == "Runtime.consoleAPICalled":
                args = msg["params"].get("args", [])
                text = " ".join(str(a.get("value", "")) for a in args)
                if text.strip():
                    print(f"  [console +{time.time()-t0:5.1f}s] {text[:200]}", flush=True)
                if "[load]" in text:
                    loaded = True
                    break
        if not loaded:
            print("  WARNING: no [load] line before deadline — capturing anyway", flush=True)
        time.sleep(6)   # a few real swiftshader frames so the readout/HUD settle
        cid = send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        ws.settimeout(60)
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == cid:
                open(out, "wb").write(base64.b64decode(msg["result"]["data"]))
                break
        print(out, os.path.getsize(out), flush=True)
    finally:
        chrome.send_signal(signal.SIGTERM)
        try: chrome.wait(timeout=5)
        except Exception: chrome.kill()
        srv.shutdown()

main()
