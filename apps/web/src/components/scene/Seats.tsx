"use client";

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { TableVM } from "@/lib/view-model";
import Seat from "./Seat";
import { MAX_SEATS, seatPlacement } from "./constants";

interface Floater {
  seq: number;
  playerKey: string;
  emoji: string;
}

interface SeatsProps {
  vm: TableVM;
  reducedMotion: boolean;
}

/**
 * Maps vm.seats to <Seat>, and owns the cross-update bookkeeping:
 * - winner pulse: a seat whose stack grew during "playing" gets a gold ring
 * - reactions: new vm.reactions entries float up from the reacting seat
 */
export default function Seats({ vm, reducedMotion }: SeatsProps): JSX.Element {
  const prevStacks = useRef<Map<string, number>>(new Map());
  const [pulses, setPulses] = useState<Map<string, number>>(new Map());

  const lastReactionSeq = useRef(0);
  const [floaters, setFloaters] = useState<Floater[]>([]);

  // winner pulse detection
  useEffect(() => {
    const next = new Map<string, number>();
    for (const seat of vm.seats) next.set(seat.playerId, seat.stack);
    if (vm.phase === "playing" && prevStacks.current.size > 0) {
      const winners: string[] = [];
      for (const seat of vm.seats) {
        const prev = prevStacks.current.get(seat.playerId);
        if (prev !== undefined && seat.stack > prev) winners.push(seat.playerId);
      }
      if (winners.length > 0) {
        const now = performance.now();
        setPulses((old) => {
          const merged = new Map(old);
          for (const id of winners) merged.set(id, now);
          return merged;
        });
        const timer = setTimeout(() => {
          setPulses((old) => {
            const trimmed = new Map(old);
            for (const id of winners) trimmed.delete(id);
            return trimmed;
          });
        }, 1600);
        prevStacks.current = next;
        return () => clearTimeout(timer);
      }
    }
    prevStacks.current = next;
    return undefined;
  }, [vm.seats, vm.phase]);

  // reaction floaters
  useEffect(() => {
    const fresh = vm.reactions.filter((r) => r.seq > lastReactionSeq.current);
    if (fresh.length === 0) return undefined;
    lastReactionSeq.current = Math.max(...vm.reactions.map((r) => r.seq), lastReactionSeq.current);
    const added: Floater[] = fresh.map((r) => ({ seq: r.seq, playerKey: r.from, emoji: r.emoji }));
    setFloaters((old) => [...old, ...added]);
    const timer = setTimeout(() => {
      const seqs = new Set(added.map((f) => f.seq));
      setFloaters((old) => old.filter((f) => !seqs.has(f.seq)));
    }, 2200);
    return () => clearTimeout(timer);
  }, [vm.reactions]);

  const seats = vm.seats.slice(0, MAX_SEATS);

  return (
    <group>
      {seats.map((seat, i) => {
        const placement = seatPlacement(i, seats.length);
        const seatFloaters = floaters
          .filter((f) => f.playerKey === seat.playerId || f.playerKey === seat.name)
          .map((f) => ({ seq: f.seq, emoji: f.emoji }));
        return (
          <Seat
            key={seat.playerId}
            seat={seat}
            placement={placement}
            pulseAt={pulses.get(seat.playerId) ?? null}
            floaters={seatFloaters}
            reducedMotion={reducedMotion}
          />
        );
      })}
    </group>
  );
}
