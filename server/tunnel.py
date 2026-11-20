"""Hotspot-safe outbound tunnel supervisor (Cloudflare Tunnel / Tailscale Serve) + pure-Python QR SVG."""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from server.contracts import TunnelBackend

logger = logging.getLogger("0g.tunnel")

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

_TRYCLOUDFLARE_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
_HTTPS_URL_RE = re.compile(r"https://[A-Za-z0-9._-]+(?::\d+)?(?:/[^\s\"']*)?")

WINGET_CLOUDFLARED = "winget install Cloudflare.cloudflared"
WINGET_TAILSCALE = "winget install Tailscale.Tailscale"


def _resolve_binary(name: str, extra_candidates: list[str]) -> str | None:
    """Resolve an executable from PATH or common Windows install locations."""
    found = shutil.which(name)
    if found:
        return found
    for pattern in extra_candidates:
        if "*" in pattern:
            matches = sorted(glob.glob(pattern, recursive=True))
            for m in matches:
                if os.path.isfile(m):
                    return m
        elif os.path.isfile(pattern):
            return pattern
    return None


def _resolve_cloudflared() -> str | None:
    local_app = os.environ.get("LOCALAPPDATA", "")
    prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    prog_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    candidates = [
        str(Path.home() / ".0g" / "bin" / "cloudflared.exe"),
        os.path.join(prog_files_x86, "cloudflared", "cloudflared.exe"),
        os.path.join(prog_files, "cloudflared", "cloudflared.exe"),
        os.path.join(local_app, "Microsoft", "WinGet", "Links", "cloudflared.exe"),
        os.path.join(local_app, "Microsoft", "WinGet", "Packages", "Cloudflare.cloudflared*", "**", "cloudflared.exe"),
    ]
    return _resolve_binary("cloudflared", candidates)


def _resolve_tailscale() -> str | None:
    local_app = os.environ.get("LOCALAPPDATA", "")
    prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    candidates = [
        os.path.join(prog_files, "Tailscale", "tailscale.exe"),
        os.path.join(local_app, "Microsoft", "WinGet", "Links", "tailscale.exe"),
    ]
    return _resolve_binary("tailscale", candidates)


# ---------------------------------------------------------------------------
# Pure-Python ISO/IEC 18004 QR Code Encoder (Byte Mode, EC Level M, V1..V10)
# ---------------------------------------------------------------------------

_GF_EXP = [0] * 512
_GF_LOG = [0] * 256


def _init_gf256() -> None:
    x = 1
    for i in range(255):
        _GF_EXP[i] = x
        _GF_LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _GF_EXP[i] = _GF_EXP[i - 255]


_init_gf256()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_poly(ec_len: int) -> list[int]:
    poly = [1]
    for i in range(ec_len):
        nxt = [0] * (len(poly) + 1)
        factor = _GF_EXP[i]
        for j, coeff in enumerate(poly):
            nxt[j] ^= coeff
            nxt[j + 1] ^= _gf_mul(coeff, factor)
        poly = nxt
    return poly


def _rs_encode(data: list[int], ec_len: int) -> list[int]:
    gen = _rs_generator_poly(ec_len)
    buf = list(data) + [0] * ec_len
    for i in range(len(data)):
        coef = buf[i]
        if coef != 0:
            for j in range(1, len(gen)):
                buf[i + j] ^= _gf_mul(gen[j], coef)
    return buf[len(data) :]


# Version -> list of (block_count, data_codewords_per_block, ec_codewords_per_block) for EC Level M
_QR_M_SPECS: dict[int, list[tuple[int, int, int]]] = {
    1: [(1, 16, 10)],
    2: [(1, 28, 16)],
    3: [(1, 44, 26)],
    4: [(2, 32, 18)],
    5: [(2, 43, 24)],
    6: [(4, 27, 16)],
    7: [(4, 31, 18)],
    8: [(2, 38, 22), (2, 39, 22)],
    9: [(3, 36, 22), (2, 37, 22)],
    10: [(4, 43, 26), (1, 44, 26)],
}

