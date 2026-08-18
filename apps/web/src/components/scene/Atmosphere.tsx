"use client";

import { useMemo, useRef } from "react";
import type { JSX } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { COLORS } from "./constants";

const DUST_COUNT = 100;

function Dust({ animate }: { animate: boolean }): JSX.Element {
  const pointsRef = useRef<THREE.Points>(null);
  const seeds = useMemo(() => {
    const positions = new Float32Array(DUST_COUNT * 3);
    const phases = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 11;
      positions[i * 3 + 1] = Math.random() * 3.4 - 0.4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 8;
      phases[i] = Math.random() * Math.PI * 2;
    }
    return { positions, phases };
  }, []);

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(seeds.positions.slice(), 3));
    return geom;
  }, [seeds]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: COLORS.gold,
        size: 0.02,
        transparent: true,
        opacity: 0.34,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    []
  );

  useFrame(({ clock }) => {
    if (!animate || !pointsRef.current) return;
    const t = clock.elapsedTime;
    const attr = pointsRef.current.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < DUST_COUNT; i++) {
      const p = seeds.phases[i] ?? 0;
      attr.setY(i, (seeds.positions[i * 3 + 1] ?? 0) + Math.sin(t * 0.25 + p) * 0.25);
      attr.setX(i, (seeds.positions[i * 3] ?? 0) + Math.cos(t * 0.18 + p) * 0.18);
    }
    attr.needsUpdate = true;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

export interface AtmosphereProps {
  /** Dust particles render only on desktop quality. */
  particles: boolean;
  reducedMotion: boolean;
}

/** Navy fog, warm key + cool fill lighting, optional floating dust. */
export default function Atmosphere({ particles, reducedMotion }: AtmosphereProps): JSX.Element {
  // fragment (not <group>) so color/fog attach to the scene itself
  return (
    <>
      <color attach="background" args={[COLORS.navy]} />
      <fog attach="fog" args={[COLORS.navy, 9, 22]} />
      <ambientLight intensity={0.5} color="#c9d4ee" />
      {/* warm key light over the table */}
      <spotLight
        position={[2.6, 6.4, 2.2]}
        angle={0.62}
        penumbra={0.85}
        intensity={92}
        color="#ffe2b0"
        castShadow={false}
      />
      {/* cool fill from the opposite side */}
      <directionalLight position={[-4.5, 3.4, -3.5]} intensity={0.55} color="#7f95d9" />
      {/* faint under-table bounce */}
      <pointLight position={[0, -0.6, 0]} intensity={2.2} color={COLORS.feltGlow} distance={5} />
      {particles ? <Dust animate={!reducedMotion} /> : null}
    </>
  );
}
