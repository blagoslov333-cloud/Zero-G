"""Provider adapter registry for Antigravity, Claude Code, Codex CLI, and Grok Build."""

from __future__ import annotations

from typing import Any

from server.adapters.antigravity import AntigravityAdapter
from server.adapters.base import AgentProviderAdapter
from server.adapters.claude_code import ClaudeCodeAdapter
from server.adapters.codex_cli import CodexCliAdapter
from server.adapters.grok_build import GrokBuildAdapter

_ADAPTER_CLASSES: tuple[type[AgentProviderAdapter], ...] = (
    AntigravityAdapter,
    ClaudeCodeAdapter,
    CodexCliAdapter,
    GrokBuildAdapter,
)

_REGISTRY: dict[str, AgentProviderAdapter] = {
    cls.provider_id: cls() for cls in _ADAPTER_CLASSES
}


def get_adapter(provider_id: str) -> AgentProviderAdapter:
    """Return the singleton adapter for ``provider_id`` or raise KeyError."""
    adapter = _REGISTRY.get(provider_id)
    if adapter is None:
        supported = ", ".join(_REGISTRY.keys())
        raise KeyError(f"Unknown provider {provider_id!r}. Supported: {supported}")
    return adapter


def all_adapters() -> list[AgentProviderAdapter]:
    """Return all registered provider adapters in priority order."""
    return list(_REGISTRY.values())


def all_hook_snippets(shim_cmd: str) -> dict[str, dict[str, Any]]:
    """Return provider-keyed hook installation snippets for the given shim command."""
    return {
        adapter.provider_id: adapter.generate_hook_snippet(shim_cmd)
        for adapter in all_adapters()
    }


__all__ = [
    "AgentProviderAdapter",
    "AntigravityAdapter",
    "ClaudeCodeAdapter",
    "CodexCliAdapter",
    "GrokBuildAdapter",
    "all_adapters",
    "all_hook_snippets",
    "get_adapter",
]
