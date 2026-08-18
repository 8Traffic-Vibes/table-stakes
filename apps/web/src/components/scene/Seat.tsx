"use client";

import { useMemo, useRef } from "react";
import type { JSX } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { SeatVM } from "@/lib/view-model";
import { formatTokens } from "@/lib/view-model";
import Card3D from "./Card3D";
import {
  CHIP_HEIGHT,
  chipCountForStack,
  COLORS,
  FELT_Y,
  type SeatPlacement,
} from "./constants";
import { getChipGeometry, getChipMaterials, getGhostChipMaterial, getGoldChipMaterial } from "./shared";

let dealerTex: THREE.CanvasTexture | null = null;
function getDealerTexture(): THREE.CanvasTexture {
  if (dealerTex) return dealerTex;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.font = "700 72px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("D", 64, 68);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ACTOR_RING_CSS = `
@keyframes ts-actor-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes ts-react-float {
  0% { transform: translateY(0); opacity: 0; }
  12% { opacity: 1; }
  100% { transform: translateY(-64px); opacity: 0; }
}`;

export interface SeatProps {
  seat: SeatVM;
  placement: SeatPlacement;
  /** performance.now() when this seat won chips; null when idle. */
  pulseAt: number | null;
  /** Floating reactions currently alive for this seat. */
  floaters: ReadonlyArray<{ seq: number; emoji: string }>;
  reducedMotion: boolean;
}

/** One seat: chip stack, hole cards, name plate, dealer button, win pulse. */
export default function Seat({ seat, placement, pulseAt, floaters, reducedMotion }: SeatProps): JSX.Element {
  const ringRef = useRef<THREE.Mesh>(null);
  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: COLORS.gold,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    []
  );

  useFrame(() => {
    const ring = ringRef.current;
    if (!ring) return;
    if (pulseAt === null || reducedMotion) {
      ring.visible = false;
      return;
    }
    const t = (performance.now() - pulseAt) / 1500;
    if (t >= 1) {
      ring.visible = false;
      return;
    }
    ring.visible = true;
    const s = 0.7 + t * 0.9;
    ring.scale.set(s, s, 1);
    ringMat.opacity = 0.65 * (1 - t);
  });

  const chipCount = useMemo(() => chipCountForStack(seat.stack), [seat.stack]);
  const chipGeom = getChipGeometry();
  const chipMats = getChipMaterials();
  const goldMat = getGoldChipMaterial();

  const seatOpacity = seat.sittingOut ? 0.4 : 1;
  const hasCards = seat.holeCards === null || (seat.holeCards?.length ?? 0) > 0;
  const cardCodes: ReadonlyArray<string | null> =
    seat.holeCards && seat.holeCards.length > 0 ? seat.holeCards : [null, null];

  return (
    <group position={[placement.x, 0, placement.z]} rotation={[0, placement.rotY, 0]}>
      {/* winner pulse ring, flat on the felt */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, FELT_Y + 0.006, 0]} visible={false} material={ringMat}>
        <ringGeometry args={[0.5, 0.6, 48]} />
      </mesh>

      {/* chip stack, slightly right of the cards */}
      <group position={[0.38, 0, -0.05]}>
        {Array.from({ length: chipCount }, (_, i) => {
          const mat = seat.sittingOut ? getGhostChipMaterial() : chipMats[i % chipMats.length];
          return (
            <mesh
              key={i}
              geometry={chipGeom}
              {...(mat ? { material: mat } : {})}
              position={[
                Math.sin(i * 2.1) * 0.014,
                FELT_Y + CHIP_HEIGHT / 2 + i * CHIP_HEIGHT,
                Math.cos(i * 1.6) * 0.014,
              ]}
              rotation={[0, i * 0.55, 0]}
            />
          );
        })}
        {/* gold edge cap on the top chip */}
        <mesh
          geometry={chipGeom}
          material={seat.sittingOut ? getGhostChipMaterial() : goldMat}
          position={[
            Math.sin((chipCount - 1) * 2.1) * 0.014,
            FELT_Y + chipCount * CHIP_HEIGHT + 0.005,
            Math.cos((chipCount - 1) * 1.6) * 0.014,
          ]}
          scale={[1.001, 0.24, 1.001]}
        />
      </group>

      {/* two hole cards angled in front of the seat; folded slides them back + dims */}
      {hasCards ? (
        <group position={[-0.18, 0, seat.folded ? -0.34 : 0.22]}>
          {cardCodes.slice(0, 2).map((code, i) => (
            <group
              key={i}
              position={[i * 0.24 - 0.12, FELT_Y + 0.01 + i * 0.004, 0]}
              rotation={[0, (i === 0 ? 1 : -1) * 0.14, 0]}
            >
              <Card3D
                code={seat.folded ? null : code}
                dimmed={seat.folded || seat.sittingOut}
                rotation={[-Math.PI / 2, 0, 0]}
              />
            </group>
          ))}
        </group>
      ) : null}

      {/* dealer button */}
      {seat.isDealer ? (
        <mesh position={[-0.55, FELT_Y + 0.02, 0.05]}>
          <cylinderGeometry args={[0.09, 0.09, 0.035, 24]} />
          <meshStandardMaterial map={getDealerTexture()} color="#f4f1ea" roughness={0.35} metalness={0.05} />
        </mesh>
      ) : null}

      {/* name plate, floated outward past the rail */}
      <Html position={[0, 0.34, -0.62]} center distanceFactor={7.5} zIndexRange={[30, 15]}>
        <div style={{ position: "relative", pointerEvents: "none", userSelect: "none", opacity: seatOpacity }}>
          <style>{ACTOR_RING_CSS}</style>
          {/* floating emoji reactions */}
          {floaters.map((f) => (
            <div
              key={f.seq}
              style={{
                position: "absolute",
                left: "50%",
                top: -34,
                marginLeft: -14,
                fontSize: 26,
                animation: reducedMotion ? "none" : "ts-react-float 2s ease-out forwards",
                opacity: reducedMotion ? 0 : 1,
              }}
            >
              {f.emoji}
            </div>
          ))}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 14px",
              borderRadius: 999,
              background: "rgba(7, 15, 36, 0.82)",
              border: seat.isActor ? `2px solid ${COLORS.primary}` : "1px solid rgba(216, 180, 90, 0.28)",
              boxShadow: seat.isActor ? "0 0 14px rgba(86, 69, 212, 0.55)" : "0 2px 10px rgba(7, 15, 36, 0.5)",
              whiteSpace: "nowrap",
            }}
          >
            {seat.isActor ? (
              <span
                style={{
                  position: "absolute",
                  inset: -7,
                  borderRadius: 999,
                  background: `conic-gradient(${COLORS.primary} 0deg 80deg, transparent 80deg 360deg)`,
                  WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
                  mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
                  animation: reducedMotion ? "none" : "ts-actor-spin 3s linear infinite",
                }}
              />
            ) : null}
            <span style={{ color: "#ffffff", fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-ui, sans-serif)" }}>
              {seat.name}
            </span>
            <span
              style={{
                color: COLORS.gold,
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatTokens(seat.stack)}
            </span>
          </div>
          {seat.lastAction ? (
            <div
              style={{
                marginTop: 4,
                textAlign: "center",
                fontSize: 10.5,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "rgba(164, 160, 151, 0.95)",
                fontFamily: "var(--font-ui, sans-serif)",
              }}
            >
              {seat.lastAction}
            </div>
          ) : null}
        </div>
      </Html>
    </group>
  );
}