_ALIGNMENT_CENTERS: dict[int, list[int]] = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
}


def _select_qr_version(byte_len: int) -> int:
    for ver in range(1, 11):
        data_cw = sum(cnt * d for cnt, d, _ in _QR_M_SPECS[ver])
        count_bits = 8 if ver <= 9 else 16
        capacity_bytes = (data_cw * 8 - 4 - count_bits) // 8
        if byte_len <= capacity_bytes:
            return ver
    raise ValueError(f"Payload too large ({byte_len} bytes) for QR V1..V10 Level M")


def _encode_qr_codewords(payload: bytes, ver: int) -> list[int]:
    spec = _QR_M_SPECS[ver]
    total_data_cw = sum(cnt * d for cnt, d, _ in spec)
    count_bits = 8 if ver <= 9 else 16

    bits: list[int] = []

    def _push_bits(val: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            bits.append((val >> shift) & 1)

    _push_bits(0b0100, 4)  # Byte mode
    _push_bits(len(payload), count_bits)
    for b in payload:
        _push_bits(b, 8)

    max_data_bits = total_data_cw * 8
    terminator = min(4, max_data_bits - len(bits))
    bits.extend([0] * terminator)
    while len(bits) % 8 != 0:
        bits.append(0)

    pad_bytes = [0xEC, 0x11]
    pad_idx = 0
    while len(bits) < max_data_bits:
        _push_bits(pad_bytes[pad_idx % 2], 8)
        pad_idx += 1

    data_cw = [
        sum(bits[i + j] << (7 - j) for j in range(8))
        for i in range(0, max_data_bits, 8)
    ]

    # Split into RS blocks
    data_blocks: list[list[int]] = []
    ec_blocks: list[list[int]] = []
    offset = 0
    for cnt, d_len, ec_len in spec:
        for _ in range(cnt):
            blk = data_cw[offset : offset + d_len]
            offset += d_len
            data_blocks.append(blk)
            ec_blocks.append(_rs_encode(blk, ec_len))

    # Interleave data codewords, then EC codewords
    interleaved: list[int] = []
    max_d = max(len(b) for b in data_blocks)
    for i in range(max_d):
        for blk in data_blocks:
            if i < len(blk):
                interleaved.append(blk[i])
    max_ec = max(len(b) for b in ec_blocks)
    for i in range(max_ec):
        for blk in ec_blocks:
            if i < len(blk):
                interleaved.append(blk[i])
    return interleaved


def _format_info_bits(mask_id: int) -> int:
    # EC level M = 0b00
    data = (0b00 << 3) | (mask_id & 0x7)
    rem = data << 10
    for shift in range(4, -1, -1):
        if rem & (1 << (shift + 10)):
            rem ^= 0x537 << shift
    return ((data << 10) | rem) ^ 0x5412


def _version_info_bits(ver: int) -> int:
    rem = ver << 12
    for shift in range(5, -1, -1):
        if rem & (1 << (shift + 12)):
            rem ^= 0x1F25 << shift
    return (ver << 12) | rem


def _build_qr_matrix(text: str) -> list[list[int]]:
    payload = text.encode("utf-8")
    ver = _select_qr_version(len(payload))
    codewords = _encode_qr_codewords(payload, ver)

    size = 17 + 4 * ver
    grid: list[list[int | None]] = [[None] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    def _set_func(r: int, c: int, val: int) -> None:
        if 0 <= r < size and 0 <= c < size:
            grid[r][c] = val
            reserved[r][c] = True

    def _place_finder(top: int, left: int) -> None:
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                r, c = top + dr, left + dc
                if not (0 <= r < size and 0 <= c < size):
                    continue
                if dr in (-1, 7) or dc in (-1, 7):
                    _set_func(r, c, 0)
                elif dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4):
                    _set_func(r, c, 1)
                else:
                    _set_func(r, c, 0)

    _place_finder(0, 0)
    _place_finder(0, size - 7)
    _place_finder(size - 7, 0)

    # Timing patterns
    for i in range(8, size - 8):
        bit = 1 if i % 2 == 0 else 0
        _set_func(6, i, bit)
        _set_func(i, 6, bit)

    # Alignment patterns
    centers = _ALIGNMENT_CENTERS[ver]
    for cr in centers:
        for cc in centers:
            if (cr <= 8 and cc <= 8) or (cr <= 8 and cc >= size - 8) or (cr >= size - 8 and cc <= 8):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    val = 1 if (abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0)) else 0
                    _set_func(cr + dr, cc + dc, val)

    # Dark module
    _set_func(size - 8, 8, 1)

    # Reserve format info areas
    for i in range(9):
        if i != 6:
            reserved[8][i] = True
            reserved[i][8] = True
    for i in range(size - 8, size):
        reserved[8][i] = True
    for i in range(size - 7, size):
        reserved[i][8] = True

    # Version info (V >= 7)
    if ver >= 7:
        vbits = _version_info_bits(ver)
        for i in range(18):
            bit = (vbits >> i) & 1
            r = i // 3
            c = size - 11 + (i % 3)
            _set_func(r, c, bit)
            _set_func(c, r, bit)

    # Place data bits in zig-zag order
    bit_stream: list[int] = []
    for cw in codewords:
        for shift in range(7, -1, -1):
            bit_stream.append((cw >> shift) & 1)

    bit_idx = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for row in rows:
            for dc in (0, -1):
                c = col + dc
                if not reserved[row][c]:
                    grid[row][c] = bit_stream[bit_idx] if bit_idx < len(bit_stream) else 0
                    bit_idx += 1
        upward = not upward
        col -= 2

    def _mask_cond(mask_id: int, r: int, c: int) -> bool:
        if mask_id == 0:
            return (r + c) % 2 == 0
        if mask_id == 1:
            return r % 2 == 0
        if mask_id == 2:
            return c % 3 == 0
        if mask_id == 3:
            return (r + c) % 3 == 0
        if mask_id == 4:
            return ((r // 2) + (c // 3)) % 2 == 0
        if mask_id == 5:
            return ((r * c) % 2) + ((r * c) % 3) == 0
        if mask_id == 6:
            return (((r * c) % 2) + ((r * c) % 3)) % 2 == 0
        return (((r + c) % 2) + ((r * c) % 3)) % 2 == 0

    def _apply_format(mat: list[list[int]], mask_id: int) -> None:
        fmt = _format_info_bits(mask_id)
        # Around top-left
        coords_tl = [
            (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
            (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
        ]
        for idx, (r, c) in enumerate(coords_tl):
            mat[r][c] = (fmt >> (14 - idx)) & 1
        # Split bottom-left & top-right
        for idx in range(7):
            mat[size - 1 - idx][8] = (fmt >> (14 - idx)) & 1
        for idx in range(8):
            mat[8][size - 8 + idx] = (fmt >> (7 - idx)) & 1

    def _penalty(mat: list[list[int]]) -> int:
        score = 0
        # N1: runs of 5+ same color in rows and cols
        for r in range(size):
            run = 1
            for c in range(1, size):
                if mat[r][c] == mat[r][c - 1]:
                    run += 1
                    if run == 5:
                        score += 3
                    elif run > 5:
                        score += 1
                else:
                    run = 1
        for c in range(size):
            run = 1
            for r in range(1, size):
                if mat[r][c] == mat[r - 1][c]:
                    run += 1
                    if run == 5:
                        score += 3
                    elif run > 5:
                        score += 1
                else:
                    run = 1
        # N2: 2x2 blocks
        for r in range(size - 1):
            for c in range(size - 1):
                v = mat[r][c]
                if v == mat[r][c + 1] == mat[r + 1][c] == mat[r + 1][c + 1]:
                    score += 3
        # N3: finder-like 1:1:3:1:1 patterns
        pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
        pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
        for r in range(size):
            row_vals = mat[r]
            for c in range(size - 10):
                seg = row_vals[c : c + 11]
                if seg == pat1 or seg == pat2:
                    score += 40
        for c in range(size):
            for r in range(size - 10):
                seg = [mat[r + k][c] for k in range(11)]
                if seg == pat1 or seg == pat2:
                    score += 40
        # N4: dark ratio balance
        dark = sum(sum(row) for row in mat)
        pct = (dark * 100) // (size * size)
        prev5 = abs((pct // 5) * 5 - 50) // 5
        next5 = abs(((pct // 5) * 5 + 5) - 50) // 5
        score += min(prev5, next5) * 10
        return score

    best_mat: list[list[int]] | None = None
    best_score = 10**9
    for mask_id in range(8):
        cand = [
            [
                (1 - (grid[r][c] or 0)) if (not reserved[r][c] and _mask_cond(mask_id, r, c)) else (grid[r][c] or 0)
                for c in range(size)
            ]
            for r in range(size)
        ]
        _apply_format(cand, mask_id)
        sc = _penalty(cand)
        if sc < best_score:
            best_score = sc
            best_mat = cand

    assert best_mat is not None
    return best_mat


def generate_qr_svg(data: str, fg: str = "#09090B", bg: str = "#FFFFFF", margin: int = 4) -> str:
    """Generate a crisp, scannable ISO/IEC 18004 QR code SVG without external dependencies."""
    if not data:
        data = "http://127.0.0.1:8790"

    # Prefer qrcode or segno if installed, otherwise use exact pure-Python GF(256) QR encoder
    try:
        import qrcode  # type: ignore[import-not-found]

        qr = qrcode.QRCode(border=margin, box_size=1)
        qr.add_data(data)
        qr.make(fit=True)
        matrix = [[1 if cell else 0 for cell in row] for row in qr.get_matrix()]
        # qrcode.get_matrix() already includes border; compute inner size
        total = len(matrix)
        paths = []
        for r in range(total):
            for c in range(total):
                if matrix[r][c]:
                    paths.append(f"M{c},{r}h1v1h-1z")
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
            f'shape-rendering="crispEdges" role="img" aria-label="0G Pairing QR Code">'
            f'<rect width="{total}" height="{total}" fill="{bg}"/>'
            f'<path d="{"".join(paths)}" fill="{fg}"/></svg>'
        )
    except Exception:
        pass

    matrix = _build_qr_matrix(data)
    size = len(matrix)
    total = size + margin * 2
    paths: list[str] = []
    for r in range(size):
        row = matrix[r]
        c = 0
        while c < size:
            if row[c]:
                start = c
                while c < size and row[c]:
                    c += 1
                width = c - start
                paths.append(f"M{start + margin},{r + margin}h{width}v1h-{width}z")
            else:
                c += 1

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        f'shape-rendering="crispEdges" role="img" aria-label="0G Pairing QR Code">'
        f'<rect width="{total}" height="{total}" fill="{bg}"/>'
        f'<path d="{"".join(paths)}" fill="{fg}"/></svg>'
    )


class TunnelSupervisor:
    """Supervises hotspot-safe outbound tunnels (Cloudflare primary, Tailscale secondary, local_only)."""

    def __init__(self, local_port: int = 8790, power_governor: Any = None) -> None:
        self.local_port = int(local_port)
        self.power_governor = power_governor
        self.backend: TunnelBackend = "local_only"
        self.status: str = "stopped"  # stopped|starting|running|missing_binary|error
        self.public_url: str | None = f"http://127.0.0.1:{self.local_port}"
        self.error: str | None = None
        self.started_at: float | None = None

        self._proc: asyncio.subprocess.Process | None = None
        self._reader_tasks: list[asyncio.Task[Any]] = []
        self._recent_logs: list[str] = []
        self._lock = asyncio.Lock()

    @staticmethod
    def binary_status() -> dict[str, Any]:
        cf_path = _resolve_cloudflared()
        ts_path = _resolve_tailscale()
        return {
            "cloudflare": {
                "available": bool(cf_path),
                "path": cf_path,
                "installCommand": WINGET_CLOUDFLARED,
            },
            "tailscale": {
                "available": bool(ts_path),
                "path": ts_path,
                "installCommand": WINGET_TAILSCALE,
            },
        }

    def get_status(self) -> dict[str, Any]:
        binaries = self.binary_status()
        install_cmd = None
        if self.backend == "cloudflare" and not binaries["cloudflare"]["available"]:
            install_cmd = WINGET_CLOUDFLARED
        elif self.backend == "tailscale" and not binaries["tailscale"]["available"]:
            install_cmd = WINGET_TAILSCALE

        return {
            "backend": self.backend,
            "status": self.status,
            "publicUrl": self.public_url,
            "localUrl": f"http://127.0.0.1:{self.local_port}",
            "cloudflaredInstalled": binaries["cloudflare"]["available"],
            "tailscaleInstalled": binaries["tailscale"]["available"],
            "binaries": binaries,
            "installCommand": install_cmd,
            "installHint": install_cmd,
            "qrSvg": self.generate_qr_svg(),
            "error": self.error,
            "startedAt": self.started_at,
            "recentLogs": self._recent_logs[-12:],
        }

    def generate_qr_svg(self, url: str | None = None, fg: str = "#09090B", bg: str = "#FFFFFF") -> str:
        target = url or self.public_url or f"http://127.0.0.1:{self.local_port}"
        return generate_qr_svg(target, fg=fg, bg=bg)

    async def start(
        self,
        backend: TunnelBackend = "cloudflare",
        token: str | None = None,
        wait_url_sec: float = 12.0,
    ) -> dict[str, Any]:
        """Start the requested outbound tunnel backend cleanly."""
        async with self._lock:
            await self._stop_unlocked()
            self.backend = backend
            self.error = None
            self._recent_logs.clear()

            if backend == "local_only":
                self.status = "running"
                self.public_url = f"http://127.0.0.1:{self.local_port}"
                self.started_at = time.time()
                self._notify_governor(False)
                return self.get_status()

            if backend == "cloudflare":
                return await self._start_cloudflare(token=token, wait_url_sec=wait_url_sec)

            if backend == "tailscale":
                return await self._start_tailscale()

            self.status = "error"
            self.error = f"Unsupported tunnel backend: {backend}"
            return self.get_status()

    async def stop(self) -> dict[str, Any]:
        """Stop active tunnel subprocess or Tailscale Serve mapping."""
        async with self._lock:
            await self._stop_unlocked()
            return self.get_status()

    async def _stop_unlocked(self) -> None:
        for task in self._reader_tasks:
            task.cancel()
        self._reader_tasks.clear()

        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._proc.kill()
            except Exception:
                pass
        self._proc = None

        if self.backend == "tailscale":
            ts_exe = _resolve_tailscale()
            if ts_exe:
                try:
                    await asyncio.to_thread(
                        subprocess.run,
                        [ts_exe, "serve", "reset"],
                        capture_output=True,
                        timeout=4.0,
                        creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
                    )
                except Exception:
                    pass

        self.status = "stopped"
        self.started_at = None
        self.public_url = f"http://127.0.0.1:{self.local_port}"
        self._notify_governor(False)

    async def _start_cloudflare(self, token: str | None, wait_url_sec: float) -> dict[str, Any]:
        cf_exe = _resolve_cloudflared()
        if not cf_exe:
            self.status = "missing_binary"
            self.public_url = None
            self.error = f"cloudflared is not installed. Run: {WINGET_CLOUDFLARED}"
            return self.get_status()

        self.status = "starting"
        self.public_url = None
        self.started_at = time.time()

        env = os.environ.copy()
        if token and token.strip():
            # Pass named tunnel token via env so it never appears on process command line
            env["TUNNEL_TOKEN"] = token.strip()
            cmd = [cf_exe, "tunnel", "--no-autoupdate", "run"]
        else:
            cmd = [
                cf_exe,
                "tunnel",
                "--no-autoupdate",
                "--url",
                f"http://127.0.0.1:{self.local_port}",
            ]

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
            )
        except Exception as exc:
            self.status = "error"
            self.error = str(exc)
            return self.get_status()

        url_ready = asyncio.Event()
        if self._proc.stdout is not None:
            self._reader_tasks.append(asyncio.create_task(self._watch_cf_stream(self._proc.stdout, url_ready)))
        if self._proc.stderr is not None:
            self._reader_tasks.append(asyncio.create_task(self._watch_cf_stream(self._proc.stderr, url_ready)))

        if token and token.strip():
            await asyncio.sleep(1.5)
            if self._proc.returncode is None:
                self.status = "running"
                self._notify_governor(True)
            else:
                self.status = "error"
                self.error = f"cloudflared exited with code {self._proc.returncode}"
            return self.get_status()

        try:
            await asyncio.wait_for(url_ready.wait(), timeout=max(2.0, float(wait_url_sec)))
            self.status = "running"
            self._notify_governor(True)
        except asyncio.TimeoutError:
            if self._proc.returncode is not None:
                self.status = "error"
                self.error = f"cloudflared exited with code {self._proc.returncode}"
            else:
                self.status = "starting"
        return self.get_status()

    async def _watch_cf_stream(self, stream: asyncio.StreamReader, url_ready: asyncio.Event) -> None:
        try:
            while True:
                line_b = await stream.readline()
                if not line_b:
                    break
                line = line_b.decode("utf-8", errors="replace").strip()
                if line:
                    self._recent_logs.append(line)
                    if len(self._recent_logs) > 50:
                        self._recent_logs = self._recent_logs[-50:]
                    match = _TRYCLOUDFLARE_RE.search(line)
                    if match:
                        self.public_url = match.group(0)
                        self.status = "running"
                        url_ready.set()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("cloudflared stream watcher error: %s", exc)

    async def _start_tailscale(self) -> dict[str, Any]:
        ts_exe = _resolve_tailscale()
        if not ts_exe:
            self.status = "missing_binary"
            self.public_url = None
            self.error = f"tailscale is not installed. Run: {WINGET_TAILSCALE}"
            return self.get_status()

        self.status = "starting"
        self.started_at = time.time()

        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                [ts_exe, "serve", "--bg", f"http://127.0.0.1:{self.local_port}"],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=8.0,
                creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
            )
            if proc.returncode != 0:
                self.status = "error"
                self.error = (proc.stderr or proc.stdout).strip() or "tailscale serve failed"
                return self.get_status()

            combined = f"{proc.stdout}\n{proc.stderr}"
            match = _HTTPS_URL_RE.search(combined)
            if match:
                self.public_url = match.group(0).rstrip("/")
            else:
                self.public_url = await self._discover_tailscale_dns_url(ts_exe)

            self.status = "running"
            self._notify_governor(True)
            return self.get_status()
        except Exception as exc:
            self.status = "error"
            self.error = str(exc)
            return self.get_status()

    async def _discover_tailscale_dns_url(self, ts_exe: str) -> str | None:
        try:
            import json

            proc = await asyncio.to_thread(
                subprocess.run,
                [ts_exe, "status", "--json"],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=4.0,
                creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                data = json.loads(proc.stdout)
                dns_name = (data.get("Self") or {}).get("DNSName", "").rstrip(".")
                if dns_name:
                    return f"https://{dns_name}"
        except Exception:
            pass
        return None

    def _notify_governor(self, active: bool) -> None:
        if self.power_governor is not None and hasattr(self.power_governor, "set_tunnel_active"):
            try:
                self.power_governor.set_tunnel_active(active)
            except Exception:
                pass
