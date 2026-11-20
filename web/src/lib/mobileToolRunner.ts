import type {
  ActiveMobilePrompt,
  MobileToolRequestFrame,
  MobileToolResultRequest,
  NotifyCardItem,
} from "../types/contracts";
import { api } from "./api";
import { wsClient } from "./ws";

export interface MobileRunnerUiHooks {
  pushNotifyCard: (card: NotifyCardItem) => void;
  openPromptModal: (prompt: ActiveMobilePrompt) => void;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

function playSubtleChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.19);
  } catch {
    // Audio playback blocked before user gesture
  }
}

async function runPhoneNotifyCard(
  args: Record<string, unknown>,
  hooks: MobileRunnerUiHooks
): Promise<unknown> {
  const title = String(args.title || "0G Agent Update");
  const body = String(args.body || args.message || args.input || "");
  const severityRaw = String(args.severity || "info");
  const severity = (["info", "success", "warning", "danger"].includes(severityRaw)
    ? severityRaw
    : "info") as NotifyCardItem["severity"];

  hooks.pushNotifyCard({
    id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    body,
    severity,
    ts: Date.now(),
  });
  playSubtleChime();

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    document.visibilityState !== "visible"
  ) {
    new Notification(title, { body, icon: "/icon.svg" });
  }
  return { delivered: true, title, body };
}

function runPhoneAskInput(
  ticketId: string,
  toolName: string,
  args: Record<string, unknown>,
  hooks: MobileRunnerUiHooks
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const choices = Array.isArray(args.choices)
      ? args.choices.map((c) => String(c))
      : undefined;
    hooks.openPromptModal({
      ticketId,
      toolName,
      mode: "input",
      prompt: String(args.prompt || args.question || args.input || "Agent requests input:"),
      choices,
      placeholder: args.placeholder ? String(args.placeholder) : "Type reply...",
      resolve,
      reject,
    });
  });
}

function runPhoneCapturePhoto(
  ticketId: string,
  toolName: string,
  args: Record<string, unknown>,
  hooks: MobileRunnerUiHooks
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    hooks.openPromptModal({
      ticketId,
      toolName,
      mode: "photo",
      prompt: String(
        args.prompt || args.caption || "Capture or choose a photo to send to the agent."
      ),
      resolve,
      reject,
    });
  });
}

async function runPhoneReadClipboard(): Promise<unknown> {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
    throw new Error("Clipboard API unavailable in this browser context");
  }
  const text = await navigator.clipboard.readText();
  return { text, length: text.length };
}

async function runPhoneGetLocation(args: Record<string, unknown>): Promise<unknown> {
  if (!navigator.geolocation) {
    throw new Error("Geolocation API unavailable on this device");
  }
  const highAccuracy = Boolean(args.highAccuracy);
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
      (err) => reject(new Error(err.message || "Geolocation permission denied")),
      { enableHighAccuracy: highAccuracy, timeout: 12000, maximumAge: 30000 }
    );
  });
}

async function runPhoneSpeakTts(args: Record<string, unknown>): Promise<unknown> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    throw new Error("Web Speech synthesis unavailable");
  }
  const text = String(args.text || args.message || args.input || "").trim();
  if (!text) {
    throw new Error("No text provided for speech synthesis");
  }
  const utter = new SpeechSynthesisUtterance(text);
  if (typeof args.rate === "number") {
    utter.rate = Math.min(2, Math.max(0.5, args.rate));
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
  return { spoken: true, text };
}

export async function executeMobileToolLocally(
  req: MobileToolRequestFrame,
  hooks: MobileRunnerUiHooks
): Promise<MobileToolResultRequest> {
  const { ticketId, toolName, arguments: args = {}, runtime, code } = req;
  try {
    let result: unknown;

    switch (toolName) {
      case "phone_notify_card":
        result = await runPhoneNotifyCard(args, hooks);
        break;
      case "phone_ask_input":
        result = await runPhoneAskInput(ticketId, toolName, args, hooks);
        break;
      case "phone_read_clipboard":
        result = await runPhoneReadClipboard();
        break;
      case "phone_capture_photo":
        result = await runPhoneCapturePhoto(ticketId, toolName, args, hooks);
        break;
      case "phone_get_location":
        result = await runPhoneGetLocation(args);
        break;
      case "phone_speak_tts":
        result = await runPhoneSpeakTts(args);
        break;
      default: {
        if (runtime === "host_command") {
          throw new Error("host_command tools execute on the laptop daemon");
        }
        const snippet = (code || "").trim();
        if (!snippet) {
          throw new Error(`No phone_js code body defined for ${toolName}`);
        }
        const ctx = {
          notify: (title: string, body: string) =>
            runPhoneNotifyCard({ title, body }, hooks),
          askInput: (prompt: string, choices?: string[]) =>
            runPhoneAskInput(ticketId, toolName, { prompt, choices }, hooks),
          clipboard: () => runPhoneReadClipboard(),
          location: (highAccuracy = false) => runPhoneGetLocation({ highAccuracy }),
          speak: (text: string) => runPhoneSpeakTts({ text }),
          now: () => Date.now(),
        };
        const fn = new AsyncFunction("args", "ctx", snippet);
        result = await fn(args, ctx);
        break;
      }
    }

    return { ticketId, ok: true, result: result ?? null, error: null };
  } catch (err) {
    return {
      ticketId,
      ok: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleIncomingMobileToolRequest(
  req: MobileToolRequestFrame,
  hooks: MobileRunnerUiHooks
): Promise<MobileToolResultRequest> {
  const outcome = await executeMobileToolLocally(req, hooks);
  const sentWs = wsClient.sendWs("mobile_tool_result", {
    ticketId: outcome.ticketId,
    ok: outcome.ok,
    result: outcome.result,
    error: outcome.error,
  });
  if (!sentWs) {
    await api.submitMobileToolResult(outcome).catch(() => {});
  }
  return outcome;
}
