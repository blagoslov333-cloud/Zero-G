"""Egress secret redaction, Unicode BiDi/ANSI sanitizer, PowerShell decoder, and command AST parser."""

from __future__ import annotations

import base64
import math
import os
import re
from typing import Any

# ANSI escape sequences (CSI, OSC, and 2-byte escapes)
_ANSI_RE = re.compile(
    r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))"
)

# Unicode BiDi override and isolate characters (Trojan Source / spoofing protection)
_BIDI_RE = re.compile(r"[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]")

# Known secret patterns
_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "PEM_PRIVATE_KEY",
        re.compile(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
        ),
    ),
    (
        "ANTHROPIC_KEY",
        re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"),
    ),
    (
        "OPENAI_KEY",
        re.compile(r"\bsk-(?:proj-|svcacct-|live-|test-)?[A-Za-z0-9_-]{20,}\b"),
    ),
    (
        "GOOGLE_API_KEY",
        re.compile(r"\bAIza[0-9A-Za-z_-]{32,45}\b"),
    ),
    (
        "GITHUB_TOKEN",
        re.compile(r"\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,})\b"),
    ),
    (
        "XAI_KEY",
        re.compile(r"\bxai-[A-Za-z0-9_-]{16,}\b"),
    ),
    (
        "AWS_ACCESS_KEY",
        re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ),
    (
        "BEARER_TOKEN",
        re.compile(r"(?i)\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})"),
    ),
    (
        "ENV_SECRET_PAIR",
        re.compile(
            r"(?im)\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|BRIDGE_TOKEN)[A-Z0-9_]*\s*=\s*)(['\"]?)([^\s'\"#]{6,})\2"
        ),
    ),
]

# Candidate high-entropy token (>28 chars of hex/base64url without path separators)
_HIGH_ENTROPY_CANDIDATE_RE = re.compile(r"(?<![/\\A-Za-z0-9_.-])([A-Za-z0-9+/=_-]{29,})(?![/\\A-Za-z0-9_.-])")

# PowerShell -EncodedCommand / -enc / -e extractor
_PS_ENC_RE = re.compile(
    r"(?i)(?:^|\s)-(?:EncodedCommand|enc|e)\s+(['\"]?)([A-Za-z0-9+/=]{8,})\1"
)

# Command pipeline splitters (|, &&, ||, ;) outside quotes
_PIPELINE_SPLIT_RE = re.compile(r"""(\|\||&&|\||;)""")

# Network egress tools
_EGRESS_RE = re.compile(
    r"(?i)\b(curl(?:\.exe)?|iwr|Invoke-WebRequest|irm|Invoke-RestMethod|wget| bitsadmin|certutil\s+-urlcache|ssh|scp|nc|ncat)\b"
)

# Destructive command patterns
_DESTRUCTIVE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("rm -rf", re.compile(r"(?i)\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\b")),
    ("Remove-Item -Recurse", re.compile(r"(?i)\b(?:Remove-Item|ri|del|erase|rmdir|rd)\b[^\n|;&]*(?:-Recurse|-Force|/s|/q)")),
    ("format", re.compile(r"(?i)(?:^|[|;&\s])format(?:\.com|\.exe)?\s+[a-zA-Z]:")),
    ("reg delete", re.compile(r"(?i)\breg(?:\.exe)?\s+delete\b")),
    ("git push --force", re.compile(r"(?i)\bgit\s+push\b[^\n|;&]*(?:--force|-f\b)")),
    ("git reset --hard", re.compile(r"(?i)\bgit\s+reset\s+--hard\b")),
    ("git clean -fd", re.compile(r"(?i)\bgit\s+clean\b[^\n|;&]*-[a-zA-Z]*f")),
    ("diskpart / bcdedit", re.compile(r"(?i)\b(?:diskpart|bcdedit|cipher\s+/w|vssadmin\s+delete)\b")),
]

# Out-of-workspace / sensitive paths
_SENSITIVE_PATH_RE = re.compile(
    r"(?i)(?:[a-zA-Z]:[/\\](?:Windows|Program Files|Users[/\\][^/\\\s]+[/\\]\.(?:ssh|aws|gemini|0g|claude|codex|grok))|"
    r"~[/\\]\.(?:ssh|aws|gemini|0g|claude|codex|grok)|"
    r"/etc/(?:passwd|shadow|sudoers)|"
    r"\.\.[/\\]\.\.[/\\]|"
    r"\b(?:hooks\.json|bridge\.token|vapid_keys\.json|id_rsa|\.env(?:\.[a-zA-Z0-9_]+)?)\b)"
)

_SENSITIVE_DICT_KEY_RE = re.compile(
    r"(?i)(?:secret|password|passwd|api_?key|access_?token|auth_?token|private_?key|bridge_?token|client_?secret|credential)"
)

