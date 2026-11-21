"""Authenticated localhost:PORT reverse proxy for Zero-G Mobile & Desktop Aux Pane Preview."""

from __future__ import annotations

import html
import json
import re
import socket
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

DEFAULT_DEV_PORTS: list[int] = [
    3000,
    3001,
    4173,
    4200,
    5000,
    5173,
    5174,
    8000,
    8080,
    8888,
    9000,
]

DEV_PORT_LABELS: dict[int, str] = {
    3000: "Web Dev / Next / React (3000)",
    3001: "Web Dev Server (3001)",
    4173: "Vite Preview (4173)",
    4200: "Angular / Web Dev (4200)",
    5000: "Flask / Web Server (5000)",
    5173: "Vite Dev Server (5173)",
    5174: "Vite Dev Alt (5174)",
    8000: "FastAPI / Python Dev (8000)",
    8080: "HTTP Dev Server (8080)",
    8888: "Jupyter / Dev Server (8888)",
    9000: "Dev Service (9000)",
}

_HOP_BY_HOP_REQ_HEADERS: frozenset[str] = frozenset(
    {
        "host",
        "connection",
        "keep-alive",
        "content-length",
        "transfer-encoding",
        "accept-encoding",
        "cookie",
        "upgrade",
        "proxy-connection",
        "x-0g-bridge-token",
        "x-0g-token",
        "authorization",
    }
)

_HOP_BY_HOP_RESP_HEADERS: frozenset[str] = frozenset(
    {
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "x-frame-options",
    }
)

_STRIP_QUERY_KEYS: frozenset[str] = frozenset({"token", "qrtoken"})

_HEAD_OPEN_RE = re.compile(r"(<head(?:\s[^>]*)?>)", re.IGNORECASE)
_BASE_TAG_RE = re.compile(r"<base\b", re.IGNORECASE)
_ROOT_REL_ATTR_RE = re.compile(
    r'(\b(?:href|src|action)\s*=\s*["\'])/(?!/|preview/)',
    re.IGNORECASE,
)


def validate_preview_port(port: int, zerog_port: int = 8790) -> tuple[bool, str]:
    """Validate that a preview port is within 1024..65535 and is not the Zero-G daemon port."""
    if isinstance(port, bool) or not isinstance(port, int):
        try:
            port = int(port)
        except (TypeError, ValueError):
            return False, "Port must be an integer between 1024 and 65535"

    if port < 1024 or port > 65535:
        return False, f"Port {port} is outside the allowed unprivileged range (1024-65535)"

    if port == zerog_port:
        return False, f"Port {port} is reserved for the Zero-G Bridge Daemon (self-proxy loop forbidden)"

    return True, ""


