"use client";

import { useMemo } from "react";
import type { JSX } from "react";
import { Html } from "@react-three/drei";
import { formatTokens } from "@/lib/view-model";
import { CHIP_HEIGHT, chipCountForStack, COLORS, FELT_Y } from "./constants";
import { getChipGeometry, getChipMaterials, getGoldChipMaterial } from "./shared";

interface PotProps {
  pot: number;
}

/** Central pot: a small chip cluster plus a gold label. */
export default function Pot({ pot }: PotProps): JSX.Element | null {
  const piles = useMemo(() => {
    if (pot <= 0) return [];
    const total = chipCountForStack(pot);
    // split into up to 3 mini piles for a natural cluster
    const pileCount = total > 9 ? 3 : total > 5 ? 2 : 1;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [0.3, 0.14],
      [-0.26, 0.2],
    ];
    const result: Array<{ x: number; z: number; chips: number }> = [];
    let remaining = total;
    for (let p = 0; p < pileCount; p++) {
      const chips = p === pileCount - 1 ? remaining : Math.ceil(total / pileCount);
      const off = offsets[p] ?? [0, 0];
      result.push({ x: off[0], z: off[1], chips: Math.max(1, chips) });
      remaining -= chips;
    }
    return result;
  }, [pot]);

  if (pot <= 0) return null;

  const chipGeom = getChipGeometry();
  const chipMats = getChipMaterials();
  const goldMat = getGoldChipMaterial();

  return (
    <group position={[0, 0, 0.78]}>
      {piles.map((pile, pi) => (
        <group key={pi} position={[pile.x, 0, pile.z]}>
          {Array.from({ length: pile.chips }, (_, ci) => {
            const top = ci === pile.chips - 1;
            const mat = top ? goldMat : chipMats[(ci + pi) % chipMats.length];
            return (
              <mesh
                key={ci}
                geometry={chipGeom}
                {...(mat ? { material: mat } : {})}
                position={[
                  Math.sin(ci * 2.4 + pi) * 0.012,
                  FELT_Y + CHIP_HEIGHT / 2 + ci * CHIP_HEIGHT,
                  Math.cos(ci * 1.7 + pi) * 0.012,
                ]}
              />
            );
          })}
        </group>
      ))}
      <Html position={[0, 0.52, 0]} center distanceFactor={7} zIndexRange={[20, 10]}>
        <div
          style={{
            whiteSpace: "nowrap",
            padding: "5px 14px",
            borderRadius: 999,
            background: "rgba(7, 15, 36, 0.78)",
            border: "1px solid rgba(216, 180, 90, 0.5)",
            color: COLORS.gold,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontVariantNumeric: "tabular-nums",
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: "0.08em",
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          POT {formatTokens(pot)}
        </div>
      </Html>
    </group>
  );
}