_ENV_SECRET_KEY_RE = re.compile(
    r"(?i)(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|AUTH)"
)


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    length = len(s)
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    return -sum((c / length) * math.log2(c / length) for c in counts.values())


def _looks_like_high_entropy_secret(token: str) -> bool:
    if len(token) <= 28:
        return False
    # Ignore obvious identifiers, words, or CamelCase names without digits
    has_digit = any(c.isdigit() for c in token)
    has_upper = any(c.isupper() for c in token)
    has_lower = any(c.islower() for c in token)
    if not has_digit:
        return False
    # Pure hex token > 28 chars
    if all(c in "0123456789abcdefABCDEF" for c in token):
        return _shannon_entropy(token) >= 3.3
    # Base64 / random mixed-case alnum token > 28 chars
    if has_digit and (has_upper or has_lower):
        # Skip common words with underscores if low entropy
        if token.count("_") >= 3 or token.count("-") >= 4:
            return _shannon_entropy(token) >= 4.35
        return _shannon_entropy(token) >= 4.15
    return False


def decode_powershell_encoded(cmd: str) -> str | None:
    """Extract and UTF-16LE base64-decode PowerShell -EncodedCommand / -enc payloads."""
    if not cmd or not isinstance(cmd, str):
        return None
    match = _PS_ENC_RE.search(cmd)
    if not match:
        return None
    b64_payload = match.group(2).strip()
    # Pad base64 if needed
    padding = (-len(b64_payload)) % 4
    if padding:
        b64_payload += "=" * padding
    try:
        raw = base64.b64decode(b64_payload, validate=False)
        if not raw:
            return None
        # PowerShell uses UTF-16LE by specification
        if b"\x00" in raw:
            decoded = raw.decode("utf-16le", errors="replace").strip("\x00").strip()
        else:
            decoded = raw.decode("utf-8", errors="replace").strip()
        return decoded if decoded else None
    except Exception:
        return None


def parse_command_ast(command: str, workspace_roots: list[str] | None = None) -> tuple[list[str], list[str]]:
    """Parse shell/PowerShell command into (ast_summary, risk_reasons)."""
    if not command or not isinstance(command, str):
        return ([], [])

    ast_summary: list[str] = []
    risk_reasons: list[str] = []

    # 1. Check encoded PowerShell payloads first and recursively inspect decoded payload
    decoded_ps = decode_powershell_encoded(command)
    inspection_targets = [command]
    if decoded_ps:
        ast_summary.append(f"encoded_powershell: {decoded_ps[:120]}")
        risk_reasons.append(f"Encoded PowerShell payload (-EncodedCommand): {decoded_ps[:120]}")
        inspection_targets.append(decoded_ps)

    # 2. Split pipeline segments
    parts = [p.strip() for p in _PIPELINE_SPLIT_RE.split(command) if p.strip()]
    operators: list[str] = []
    segments: list[str] = []
    for p in parts:
        if p in ("|", "&&", "||", ";"):
            operators.append(p)
        else:
            segments.append(p)

    for idx, seg in enumerate(segments):
        verb = seg.split()[0] if seg.split() else seg
        ast_summary.append(f"segment[{idx}]: {verb} ({seg[:80]})")

    if operators:
        op_list = ", ".join(sorted(set(operators)))
        ast_summary.append(f"pipeline_operators: {op_list}")
        risk_reasons.append(f"Chained command pipeline ({op_list}) with {len(segments)} segments")

    # 3. Inspect both raw command and any decoded payload for egress, destructive verbs, and paths
    for target in inspection_targets:
        egress_match = _EGRESS_RE.search(target)
        if egress_match:
            tool = egress_match.group(1)
            tag = f"egress: {tool}"
            if tag not in ast_summary:
                ast_summary.append(tag)
            reason = f"Network egress command detected ({tool})"
            if reason not in risk_reasons:
                risk_reasons.append(reason)

        for label, pat in _DESTRUCTIVE_PATTERNS:
            if pat.search(target):
                tag = f"destructive: {label}"
                if tag not in ast_summary:
                    ast_summary.append(tag)
                reason = f"Destructive command verb detected ({label})"
                if reason not in risk_reasons:
                    risk_reasons.append(reason)

        path_match = _SENSITIVE_PATH_RE.search(target)
        if path_match:
            matched_path = path_match.group(0)
            tag = f"path_outside_workspace: {matched_path}"
            if tag not in ast_summary:
                ast_summary.append(tag)
            reason = f"Out-of-workspace or protected path referenced ({matched_path})"
            if reason not in risk_reasons:
                risk_reasons.append(reason)

        # Also check explicit absolute Windows/Unix paths against workspace_roots if provided
        if workspace_roots:
            norm_roots = [os.path.normcase(os.path.abspath(r)) for r in workspace_roots if r]
            for candidate in re.findall(r"(?:[a-zA-Z]:[/\\][^\s'\"|;&]+|/[^\s'\"|;&]{3,})", target):
                if candidate.startswith("//") or candidate.startswith("http"):
                    continue
                try:
                    norm_cand = os.path.normcase(os.path.abspath(candidate))
                    if norm_roots and not any(norm_cand.startswith(r) for r in norm_roots):
                        tag = f"path_outside_workspace: {candidate}"
                        if tag not in ast_summary:
                            ast_summary.append(tag)
                        reason = f"Out-of-workspace path referenced ({candidate})"
                        if reason not in risk_reasons:
                            risk_reasons.append(reason)
                except Exception:
                    pass

    return (ast_summary, risk_reasons)


