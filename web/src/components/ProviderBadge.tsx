import React from "react";
import { Orbit, Sparkles, Terminal, Zap } from "lucide-react";
import type { ProviderId } from "../types/contracts";

const PROVIDER_META: Record<
  ProviderId,
  { label: string; token: string; Icon: React.FC<{ className?: string }> }
> = {
  antigravity: {
    label: "Antigravity",
    token: "var(--provider-antigravity)",
    Icon: Orbit,
  },
  claude_code: {
    label: "Claude Code",
    token: "var(--provider-claude)",
    Icon: Sparkles,
  },
  codex_cli: {
    label: "Codex CLI",
    token: "var(--provider-codex)",
    Icon: Terminal,
  },
  grok_build: {
    label: "Grok Build",
    token: "var(--provider-grok)",
    Icon: Zap,
  },
};

export const ProviderBadge: React.FC<{
  provider: ProviderId;
  compact?: boolean;
}> = ({ provider, compact = false }) => {
  const meta = PROVIDER_META[provider] || PROVIDER_META.antigravity;
  const Icon = meta.Icon;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border"
      style={{
        borderColor: meta.token,
        color: meta.token,
        backgroundColor: "var(--bg-subtle)",
      }}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {!compact && <span>{meta.label}</span>}
    </span>
  );
};

export function getProviderLabel(provider: ProviderId): string {
  return PROVIDER_META[provider]?.label || provider;
}
