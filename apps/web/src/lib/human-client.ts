"use client";

/**
 * Human-mode client: one hook (`useRoom`) that keeps a live TableVM via SSE
 * and POSTs ops back, plus lobby helpers and seat-token persistence.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TableVM } from "./view-model";

export interface SeatSession {
  readonly token: string;
  readonly playerId: string;
  readonly name: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const seatKey = (roomId: string): string => `ts-seat-${roomId.toUpperCase()}`;

export function loadSeat(roomId: string): SeatSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(seatKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SeatSession>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.playerId !== "string" ||
      typeof parsed.name !== "string"
    ) {
      return null;
    }
    return { token: parsed.token, playerId: parsed.playerId, name: parsed.name };
  } catch {
    return null;
  }
}

export function saveSeat(roomId: string, seat: SeatSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(seatKey(roomId), JSON.stringify(seat));
  } catch {
    /* storage full or blocked — session continues in memory */
  }
}

export function clearSeat(roomId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(seatKey(roomId));
  } catch {
    /* ignore */
  }
}

type CreateResult =
  | { ok: true; roomId: string; token: string; playerId: string }
  | { ok: false; error: string };

export async function createRoom(name: string): Promise<CreateResult> {
  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      !res.ok ||
      typeof data.roomId !== "string" ||
      typeof data.token !== "string" ||
      typeof data.playerId !== "string"
    ) {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : "could not open a table",
      };
    }
    saveSeat(data.roomId, { token: data.token, playerId: data.playerId, name: name.trim() });
    return { ok: true, roomId: data.roomId, token: data.token, playerId: data.playerId };
  } catch {
    return { ok: false, error: "network hiccup — try again" };
  }
}

type JoinResult =
  | { ok: true; token: string; playerId: string }
  | { ok: false; error: string };

export async function joinRoom(roomId: string, name: string): Promise<JoinResult> {
  const id = roomId.toUpperCase();
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(id)}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "join", name }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof data.token !== "string" || typeof data.playerId !== "string") {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : "could not sit you down",
      };
    }
    saveSeat(id, { token: data.token, playerId: data.playerId, name: name.trim() });
    return { ok: true, token: data.token, playerId: data.playerId };
  } catch {
    return { ok: false, error: "network hiccup — try again" };
  }
}

export interface RoomConnection {
  readonly vm: TableVM | null;
  readonly error: string | null;
  readonly connected: boolean;
  readonly send: (op: string, payload?: Record<string, unknown>) => Promise<ActionResult>;
}

const MAX_BACKOFF_MS = 15_000;

/**
 * Live room subscription. Pass `token: null` to spectate.
 * Reconnects with exponential backoff; a `room_error` event (bad/expired room)
 * sets `error` and stops retrying.
 */
export function useRoom(roomId: string | null, token: string | null): RoomConnection {
  const [vm, setVm] = useState<TableVM | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    if (!roomId) return;
    const id = roomId.toUpperCase();
    let disposed = false;
    let dead = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = (): void => {
      if (disposed || dead) return;
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      source = new EventSource(`/api/rooms/${encodeURIComponent(id)}/stream${qs}`);

      source.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      source.onmessage = (event: MessageEvent<string>) => {
        attempt = 0;
        setConnected(true);
        try {
          setVm(JSON.parse(event.data) as TableVM);
          setError(null);
        } catch {
          /* malformed snapshot — wait for the next one */
        }
      };

      source.addEventListener("room_error", () => {
        dead = true;
        setConnected(false);
        setError("table not found — it may have expired");
        source?.close();
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (disposed || dead) return;
        attempt += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 700 * 2 ** Math.min(attempt, 5));
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
  }, [roomId, token]);

  const send = useCallback(
    async (op: string, payload?: Record<string, unknown>): Promise<ActionResult> => {
      if (!roomId) return { ok: false, error: "no table" };
      try {
        const res = await fetch(
          `/api/rooms/${encodeURIComponent(roomId.toUpperCase())}/action`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op, token: tokenRef.current ?? "", ...payload }),
          },
        );
        if (res.ok) return { ok: true };
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          ok: false,
          error: typeof data.error === "string" ? data.error : "that didn't go through",
        };
      } catch {
        return { ok: false, error: "network hiccup — try again" };
      }
    },
    [roomId],
  );

  return { vm, error, connected, send };
}