class EgressRedactor:
    """Strips ANSI/BiDi control sequences and masks secrets before any hook/WS/push egress."""

    def __init__(self, extra_secrets: list[str] | None = None) -> None:
        self._env_secrets: list[str] = []
        self.refresh_env_secrets(extra_secrets)

    def refresh_env_secrets(self, extra_secrets: list[str] | None = None) -> None:
        secrets_set: set[str] = set()
        for k, v in os.environ.items():
            if not v or len(v.strip()) < 8:
                continue
            if _ENV_SECRET_KEY_RE.search(k):
                val = v.strip()
                # Avoid masking common non-secret paths or booleans
                if val.lower() not in ("true", "false", "development", "production", "localhost") and not os.path.exists(val):
                    secrets_set.add(val)
        if extra_secrets:
            for s in extra_secrets:
                if s and len(s.strip()) >= 8:
                    secrets_set.add(s.strip())
        # Sort longest first so partial substrings don't leave tails
        self._env_secrets = sorted(secrets_set, key=len, reverse=True)

    def redact(self, text: str) -> tuple[str, bool]:
        if not text or not isinstance(text, str):
            return ("", False)

        was_redacted = False
        out = text

        # 1. Strip ANSI escape sequences
        if _ANSI_RE.search(out):
            out = _ANSI_RE.sub("", out)
            was_redacted = True

        # 2. Strip Unicode BiDi overrides
        if _BIDI_RE.search(out):
            out = _BIDI_RE.sub("", out)
            was_redacted = True

        # 3. Mask active process environment secret values (>= 8 chars)
        for env_val in self._env_secrets:
            if env_val in out:
                out = out.replace(env_val, "[REDACTED:ENV_SECRET]")
                was_redacted = True

        # 4. Mask known secret formats
        for label, pattern in _SECRET_PATTERNS:
            if label == "BEARER_TOKEN":
                def _repl_bearer(m: re.Match[str]) -> str:
                    nonlocal was_redacted
                    was_redacted = True
                    return f"{m.group(1)}[REDACTED:BEARER_TOKEN]"
                out = pattern.sub(_repl_bearer, out)
            elif label == "ENV_SECRET_PAIR":
                def _repl_env_pair(m: re.Match[str]) -> str:
                    nonlocal was_redacted
                    was_redacted = True
                    return f"{m.group(1)}{m.group(2)}[REDACTED:ENV_SECRET]{m.group(2)}"
                out = pattern.sub(_repl_env_pair, out)
            else:
                if pattern.search(out):
                    out = pattern.sub(f"[REDACTED:{label}]", out)
                    was_redacted = True

        # 5. Mask high-entropy base64/hex tokens (> 28 chars)
        def _repl_entropy(m: re.Match[str]) -> str:
            nonlocal was_redacted
            candidate = m.group(1)
            if "REDACTED" in candidate:
                return candidate
            if _looks_like_high_entropy_secret(candidate):
                was_redacted = True
                return "[REDACTED:HIGH_ENTROPY_TOKEN]"
            return candidate

        out = _HIGH_ENTROPY_CANDIDATE_RE.sub(_repl_entropy, out)
        return (out, was_redacted)

    def redact_dict(self, obj: Any) -> Any:
        """Recursively redact strings and sensitive keys in dicts, lists, and primitives."""
        if isinstance(obj, str):
            redacted_str, _ = self.redact(obj)
            return redacted_str
        if isinstance(obj, list):
            return [self.redact_dict(item) for item in obj]
        if isinstance(obj, tuple):
            return tuple(self.redact_dict(item) for item in obj)
        if isinstance(obj, dict):
            cleaned: dict[Any, Any] = {}
            for k, v in obj.items():
                if isinstance(k, str) and _SENSITIVE_DICT_KEY_RE.search(k) and isinstance(v, str) and len(v) >= 6:
                    cleaned[k] = "[REDACTED:SECRET_FIELD]"
                else:
                    cleaned[k] = self.redact_dict(v)
            return cleaned
        return obj

    @staticmethod
    def decode_powershell_encoded(cmd: str) -> str | None:
        return decode_powershell_encoded(cmd)

    @staticmethod
    def parse_command_ast(command: str, workspace_roots: list[str] | None = None) -> tuple[list[str], list[str]]:
        return parse_command_ast(command, workspace_roots=workspace_roots)
