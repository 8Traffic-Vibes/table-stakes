"use client";

import { useEffect, useMemo, useRef } from "react";
import type { JSX } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { CARD_W, easeOutCubic, FELT_Y } from "./constants";
import { getCardBackTexture, getCardFaceTexture } from "./cardTextures";
import { getCardBackMaterial, getCardFaceMaterial, getCardGeometry } from "./shared";

const DEAL_MS = 620;
const SLOT_GAP = CARD_W + 0.13;
const REST_Y = FELT_Y + 0.012;

interface BoardProps {
  board: readonly string[];
  reducedMotion: boolean;
}

/** Up to 5 community cards; newly revealed cards rise and flip into place. */
export default function Board({ board, reducedMotion }: BoardProps): JSX.Element {
  const outerRefs = useRef<Array<THREE.Group | null>>([]);
  const innerRefs = useRef<Array<THREE.Group | null>>([]);
  /** index -> deal start timestamp (performance.now ms). */
  const dealStarts = useRef<Map<number, number>>(new Map());
  const prevLen = useRef(0);

  useEffect(() => {
    const len = board.length;
    if (len < prevLen.current) {
      dealStarts.current.clear(); // new hand
    } else if (len > prevLen.current && !reducedMotion) {
      const now = performance.now();
      for (let i = prevLen.current; i < len; i++) {
        // stagger multi-card reveals (flop) slightly
        dealStarts.current.set(i, now + (i - prevLen.current) * 130);
      }
    }
    prevLen.current = len;
  }, [board.length, reducedMotion]);

  useFrame(() => {
    const now = performance.now();
    for (let i = 0; i < board.length; i++) {
      const outer = outerRefs.current[i];
      const inner = innerRefs.current[i];
      if (!outer || !inner) continue;
      const start = dealStarts.current.get(i);
      let t = 1;
      if (start !== undefined) {
        t = (now - start) / DEAL_MS;
        if (t >= 1) {
          dealStarts.current.delete(i);
          t = 1;
        } else if (t < 0) {
          t = 0;
        }
      }
      const e = easeOutCubic(t);
      outer.position.y = REST_Y + Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.3;
      inner.rotation.x = Math.PI * (1 - e);
      outer.visible = t > 0;
    }
  });

  const backMat = useMemo(() => getCardBackMaterial(getCardBackTexture), []);
  const geom = useMemo(() => getCardGeometry(), []);

  return (
    <group position={[0, 0, -0.12]}>
      {board.map((code, i) => (
        <group
          key={`${code}-${i}`}
          ref={(g: THREE.Group | null) => {
            outerRefs.current[i] = g;
          }}
          position={[(i - 2) * SLOT_GAP, REST_Y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <group
            ref={(g: THREE.Group | null) => {
              innerRefs.current[i] = g;
            }}
          >
            <mesh
              geometry={geom}
              material={getCardFaceMaterial(code, getCardFaceTexture)}
              position={[0, 0, 0.0008]}
            />
            <mesh geometry={geom} material={backMat} position={[0, 0, -0.0008]} rotation={[0, Math.PI, 0]} />
          </group>
        </group>
      ))}
    </group>
  );
}
