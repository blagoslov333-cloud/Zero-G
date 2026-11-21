import type { VoiceModeKind, VoicePlaybackSpeed } from "../types/contracts";
import { getAuthToken } from "./api";

export interface VoiceClientSnapshot {
  active: boolean;
  mode: VoiceModeKind;
  micMuted: boolean;
  speakerMuted: boolean;
  playbackSpeed: VoicePlaybackSpeed;
  elapsedSeconds: number;
  statusText: string;
  captionText: string;
  audioLevel: number;
  error: string | null;
}

export type VoiceStateListener = (snapshot: VoiceClientSnapshot) => void;
export type VoiceConversationBoundListener = (conversationId: string) => void;

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface BrowserSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognitionInstance;

export function getBrowserSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function downsampleTo16kInt16(
  input: Float32Array,
  inputSampleRate: number
): Int16Array {
  if (inputSampleRate === 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputSampleRate / 16000;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(outLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < outLength) {
    const nextOffsetBuffer = Math.min(
      input.length,
      Math.round((offsetResult + 1) * ratio)
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i];
      count++;
    }
    const avg = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, avg));
    out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return window.btoa(binary);
}

function base64ToFloat32(base64: string): Float32Array {
  const binary = window.atob(base64);
  const byteLen = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = byteLen / 2;
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    float32[i] = int16 / 32768;
  }
  return float32;
}

const WORKLET_PROCESSOR_SOURCE = `
class ZeroGPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0]);
    }
    return true;
  }
}
registerProcessor("zerog-pcm-capture", ZeroGPcmCaptureProcessor);
`;

