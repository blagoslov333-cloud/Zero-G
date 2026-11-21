import React, { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useZeroG } from "../lib/store";

export const PairingModal: React.FC = () => {
  const { showPairingModal, setShowPairingModal, pairingRequired, claimPairing } =
    useZeroG();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!showPairingModal) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await claimPairing(code.trim());
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired pairing code");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "var(--overlay-scrim)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pairing-dialog-title"
    >
      <div className="surface-card w-full max-w-sm p-5 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound
              className="w-5 h-5"
              style={{ color: "var(--accent-primary)" }}
            />
            <h2 id="pairing-dialog-title" className="font-display text-lg font-bold">
              Pair Mobile Device
            </h2>
          </div>
          {!pairingRequired && (
            <button
              type="button"
              onClick={() => setShowPairingModal(false)}
              className="btn-ghost !p-2"
              aria-label="Close pairing dialog"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Enter the 6-digit pairing code shown in the 0G Desktop Aux Pane or scan the
          QR code from your laptop.
        </p>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              6-Digit Pairing Code
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. 482910"
              className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 font-mono text-lg tracking-widest tabular-nums"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
              required
            />
          </label>

          {error && (
            <div
              role="alert"
              className="rounded-[var(--radius-inner)] border px-3 py-2 text-xs"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                borderColor: "var(--status-danger)",
                color: "var(--status-danger-fg)",
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || code.trim().length < 4}
            className="btn-primary w-full"
          >
            {submitting ? "Verifying..." : "Pair & Connect"}
          </button>
        </form>
      </div>
    </div>
  );
};
