"""Serves the repo on 127.0.0.1 with CORS, so test pages (and a devtools
snippet on the maker portal) can load the extension's files."""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5290
root = Path(__file__).resolve().parent.parent
ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(root))).serve_forever()