def _probe_tcp_port(port: int, timeout: float = 0.08) -> bool:
    """Fast loopback TCP connect check to see if a local dev port is accepting connections."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _probe_default_dev_ports(zerog_port: int = 8790, timeout: float = 0.08) -> list[dict[str, Any]]:
    candidates = [p for p in DEFAULT_DEV_PORTS if validate_preview_port(p, zerog_port=zerog_port)[0]]
    if not candidates:
        return []
    active: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(len(candidates), 8)) as pool:
        results = list(pool.map(lambda p: (p, _probe_tcp_port(p, timeout=timeout)), candidates))
    for port, is_open in results:
        if is_open:
            active.append(
                {
                    "port": port,
                    "label": DEV_PORT_LABELS.get(port, f"Local Dev ({port})"),
                    "process": "localhost",
                    "previewUrl": f"/preview/{port}/",
                }
            )
    return active


def list_active_dev_ports(host_telemetry: Any = None, zerog_port: int = 8790) -> list[dict[str, Any]]:
    """Return active localhost dev ports from HostTelemetry or fast loopback TCP probes."""
    raw_ports: list[Any] | None = None

    if host_telemetry is not None:
        try:
            snap = host_telemetry.snapshot() if hasattr(host_telemetry, "snapshot") else host_telemetry
            if hasattr(snap, "listeningPorts"):
                raw_ports = list(getattr(snap, "listeningPorts") or [])
            elif isinstance(snap, dict) and "listeningPorts" in snap:
                raw_ports = list(snap.get("listeningPorts") or [])
        except Exception:
            raw_ports = None

    if raw_ports is None:
        return _probe_default_dev_ports(zerog_port=zerog_port)

    seen_ports: set[int] = set()
    entries: list[dict[str, Any]] = []

    for item in raw_ports:
        if isinstance(item, dict):
            p_raw = item.get("port")
            raw_label = item.get("label")
            raw_proc = item.get("process")
            raw_pid = item.get("pid")
        else:
            p_raw = getattr(item, "port", None)
            raw_label = getattr(item, "label", None)
            raw_proc = getattr(item, "process", None)
            raw_pid = getattr(item, "pid", None)

        try:
            p = int(p_raw)
        except (TypeError, ValueError):
            continue

        ok, _ = validate_preview_port(p, zerog_port=zerog_port)
        if not ok or p in seen_ports:
            continue
        seen_ports.add(p)

        label = str(raw_label).strip() if raw_label else DEV_PORT_LABELS.get(p, f"Local Server ({p})")
        if raw_proc:
            proc_str = str(raw_proc).strip()
        elif raw_pid:
            proc_str = f"PID {raw_pid}"
        else:
            proc_str = "localhost"

        entries.append(
            {
                "port": p,
                "label": label,
                "process": proc_str,
                "previewUrl": f"/preview/{p}/",
            }
        )

    entries.sort(key=lambda e: (e["port"] not in DEV_PORT_LABELS, e["port"]))
    return entries


def _rewrite_location_header(location: str, port: int) -> str:
    """Rewrite upstream Location headers to stay inside /preview/{port}/."""
    loc = (location or "").strip()
    if not loc:
        return loc

    prefix = f"/preview/{port}/"
    for origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
        if loc.lower() == origin:
            return prefix
        if loc.lower().startswith(origin + "/"):
            rest = loc[len(origin) + 1 :]
            return f"{prefix}{rest}"

    if loc.startswith("/") and not loc.startswith("//") and not loc.startswith(f"/preview/{port}"):
        return f"{prefix}{loc.lstrip('/')}"

    return loc


def rewrite_html_for_preview(html_bytes: bytes, port: int) -> bytes:
    """Inject <base href="/preview/{port}/"> and rewrite root-relative asset attributes."""
    text = html_bytes.decode("utf-8", errors="replace")
    base_tag = f'<base href="/preview/{port}/">'

    if not _BASE_TAG_RE.search(text):
        if _HEAD_OPEN_RE.search(text):
            text = _HEAD_OPEN_RE.sub(rf"\1{base_tag}", text, count=1)
        else:
            text = f"{base_tag}\n{text}"

    text = _ROOT_REL_ATTR_RE.sub(rf"\1/preview/{port}/", text)
    return text.encode("utf-8")


def _strip_auth_token_from_query(query_string: str) -> str:
    """Remove Zero-G auth tokens from query string before forwarding to local dev app."""
    raw_qs = (query_string or "").lstrip("?")
    if not raw_qs:
        return ""
    pairs = urllib.parse.parse_qsl(raw_qs, keep_blank_values=True)
    filtered = [(k, v) for (k, v) in pairs if k.lower() not in _STRIP_QUERY_KEYS]
    return urllib.parse.urlencode(filtered, doseq=True)


async def proxy_localhost_request(
    port: int,
    full_path: str,
    method: str,
    query_string: str,
    headers: dict[str, str],
    body: bytes,
    zerog_port: int = 8790,
) -> tuple[int, dict[str, str], bytes]:
    """Forward an HTTP request to http://127.0.0.1:{port}/{full_path} and rewrite response for iframe preview."""
    ok, err_reason = validate_preview_port(port, zerog_port=zerog_port)
    if not ok:
        err_payload = json.dumps({"ok": False, "detail": err_reason, "error": err_reason}).encode("utf-8")
        return 400, {"content-type": "application/json"}, err_payload

    clean_path = (full_path or "").lstrip("/")
    target_url = f"http://127.0.0.1:{port}/{clean_path}"
    clean_qs = _strip_auth_token_from_query(query_string)
    if clean_qs:
        target_url = f"{target_url}?{clean_qs}"

    forward_headers: dict[str, str] = {}
    for k, v in (headers or {}).items():
        if k.lower() not in _HOP_BY_HOP_REQ_HEADERS:
            forward_headers[k] = v

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=15.0) as client:
            upstream = await client.request(
                method=(method or "GET").upper(),
                url=target_url,
                headers=forward_headers,
                content=body if body else None,
            )
    except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as exc:
        safe_exc = html.escape(str(exc))
        err_html = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>Preview Unavailable (127.0.0.1:{port})</title></head>"
            "<body style='font-family:system-ui,sans-serif;padding:24px;'>"
            f"<h2>Local Dev Server Not Responding on <code>127.0.0.1:{port}</code></h2>"
            f"<p>Could not connect to <code>http://127.0.0.1:{port}/{html.escape(clean_path)}</code>.</p>"
            f"<pre style='opacity:0.75'>{safe_exc}</pre>"
            "</body></html>"
        ).encode("utf-8")
        return 502, {"content-type": "text/html; charset=utf-8"}, err_html

    resp_headers: dict[str, str] = {}
    content_type = ""
    for k, v in upstream.headers.items():
        k_low = k.lower()
        if k_low in _HOP_BY_HOP_RESP_HEADERS:
            continue
        if k_low == "location":
            resp_headers[k] = _rewrite_location_header(v, port)
        else:
            resp_headers[k] = v
        if k_low == "content-type":
            content_type = v

    resp_body = upstream.content
    if "text/html" in content_type.lower() and resp_body:
        resp_body = rewrite_html_for_preview(resp_body, port)

    return int(upstream.status_code), resp_headers, resp_body
