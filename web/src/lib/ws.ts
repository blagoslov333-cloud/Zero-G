import type { StreamEnvelope } from "../types/contracts";
import { getAuthToken } from "./api";

export type WsConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export type WsFrameListener = (envelope: StreamEnvelope) => void;
export type WsStatusListener = (status: WsConnectionStatus, lastSeq: number) => void;

const LAST_SEQ_KEY = "0g_last_seq";

export class ZeroGWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private attempt = 0;
  private closedByUser = false;
  private lastSeq = 0;
  private status: WsConnectionStatus = "connecting";
  private frameListeners = new Set<WsFrameListener>();
  private statusListeners = new Set<WsStatusListener>();

  constructor() {
    if (typeof window !== "undefined") {
      const saved = Number(localStorage.getItem(LAST_SEQ_KEY) || "0");
      if (Number.isFinite(saved) && saved >= 0) {
        this.lastSeq = saved;
      }
      window.addEventListener("online", this.handleNetworkWake);
      document.addEventListener("visibilitychange", this.handleVisibilityWake);
    }
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  subscribeFrames(fn: WsFrameListener): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  subscribeStatus(fn: WsStatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.status, this.lastSeq);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(next: WsConnectionStatus): void {
    this.status = next;
    for (const listener of this.statusListeners) {
      listener(next, this.lastSeq);
    }
  }

  private handleNetworkWake = (): void => {
    if (!this.closedByUser && this.status !== "connected") {
      this.attempt = 0;
      this.connect();
    }
  };

  private handleVisibilityWake = (): void => {
    if (
      document.visibilityState === "visible" &&
      !this.closedByUser &&
      (!this.ws || this.ws.readyState !== WebSocket.OPEN)
    ) {
      this.attempt = 0;
      this.connect();
    }
  };

  connect(): void {
    if (typeof window === "undefined") return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.closedByUser = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline");
    } else {
      this.setStatus(this.attempt > 0 ? "reconnecting" : "connecting");
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    params.set("since", String(this.lastSeq));
    const token = getAuthToken();
    if (token) {
      params.set("token", token);
    }
    const url = `${proto}//${window.location.host}/ws/stream?${params.toString()}`;

    try {
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        this.attempt = 0;
        this.setStatus("connected");
        this.startHeartbeat();
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as StreamEnvelope;
          if (typeof parsed.seq === "number" && parsed.seq > this.lastSeq) {
            this.lastSeq = parsed.seq;
            localStorage.setItem(LAST_SEQ_KEY, String(this.lastSeq));
          }
          for (const listener of this.frameListeners) {
            listener(parsed);
          }
          for (const listener of this.statusListeners) {
            listener(this.status, this.lastSeq);
          }
        } catch {
          // Ignore malformed or keepalive non-JSON text frames
        }
      };

      socket.onclose = () => {
        this.stopHeartbeat();
        this.ws = null;
        if (!this.closedByUser) {
          this.scheduleReconnect();
        }
      };

      socket.onerror = () => {
        // onclose will trigger reconnect with backoff
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendWs("ping", { ts: Date.now(), since: this.lastSeq });
    }, 20000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const isOffline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    this.setStatus(isOffline ? "offline" : "reconnecting");
    const delayMs = Math.min(15000, 500 * Math.pow(2, this.attempt));
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  sendWs(type: string, payload: Record<string, unknown> = {}): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ type, payload }));
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleNetworkWake);
      document.removeEventListener("visibilitychange", this.handleVisibilityWake);
    }
  }
}

export const wsClient = new ZeroGWebSocketClient();
