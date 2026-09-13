"""Cloud Run wrapper: supervise a child and expose separate live/ready probes.

Usage: python worker_health.py celery -A app.l4_agents.tasks worker
       python worker_health.py python -m app.l4_agents.worker
"""
import os
import signal
import subprocess
import sys
import threading
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

child = None


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/metrics':
            from prometheus_client import CollectorRegistry, multiprocess, generate_latest, CONTENT_TYPE_LATEST
            registry = CollectorRegistry()
            multiprocess.MultiProcessCollector(registry)
            self.send_response(200)
            self.send_header('Content-Type', CONTENT_TYPE_LATEST)
            self.end_headers()
            self.wfile.write(generate_latest(registry))
            return
        if self.path not in ('/health', '/ready'):
            self.send_error(404)
            return
        alive = child is not None and child.poll() is None
        status, body = (200, b'ok') if alive else (503, b'worker unavailable')
        if alive and self.path == '/ready':
            from app.readiness import readiness
            result = readiness()
            status, body = result.status_code, result.body
        self.send_response(status)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    global child
    if len(sys.argv) < 2:
        raise SystemExit('Pass a worker command, including its executable')
    from app.schema import verify_schema
    verify_schema()
    command = sys.argv[1:]
    if command[0] == '-m':
        command.insert(0, sys.executable)
    server = ThreadingHTTPServer(('', int(os.environ.get('PORT', '8080'))), HealthHandler)
    metric_dir = tempfile.TemporaryDirectory(prefix="orgsense-worker-metrics-")
    os.environ["PROMETHEUS_MULTIPROC_DIR"] = metric_dir.name
    child = subprocess.Popen(command)
    def forward(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        return child.wait()
    finally:
        server.shutdown()
        server.server_close()
        metric_dir.cleanup()


if __name__ == '__main__':
    sys.exit(main())
