import React, { useState } from "react";
import { Bell, Camera, MessageSquareReply, X } from "lucide-react";
import { useZeroG } from "../lib/store";

export const MobilePromptModal: React.FC = () => {
  const {
    activeMobilePrompt,
    closeMobilePrompt,
    notifyCards,
    dismissNotifyCard,
  } = useZeroG();
  const [reply, setReply] = useState("");
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoMeta, setPhotoMeta] = useState<{ name: string; size: number } | null>(
    null
  );

  const handleSubmitInput = (value: string) => {
    if (!activeMobilePrompt) return;
    activeMobilePrompt.resolve({ answer: value, submittedAt: Date.now() });
    setReply("");
    closeMobilePrompt();
  };

  const handleCancelPrompt = () => {
    if (!activeMobilePrompt) return;
    activeMobilePrompt.reject(new Error("User cancelled prompt on phone"));
    setReply("");
    setPhotoPreview(null);
    setPhotoMeta(null);
    closeMobilePrompt();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoMeta({ name: file.name, size: file.size });
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setPhotoPreview(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSendPhoto = () => {
    if (!activeMobilePrompt || !photoPreview) return;
    activeMobilePrompt.resolve({
      dataUrl: photoPreview,
      fileName: photoMeta?.name || "capture.jpg",
      sizeBytes: photoMeta?.size || photoPreview.length,
    });
    setPhotoPreview(null);
    setPhotoMeta(null);
    closeMobilePrompt();
  };

  return (
    <>
      {/* Live phone_notify_card Toast Stack */}
      {notifyCards.length > 0 && (
        <div
          className="fixed top-16 right-3 left-3 sm:left-auto sm:w-96 z-40 space-y-2 pointer-events-none"
          aria-live="polite"
        >
          {notifyCards.map((card) => {
            const borderCol =
              card.severity === "danger"
                ? "var(--status-danger)"
                : card.severity === "warning"
                  ? "var(--status-warning)"
                  : card.severity === "success"
                    ? "var(--status-success)"
                    : "var(--accent-secondary)";
            return (
              <div
                key={card.id}
                className="surface-card p-3 flex items-start justify-between gap-2 pointer-events-auto"
                style={{ borderColor: borderCol }}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <Bell
                    className="w-4 h-4 mt-0.5 shrink-0"
                    style={{ color: borderCol }}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">{card.title}</div>
                    <p
                      className="text-xs break-words mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {card.body}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => dismissNotifyCard(card.id)}
                  className="btn-ghost !min-h-[36px] !min-w-[36px] !p-1"
                  aria-label="Dismiss notification"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Interactive phone_ask_input / phone_capture_photo Modal */}
      {activeMobilePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-prompt-title"
        >
          <div className="surface-card w-full max-w-md p-4 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {activeMobilePrompt.mode === "photo" ? (
                  <Camera
                    className="w-5 h-5"
                    style={{ color: "var(--accent-secondary)" }}
                  />
                ) : (
                  <MessageSquareReply
                    className="w-5 h-5"
                    style={{ color: "var(--accent-primary)" }}
                  />
                )}
                <div>
                  <h2 id="mobile-prompt-title" className="font-display text-base font-bold">
                    Laptop Agent Tool Request
                  </h2>
                  <p className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                    {activeMobilePrompt.toolName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelPrompt}
                className="btn-ghost !p-2"
                aria-label="Cancel tool request"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm leading-relaxed">{activeMobilePrompt.prompt}</p>

            {activeMobilePrompt.mode === "input" ? (
              <div className="space-y-3">
                {activeMobilePrompt.choices && activeMobilePrompt.choices.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {activeMobilePrompt.choices.map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        onClick={() => handleSubmitInput(choice)}
                        className="btn-secondary text-xs"
                      >
                        {choice}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={activeMobilePrompt.placeholder || "Type reply..."}
                    className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2.5"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-default)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleSubmitInput(reply)}
                    disabled={!reply.trim()}
                    className="btn-primary shrink-0"
                  >
                    Send
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <label
                  className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-inner)] border p-4 cursor-pointer text-center min-h-[112px]"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-strong)",
                  }}
                >
                  <Camera
                    className="w-6 h-6"
                    style={{ color: "var(--accent-secondary)" }}
                  />
                  <span className="text-sm font-medium">
                    Tap to Capture Photo or Select Image
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </label>

                {photoPreview && (
                  <div className="space-y-2">
                    <img
                      src={photoPreview}
                      alt="Captured preview"
                      className="w-full max-h-56 object-contain rounded-[var(--radius-inner)] border"
                      style={{ borderColor: "var(--border-default)" }}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={handleCancelPrompt}
                        className="btn-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSendPhoto}
                        className="btn-primary"
                      >
                        Send Photo to Agent
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
