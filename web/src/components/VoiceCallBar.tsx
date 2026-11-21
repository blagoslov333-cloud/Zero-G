import React from "react";
import {
  ChevronDown,
  ChevronUp,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useZeroG } from "../lib/store";

function formatElapsed(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export const VoiceCallBar: React.FC = () => {
  const {
    voiceSnapshot,
    voiceMinimized,
    setVoiceMinimized,
    toggleVoiceMic,
    toggleVoiceSpeaker,
    cycleVoiceSpeed,
    endVoiceCall,
  } = useZeroG();

  if (!voiceSnapshot.active) return null;

  const {
    mode,
    micMuted,
    speakerMuted,
    playbackSpeed,
    elapsedSeconds,
    statusText,
    captionText,
    audioLevel,
    error,
  } = voiceSnapshot;

  const isAnimating = !micMuted && audioLevel > 0.08;

  // Compact Minimized Pill Strip
  if (voiceMinimized) {
    return (
      <div
        role="region"
        aria-label="Antigravity Voice Call (Minimized)"
        className="mx-auto w-full max-w-3xl px-2 sm:px-4 pb-1.5"
      >
        <div
          className="surface-card px-3 py-1.5 flex items-center justify-between gap-2"
          style={{ borderColor: "var(--accent-primary)" }}
        >
          <button
            type="button"
            onClick={() => setVoiceMinimized(false)}
            className="flex-1 min-w-0 min-h-[44px] flex items-center gap-2.5 text-left"
          >
            <span
              className="inline-flex items-center gap-0.5 h-4 shrink-0"
              aria-hidden="true"
            >
              <span
                className={`w-1 h-3 rounded-full ${
                  isAnimating ? "agy-soundbar" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
              <span
                className={`w-1 h-4 rounded-full ${
                  isAnimating ? "agy-soundbar agy-soundbar-delay-1" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
              <span
                className={`w-1 h-2.5 rounded-full ${
                  isAnimating ? "agy-soundbar agy-soundbar-delay-2" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
            </span>
            <span className="font-display text-xs font-bold shrink-0">
              Antigravity
            </span>
            <span
              className="font-mono text-xs tabular-nums shrink-0"
              style={{ color: "var(--text-muted)" }}
            >
              {formatElapsed(elapsedSeconds)}
            </span>
            <span
              className="text-xs truncate"
              style={{ color: "var(--text-muted)" }}
            >
              {captionText || statusText}
            </span>
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={toggleVoiceMic}
              className="agy-icon-btn"
              aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
            >
              {micMuted ? (
                <MicOff
                  className="w-4 h-4"
                  style={{ color: "var(--status-danger)" }}
                />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setVoiceMinimized(false)}
              className="agy-icon-btn"
              aria-label="Expand voice bar"
            >
              <ChevronUp className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={endVoiceCall}
              className="btn-danger !min-h-[44px] !min-w-[44px] !px-2.5 text-xs"
              aria-label="End voice call"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Full Native Antigravity Voice Mode Bar
  return (
    <section
      role="region"
      aria-label="Antigravity Voice Mode"
      className="mx-auto w-full max-w-3xl px-2 sm:px-4 pb-2"
    >
      <div
        className="surface-card p-3 space-y-2.5"
        style={{ borderColor: "var(--accent-primary)" }}
      >
        {/* Top Row: Animated Sound Bars + Title + Elapsed Timer + Minimize */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-9 h-9 rounded-full border inline-flex items-center justify-center gap-0.5 shrink-0"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--accent-primary)",
              }}
              aria-hidden="true"
            >
              <span
                className={`w-1 h-3.5 rounded-full ${
                  isAnimating ? "agy-soundbar" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
              <span
                className={`w-1 h-5 rounded-full ${
                  isAnimating ? "agy-soundbar agy-soundbar-delay-1" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
              <span
                className={`w-1 h-4 rounded-full ${
                  isAnimating ? "agy-soundbar agy-soundbar-delay-2" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
              <span
                className={`w-1 h-3 rounded-full ${
                  isAnimating ? "agy-soundbar agy-soundbar-delay-3" : ""
                }`}
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display text-sm font-bold">
                  Antigravity
                </span>
                <span
                  className="font-mono text-xs tabular-nums"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatElapsed(elapsedSeconds)}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-mono border hidden sm:inline"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--accent-secondary)",
                  }}
                >
                  {mode === "gemini_live"
                    ? "Live Audio"
                    : mode === "fallback_web_speech"
                      ? "Web Speech"
                      : "Connecting"}
                </span>
              </div>
              <div
                className="text-xs truncate"
                style={{ color: "var(--text-muted)" }}
              >
                {statusText}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setVoiceMinimized(true)}
            className="agy-icon-btn shrink-0"
            aria-label="Minimize voice bar"
            title="Minimize"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>

        {/* Live Transcript / Interim Captions */}
        {(captionText || error) && (
          <div
            className="rounded-[var(--radius-inner)] border px-3 py-2 text-xs leading-relaxed break-words max-h-24 overflow-y-auto"
            style={{
              backgroundColor: error
                ? "var(--status-warning-bg)"
                : "var(--bg-subtle)",
              borderColor: error
                ? "var(--status-warning)"
                : "var(--border-default)",
              color: error
                ? "var(--status-warning-fg)"
                : "var(--text-primary)",
            }}
          >
            {error || captionText}
          </div>
        )}

        {/* Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={toggleVoiceMic}
              className={
                micMuted
                  ? "btn-danger !min-h-[44px] !px-3 text-xs"
                  : "btn-secondary !min-h-[44px] !px-3 text-xs"
              }
              aria-label={micMuted ? "Unmute mic" : "Mute mic"}
            >
              {micMuted ? (
                <MicOff className="w-4 h-4 shrink-0" />
              ) : (
                <Mic className="w-4 h-4 shrink-0" />
              )}
              <span className="hidden sm:inline">
                {micMuted ? "Unmute mic" : "Mute mic"}
              </span>
            </button>

            <button
              type="button"
              onClick={toggleVoiceSpeaker}
              className={
                speakerMuted
                  ? "btn-danger !min-h-[44px] !px-3 text-xs"
                  : "btn-secondary !min-h-[44px] !px-3 text-xs"
              }
              aria-label={
                speakerMuted ? "Unmute Antigravity" : "Mute Antigravity"
              }
            >
              {speakerMuted ? (
                <VolumeX className="w-4 h-4 shrink-0" />
              ) : (
                <Volume2 className="w-4 h-4 shrink-0" />
              )}
              <span className="hidden sm:inline">
                {speakerMuted ? "Unmute Antigravity" : "Mute Antigravity"}
              </span>
            </button>

            <button
              type="button"
              onClick={cycleVoiceSpeed}
              className="btn-secondary !min-h-[44px] !px-3 text-xs font-mono tabular-nums"
              aria-label={`Voice playback speed ${playbackSpeed}x`}
              title="Cycle voice speed (1x / 1.25x / 1.5x)"
            >
              <span>{playbackSpeed}x</span>
            </button>
          </div>

          <button
            type="button"
            onClick={endVoiceCall}
            className="btn-danger !min-h-[44px] !px-3.5 text-xs font-bold shrink-0"
          >
            <PhoneOff className="w-4 h-4 shrink-0" />
            <span>End</span>
          </button>
        </div>
      </div>
    </section>
  );
};
