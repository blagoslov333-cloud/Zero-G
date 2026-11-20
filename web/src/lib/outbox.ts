import type { OutboxItem } from "../types/contracts";

const DB_NAME = "0g_outbox_db";
const STORE_NAME = "steering_outbox";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "clientMsgId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

export async function enqueueOutbox(item: OutboxItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Failed to enqueue outbox item"));
    };
  });
}

export async function listOutbox(): Promise<OutboxItem[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        db.close();
        const items = (req.result as OutboxItem[]) || [];
        items.sort((a, b) => a.createdAt - b.createdAt);
        resolve(items);
      };
      req.onerror = () => {
        db.close();
        reject(req.error || new Error("Failed to read outbox"));
      };
    });
  } catch {
    return [];
  }
}

export async function removeOutbox(clientMsgId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(clientMsgId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Failed to delete outbox item"));
    };
  });
}

export async function updateOutboxItem(
  clientMsgId: string,
  patch: Partial<OutboxItem>
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(clientMsgId);
    getReq.onsuccess = () => {
      const existing = getReq.result as OutboxItem | undefined;
      if (existing) {
        store.put({ ...existing, ...patch });
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Failed to update outbox item"));
    };
  });
}

export function generateClientMsgId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
