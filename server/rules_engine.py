"""AST-aware risk classifier, Tier-3 self-protection guard, and scoped temporary grant engine."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any

from server.contracts import RuleEntry
from server.db import ZeroGDatabase
from server.security import decode_powershell_encoded, parse_command_ast

# Tier-3 Unconditional Self-Protection file & path patterns
_TIER3_PROTECTED_TARGET_RE = re.compile(
    r"(?i)(?:"
    r"(?:^|[/\\\s'\"=])hooks\.json(?:$|[\s'\"])|"
    r"plugins[/\\]0g\b|"
    r"\.gemini[/\\]config[/\\]config\.json|"
    r"(?:^|[/\\\s'\"=])\.env(?:\.[A-Za-z0-9_.-]+)?(?:$|[\s'\"])|"
    r"\bid_rsa\b|\bid_ed25519\b|"
    r"\.[A-Za-z0-9_-]*\b(?:pem|key|pfx)\b|"
    r"[A-Za-z0-9_.-]+\.(?:pem|key|pfx)(?:$|[\s'\"])|"
    r"\bbridge\.token\b|"
    r"\bvapid_keys\.json\b"
    r")"
)

# Tier-3 Unconditional Destructive System Commands
_TIER3_DESTRUCTIVE_CMD_RE = re.compile(
    r"(?i)(?:"
    r"\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\b|"
    r"\b(?:Remove-Item|ri|del|erase|rmdir|rd)\b[^\n|;&]*(?:-Recurse|-Force|/s\b)|"
    r"(?:^|[|;&\s])format(?:\.com|\.exe)?\s+[a-zA-Z]:|"
    r"\breg(?:\.exe)?\s+delete\b|"
    r"\bgit\s+push\b[^\n|;&]*(?:--force|-f\b)|"
    r"\bgit\s+reset\s+--hard\b|"
    r"\b(?:diskpart|bcdedit|cipher\s+/w|vssadmin\s+delete)\b"
    r")"
)

_WRITE_LIKE_TOOLS = {
    "write_file",
    "edit_file",
    "multi_edit",
    "create_file",
    "delete_file",
    "remove_file",
    "replace_file_content",
    "multi_replace_file_content",
    "write",
    "edit",
    "multiedit",
    "notebookedit",
    "patch",
}

_SHELL_LIKE_TOOLS = {
    "run_command",
    "bash",
    "shell",
    "powershell",
    "pwsh",
    "cmd",
    "exec",
    "terminal",
}

_READONLY_TOOLS = {
    "read_file",
    "view_file",
    "view_file_outline",
    "view_code_item",
    "list_dir",
    "grep_search",
    "find_by_name",
    "read",
    "glob",
    "grep",
    "ls",
}


class RulesEngine:
    """Evaluates tool calls against Tier-3 hard-deny invariants and user/temporary rules."""

    def __init__(self, db: ZeroGDatabase) -> None:
        self.db = db

    @staticmethod
    def extract_command_preview(tool_name: str, args: dict[str, Any] | str | None) -> str:
        if args is None:
            return tool_name
        if isinstance(args, str):
            return args.strip() or tool_name
        if not isinstance(args, dict):
            return f"{tool_name} {args}"

        # Extract common command or path keys across Antigravity, Claude Code, Codex, Grok
        for cmd_key in ("CommandLine", "command", "cmd", "script", "Script"):
            val = args.get(cmd_key)
            if isinstance(val, str) and val.strip():
                return val.strip()

        for path_key in ("Path", "file_path", "path", "TargetFile", "filePath", "target_file"):
            val = args.get(path_key)
            if isinstance(val, str) and val.strip():
                return f"{tool_name} {val.strip()}"

        try:
            compact = json.dumps(args, ensure_ascii=False, sort_keys=True)
            return f"{tool_name} {compact}"
        except Exception:
            return tool_name

    @staticmethod
    def _extract_target_paths(args: dict[str, Any] | str | None) -> list[str]:
        if not args:
            return []
        if isinstance(args, str):
            return [args]
        paths: list[str] = []
        if isinstance(args, dict):
            for k in ("Path", "file_path", "path", "TargetFile", "filePath", "target_file", "CommandLine", "command", "cmd"):
                v = args.get(k)
                if isinstance(v, str) and v.strip():
                    paths.append(v.strip())
        return paths

    def evaluate(
        self,
        tool_name: str,
        args: dict[str, Any] | str | None = None,
        cwd: str | None = None,
        provider: str = "antigravity",
        workspace_roots: list[str] | None = None,
    ) -> dict[str, Any]:
        norm_tool = (tool_name or "unknown").strip()
        norm_tool_lower = norm_tool.lower()
        args_dict = args if isinstance(args, dict) else ({"raw": args} if args is not None else {})

        command_preview = self.extract_command_preview(norm_tool, args)
        roots = list(workspace_roots or [])
        if cwd and cwd not in roots:
            roots.append(cwd)

        ast_summary, risk_reasons = parse_command_ast(command_preview, workspace_roots=roots or None)
        decoded_ps = decode_powershell_encoded(command_preview)

        # Collect all text surfaces to check against Tier-3 self-protection
        surfaces = [command_preview]
        surfaces.extend(self._extract_target_paths(args))
        if decoded_ps:
            surfaces.append(decoded_ps)
        if args_dict:
            try:
                surfaces.append(json.dumps(args_dict, ensure_ascii=False))
            except Exception:
                pass

        risk_tier: int = 1
        auto_decision: str | None = None
        matched_rule_id: str | None = None

        # 1. UNCONDITIONAL Tier-3 Self-Protection check
        for surface in surfaces:
            prot_match = _TIER3_PROTECTED_TARGET_RE.search(surface)
            if prot_match:
                target_hit = prot_match.group(0).strip()
                reason = f"Tier-3 Self-Protection: blocked access/modification targeting protected resource ({target_hit})"
                if reason not in risk_reasons:
                    risk_reasons.insert(0, reason)
                tag = f"tier3_protected: {target_hit}"
                if tag not in ast_summary:
                    ast_summary.append(tag)
                return {
                    "riskTier": 3,
                    "riskReasons": risk_reasons,
                    "astSummary": ast_summary,
                    "commandPreview": command_preview,
                    "autoDecision": "deny",
                    "ruleId": "tier3-self-protection",
                }

        # 2. UNCONDITIONAL Tier-3 Destructive command / encoded destructive payload check
        for surface in ([command_preview, decoded_ps] if decoded_ps else [command_preview]):
            if not surface:
                continue
            dest_match = _TIER3_DESTRUCTIVE_CMD_RE.search(surface)
            if dest_match:
                hit = dest_match.group(0).strip()
                reason = f"Tier-3 Hard Deny: destructive command pattern blocked ({hit})"
                if reason not in risk_reasons:
                    risk_reasons.insert(0, reason)
                tag = f"tier3_destructive: {hit}"
                if tag not in ast_summary:
                    ast_summary.append(tag)
                return {
                    "riskTier": 3,
                    "riskReasons": risk_reasons,
                    "astSummary": ast_summary,
                    "commandPreview": command_preview,
                    "autoDecision": "deny",
                    "ruleId": "tier3-destructive-guard",
                }

        # If encoded PowerShell payload is present (even if not matched above), elevate to at least Tier 2
        if decoded_ps:
            risk_tier = max(risk_tier, 2)

        # 3. Baseline risk tier from AST & tool type
        if norm_tool_lower in _READONLY_TOOLS and not risk_reasons:
            risk_tier = 0
        elif norm_tool_lower in _WRITE_LIKE_TOOLS:
            risk_tier = max(risk_tier, 1)
        elif norm_tool_lower in _SHELL_LIKE_TOOLS:
            risk_tier = max(risk_tier, 1)

        for reason in risk_reasons:
            r_low = reason.lower()
            if "destructive" in r_low:
                risk_tier = 3
            elif "egress" in r_low or "encoded" in r_low or "out-of-workspace" in r_low or "chained command pipeline" in r_low:
                risk_tier = max(risk_tier, 2)

        # 4. Evaluate dynamic & seeded rules from database (Deny rules evaluated before Allow rules)
        rules = self.db.list_rules()
        matching_rules: list[RuleEntry] = []

        for rule in rules:
            if not rule.enabled:
                continue
            if rule.provider not in ("*", provider):
                continue
            if rule.scopeCwd and cwd:
                try:
                    if os.path.normcase(os.path.abspath(cwd)) != os.path.normcase(os.path.abspath(rule.scopeCwd)):
                        continue
                except Exception:
                    if rule.scopeCwd != cwd:
                        continue
            elif rule.scopeCwd and not cwd:
                continue

            if rule.toolPattern and rule.toolPattern != "*":
                try:
                    if not re.search(f"^(?:{rule.toolPattern})$", norm_tool, re.IGNORECASE):
                        continue
                except re.error:
                    if rule.toolPattern.lower() != norm_tool_lower:
                        continue

            try:
                if re.search(rule.commandRegex, command_preview):
                    matching_rules.append(rule)
            except re.error:
                if rule.commandRegex in command_preview:
                    matching_rules.append(rule)

        # Prioritize deny > ask > allow
        for rule in matching_rules:
            if rule.action == "deny":
                risk_tier = max(risk_tier, int(rule.riskTier))
                auto_decision = "deny"
                matched_rule_id = rule.id
                reason = f"Blocked by rule '{rule.name}' ({rule.id})"
                if reason not in risk_reasons:
                    risk_reasons.append(reason)
                break

        if auto_decision is None:
            for rule in matching_rules:
                if rule.action == "allow" and risk_tier < 3:
                    # Only auto-allow if no unapproved Tier-2 pipeline/egress risk overrides a generic Tier-0 rule
                    if rule.riskTier == 0 and risk_tier >= 2:
                        continue
                    risk_tier = min(risk_tier, int(rule.riskTier))
                    auto_decision = "allow"
                    matched_rule_id = rule.id
                    break

        # Pure read-only tool with zero risk reasons defaults to Tier 0 allow
        if auto_decision is None and norm_tool_lower in _READONLY_TOOLS and risk_tier == 0 and not risk_reasons:
            auto_decision = "allow"
            matched_rule_id = "builtin-readonly-tool"

        return {
            "riskTier": min(max(int(risk_tier), 0), 3),
            "riskReasons": risk_reasons,
            "astSummary": ast_summary,
            "commandPreview": command_preview,
            "autoDecision": auto_decision,
            "ruleId": matched_rule_id,
        }

    def create_scoped_temp_grant(
        self,
        tool_name: str,
        command_preview: str,
        cwd: str | None = None,
        provider: str = "*",
        duration_sec: int = 1800,
    ) -> RuleEntry:
        """Create a 30-minute scoped allow rule for a specific command prefix/exact pattern."""
        check = self.evaluate(tool_name, {"command": command_preview}, cwd=cwd, provider=provider)
        if check["riskTier"] >= 3 or check["autoDecision"] == "deny":
            raise ValueError("Cannot create a temporary allow grant for a Tier-3 or denied command.")

        escaped_cmd = re.escape(command_preview.strip())
        now = time.time()
        rule = RuleEntry(
            id=f"temp-30m-{uuid.uuid4().hex[:8]}",
            name=f"30m Scoped Grant: {command_preview[:40]}",
            provider=provider if provider in ("antigravity", "claude_code", "codex_cli", "grok_build", "*") else "*",  # type: ignore[arg-type]
            toolPattern=re.escape(tool_name),
            commandRegex=f"^{escaped_cmd}$",
            action="allow",
            riskTier=check["riskTier"],  # type: ignore[arg-type]
            enabled=True,
            expiresAt=now + float(duration_sec),
            scopeCwd=cwd,
        )
        return self.db.upsert_rule(rule)