export class AntigravityVoiceClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private outputGain: GainNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private muteMonitorGain: GainNode | null = null;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private elapsedTimer: number | null = null;
  private startedAtMs = 0;
  private fallbackRec: BrowserSpeechRecognitionInstance | null = null;
  private listeners = new Set<VoiceStateListener>();
  private boundListeners = new Set<VoiceConversationBoundListener>();

  private state: VoiceClientSnapshot = {
    active: false,
    mode: "connecting",
    micMuted: false,
    speakerMuted: false,
    playbackSpeed: 1,
    elapsedSeconds: 0,
    statusText: "Listening. Ask anything.",
    captionText: "",
    audioLevel: 0,
    error: null,
  };

  getSnapshot(): VoiceClientSnapshot {
    return this.state;
  }

  subscribe(fn: VoiceStateListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  onConversationBound(fn: VoiceConversationBoundListener): () => void {
    this.boundListeners.add(fn);
    return () => this.boundListeners.delete(fn);
  }

  private emit(patch: Partial<VoiceClientSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) {
      fn(this.state);
    }
  }

  async start(conversationId: string | null): Promise<void> {
    this.stop();

    this.startedAtMs = Date.now();
    this.nextPlayTime = 0;
    this.emit({
      active: true,
      mode: "connecting",
      micMuted: false,
      speakerMuted: false,
      elapsedSeconds: 0,
      statusText: "Connecting to Antigravity Voice…",
      captionText: "",
      audioLevel: 0.15,
      error: null,
    });

    this.elapsedTimer = window.setInterval(() => {
      if (!this.state.active) return;
      const secs = Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000));
      this.emit({ elapsedSeconds: secs });
    }, 1000);

    await this.setupAudioEngine();
    this.connectSocket(conversationId);
  }

  private async setupAudioEngine(): Promise<void> {
    if (typeof window === "undefined") return;
    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtxCtor) return;

    try {
      const ctx = new AudioCtxCtor();
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }
      this.audioCtx = ctx;
      const gain = ctx.createGain();
      gain.gain.value = this.state.speakerMuted ? 0 : 1;
      gain.connect(ctx.destination);
      this.outputGain = gain;
    } catch {
      // Output AudioContext unavailable; fallback speechSynthesis still works
    }

    if (!navigator.mediaDevices?.getUserMedia || !this.audioCtx) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      this.mediaStream = stream;
      const ctx = this.audioCtx;
      const src = ctx.createMediaStreamSource(stream);
      this.sourceNode = src;

      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(ctx.destination);
      this.muteMonitorGain = silentGain;

      let workletAttached = false;
      if (ctx.audioWorklet && typeof Blob !== "undefined") {
        try {
          const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
            type: "application/javascript",
          });
          const workletUrl = URL.createObjectURL(blob);
          try {
            await ctx.audioWorklet.addModule(workletUrl);
            const worklet = new AudioWorkletNode(ctx, "zerog-pcm-capture");
            worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => {
              if (ev.data) {
                this.handleMicFloat32(ev.data, ctx.sampleRate);
              }
            };
            src.connect(worklet);
            worklet.connect(silentGain);
            this.workletNode = worklet;
            workletAttached = true;
          } finally {
            URL.revokeObjectURL(workletUrl);
          }
        } catch {
          workletAttached = false;
        }
      }

      if (!workletAttached) {
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (ev: AudioProcessingEvent) => {
          const chan = ev.inputBuffer.getChannelData(0);
          this.handleMicFloat32(new Float32Array(chan), ctx.sampleRate);
        };
        src.connect(proc);
        proc.connect(silentGain);
        this.processorNode = proc;
      }
    } catch (err) {
      this.emit({
        error:
          err instanceof Error
            ? `Microphone access: ${err.message}`
            : "Microphone permission unavailable",
      });
    }
  }

  private pendingPcmChunks: number[] = [];

  private handleMicFloat32(samples: Float32Array, sampleRate: number): void {
    if (!this.state.active || this.state.micMuted) {
      if (this.state.audioLevel > 0.05) {
        this.emit({ audioLevel: 0.04 });
      }
      return;
    }

    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
    const normLevel = Math.min(1, Math.max(0.08, rms * 5.5));
    this.emit({ audioLevel: normLevel });

    if (
      this.state.mode !== "gemini_live" ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const pcm16 = downsampleTo16kInt16(samples, sampleRate);
    for (let i = 0; i < pcm16.length; i++) {
      this.pendingPcmChunks.push(pcm16[i]);
    }

    // Flush ~100ms chunks (1600 samples @ 16kHz)
    while (this.pendingPcmChunks.length >= 1600) {
      const slice = Int16Array.from(this.pendingPcmChunks.splice(0, 1600));
      const b64 = int16ToBase64(slice);
      try {
        this.ws.send(JSON.stringify({ type: "audio", data: b64 }));
      } catch {
        break;
      }
    }
  }

  private connectSocket(conversationId: string | null): void {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    if (conversationId) params.set("conversationId", conversationId);
    const token = getAuthToken();
    if (token) params.set("token", token);

    const url = `${proto}//${window.location.host}/ws/voice?${params.toString()}`;
    try {
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        this.emit({
          statusText: "Listening. Ask anything.",
          error: null,
        });
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          this.handleServerFrame(msg);
        } catch {
          // Ignore non-JSON frames
        }
      };

      socket.onerror = () => {
        if (this.state.active && this.state.mode === "connecting") {
          this.activateFallbackWebSpeech("Switched to local Web Speech mode");
        }
      };

      socket.onclose = () => {
        this.ws = null;
        if (this.state.active && this.state.mode === "connecting") {
          this.activateFallbackWebSpeech("Voice socket closed — Web Speech active");
        }
      };
    } catch {
      this.activateFallbackWebSpeech("Using browser Web Speech fallback");
    }
  }

  private handleServerFrame(msg: Record<string, unknown>): void {
    const type = String(msg.type || "");
    switch (type) {
      case "voice.ready": {
        this.stopFallbackRecognition();
        const boundId =
          typeof msg.conversationId === "string" ? msg.conversationId : null;
        if (boundId) {
          for (const fn of this.boundListeners) fn(boundId);
        }
        this.emit({
          mode: "gemini_live",
          statusText: "Listening. Ask anything.",
          error: null,
        });
        break;
      }
      case "voice.mode": {
        const mode = String(msg.mode || "");
        if (mode === "fallback_web_speech") {
          this.activateFallbackWebSpeech(
            typeof msg.reason === "string"
              ? msg.reason
              : "Listening. Ask anything."
          );
        } else if (mode === "gemini_live") {
          this.stopFallbackRecognition();
          this.emit({
            mode: "gemini_live",
            statusText: "Listening. Ask anything.",
          });
        }
        break;
      }
      case "voice.audio": {
        const b64 = typeof msg.data === "string" ? msg.data : "";
        const sampleRate =
          typeof msg.sampleRate === "number" ? msg.sampleRate : 24000;
        if (b64) {
          this.enqueueOutputAudio(b64, sampleRate);
        }
        break;
      }
      case "voice.interrupted": {
        this.clearScheduledOutput();
        this.emit({ statusText: "Listening. Ask anything." });
        break;
      }
      case "voice.conversation_bound": {
        const cid =
          typeof msg.conversationId === "string" ? msg.conversationId : "";
        if (cid) {
          for (const fn of this.boundListeners) fn(cid);
        }
        break;
      }
      case "input_transcription":
      case "voice.input_transcript": {
        const txt = String(msg.text || msg.transcript || "").trim();
        if (txt) {
          this.emit({
            statusText: "Hearing you…",
            captionText: txt,
          });
        }
        break;
      }
      case "voice.transcript": {
        const txt = String(msg.text || msg.transcript || "").trim();
        const role = String(msg.role || "assistant");
        if (txt) {
          if (role === "user") {
            this.emit({
              statusText: "Hearing you…",
              captionText: txt,
            });
          } else {
            this.emit({
              statusText: "Antigravity speaking…",
              captionText: txt,
            });
            if (this.state.mode === "fallback_web_speech") {
              this.speakViaSynthesis(txt);
            }
          }
        }
        break;
      }
      case "output_transcription":
      case "voice.output_transcript":
      case "voice.assistant_text":
      case "voice.reply": {
        const txt = String(msg.text || msg.reply || msg.transcript || "").trim();
        if (txt) {
          this.emit({
            statusText: "Antigravity speaking…",
            captionText: txt,
          });
          if (this.state.mode === "fallback_web_speech") {
            this.speakViaSynthesis(txt);
          }
        }
        break;
      }
      case "voice.turn_complete": {
        if (this.scheduledSources.size === 0) {
          this.emit({ statusText: "Listening. Ask anything." });
        }
        break;
      }
      case "voice.error": {
        const errMsg = String(msg.error || msg.detail || "Voice session notice");
        this.emit({ error: errMsg });
        break;
      }
      default:
        break;
    }
  }

  private enqueueOutputAudio(base64: string, sampleRate: number): void {
    if (!this.audioCtx || !this.outputGain) return;
    try {
      const samples = base64ToFloat32(base64);
      if (samples.length === 0) return;

      const buffer = this.audioCtx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);

      const src = this.audioCtx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this.state.playbackSpeed;
      src.connect(this.outputGain);

      const now = this.audioCtx.currentTime;
      const startAt = Math.max(now + 0.015, this.nextPlayTime);
      src.start(startAt);
      this.nextPlayTime = startAt + buffer.duration / this.state.playbackSpeed;

      this.scheduledSources.add(src);
      this.emit({
        statusText: "Antigravity speaking…",
        audioLevel: 0.72,
      });

      src.onended = () => {
        this.scheduledSources.delete(src);
        if (this.scheduledSources.size === 0 && this.state.active) {
          this.emit({
            statusText: "Listening. Ask anything.",
            audioLevel: 0.12,
          });
        }
      };
    } catch {
      // Ignore malformed PCM chunk
    }
  }

  clearScheduledOutput(): void {
    for (const src of this.scheduledSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Already ended
      }
    }
    this.scheduledSources.clear();
    this.nextPlayTime = 0;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }
  }

  private activateFallbackWebSpeech(reason?: string): void {
    this.emit({
      mode: "fallback_web_speech",
      statusText: "Listening. Ask anything.",
      captionText: reason || "",
    });

    const RecCtor = getBrowserSpeechRecognitionCtor();
    if (!RecCtor || this.fallbackRec) return;

    try {
      const rec = new RecCtor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";

      rec.onresult = (ev) => {
        if (this.state.micMuted || !this.state.active) return;
        let interim = "";
        let finalTranscript = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          const text = res[0]?.transcript || "";
          if (res.isFinal) {
            finalTranscript += text;
          } else {
            interim += text;
          }
        }
        if (interim.trim()) {
          this.emit({
            statusText: "Hearing you…",
            captionText: interim.trim(),
            audioLevel: 0.65,
          });
        }
        if (finalTranscript.trim()) {
          const clean = finalTranscript.trim();
          this.emit({
            statusText: "Sending to Antigravity…",
            captionText: clean,
            audioLevel: 0.25,
          });
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "text_command", text: clean }));
          }
        }
      };

      rec.onerror = () => {
        // Keep active; user can toggle mic or end
      };

      rec.onend = () => {
        if (
          this.state.active &&
          this.state.mode === "fallback_web_speech" &&
          !this.state.micMuted
        ) {
          try {
            rec.start();
          } catch {
            // Browser blocked auto-restart
          }
        }
      };

      this.fallbackRec = rec;
      rec.start();
    } catch {
      // SpeechRecognition unavailable in this browser
    }
  }

  private stopFallbackRecognition(): void {
    if (this.fallbackRec) {
      const rec = this.fallbackRec;
      this.fallbackRec = null;
      try {
        rec.onend = null;
        rec.stop();
      } catch {
        // Ignore
      }
    }
  }

  private speakViaSynthesis(text: string): void {
    if (
      this.state.speakerMuted ||
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = this.state.playbackSpeed;
      utter.onend = () => {
        if (this.state.active) {
          this.emit({ statusText: "Listening. Ask anything." });
        }
      };
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore synthesis failure
    }
  }

  bindConversation(conversationId: string | null): void {
    if (
      conversationId &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      try {
        this.ws.send(
          JSON.stringify({ type: "bind_conversation", conversationId })
        );
      } catch {
        // Ignore
      }
    }
  }

  setMicMuted(muted: boolean): void {
    this.emit({
      micMuted: muted,
      statusText: muted ? "Microphone muted" : "Listening. Ask anything.",
    });
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
    if (muted && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "audio_stream_end" }));
      } catch {
        // Ignore
      }
    }
  }

  setSpeakerMuted(muted: boolean): void {
    this.emit({ speakerMuted: muted });
    if (this.outputGain) {
      this.outputGain.gain.value = muted ? 0 : 1;
    }
    if (muted && typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }
  }

  setPlaybackSpeed(speed: VoicePlaybackSpeed): void {
    this.emit({ playbackSpeed: speed });
    for (const src of this.scheduledSources) {
      try {
        src.playbackRate.value = speed;
      } catch {
        // Ignore
      }
    }
  }

  stop(): void {
    this.pendingPcmChunks = [];
    if (this.elapsedTimer !== null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.stopFallbackRecognition();
    this.clearScheduledOutput();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore
      }
      this.workletNode = null;
    }

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // Ignore
      }
      this.processorNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore
      }
      this.sourceNode = null;
    }

    if (this.muteMonitorGain) {
      try {
        this.muteMonitorGain.disconnect();
      } catch {
        // Ignore
      }
      this.muteMonitorGain = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      this.mediaStream = null;
    }

    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch {
        // Ignore
      }
      this.audioCtx = null;
      this.outputGain = null;
    }

    this.emit({
      active: false,
      elapsedSeconds: 0,
      statusText: "Listening. Ask anything.",
      captionText: "",
      audioLevel: 0,
      error: null,
    });
  }
}

export const voiceClient = new AntigravityVoiceClient();
