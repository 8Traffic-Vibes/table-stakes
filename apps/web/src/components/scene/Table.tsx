"use client";

import { useMemo } from "react";
import type { JSX } from "react";
import * as THREE from "three";
import { COLORS, RAIL_RX, RAIL_RZ, TABLE_RX, TABLE_RZ } from "./constants";

function ellipseShape(rx: number, rz: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false, 0);
  return s;
}

/** Radial glow texture painted on the floor beneath the table. */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(47,130,102,0.34)");
    g.addColorStop(0.45, "rgba(26,42,82,0.22)");
    g.addColorStop(1, "rgba(10,21,48,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Felt oval + walnut rail with a thin gold inlay, on a pedestal over a glowing floor. */
export default function Table(): JSX.Element {
  const feltGeom = useMemo(() => {
    const geom = new THREE.ExtrudeGeometry(ellipseShape(TABLE_RX, TABLE_RZ), {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.03,
      bevelSegments: 3,
      curveSegments: 64,
    });
    geom.rotateX(-Math.PI / 2);
    return geom;
  }, []);

  const railGeom = useMemo(() => {
    const outer = ellipseShape(RAIL_RX, RAIL_RZ);
    outer.holes.push(new THREE.Path().absellipse(0, 0, TABLE_RX - 0.02, TABLE_RZ - 0.02, 0, Math.PI * 2, true, 0));
    const geom = new THREE.ExtrudeGeometry(outer, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 4,
      curveSegments: 64,
    });
    geom.rotateX(-Math.PI / 2);
    return geom;
  }, []);

  const inlayGeom = useMemo(() => {
    const outer = ellipseShape(TABLE_RX + 0.09, TABLE_RZ + 0.09);
    outer.holes.push(new THREE.Path().absellipse(0, 0, TABLE_RX + 0.05, TABLE_RZ + 0.05, 0, Math.PI * 2, true, 0));
    const geom = new THREE.ShapeGeometry(outer, 64);
    geom.rotateX(-Math.PI / 2);
    return geom;
  }, []);

  const glowTex = useMemo(() => makeGlowTexture(), []);

  const feltMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: COLORS.felt, roughness: 0.42, metalness: 0.06 }),
    []
  );
  const railMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: COLORS.walnut, roughness: 0.34, metalness: 0.18 }),
    []
  );
  const inlayMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: COLORS.gold, roughness: 0.28, metalness: 0.7 }),
    []
  );

  return (
    <group>
      {/* felt top (surface at y ~ FELT_Y) */}
      <mesh geometry={feltGeom} material={feltMat} position={[0, -0.05, 0]} receiveShadow />
      {/* walnut rail ring */}
      <mesh geometry={railGeom} material={railMat} position={[0, -0.06, 0]} />
      {/* gold inlay line on the rail top */}
      <mesh geometry={inlayGeom} material={inlayMat} position={[0, 0.105, 0]} />
      {/* pedestal */}
      <mesh position={[0, -0.62, 0]}>
        <cylinderGeometry args={[1.1, 1.5, 1.1, 40]} />
        <meshStandardMaterial color={COLORS.walnutDark} roughness={0.5} metalness={0.12} />
      </mesh>
      {/* floor with soft radial glow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.18, 0]}>
        <planeGeometry args={[26, 26]} />
        <meshBasicMaterial map={glowTex} transparent depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.2, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color={COLORS.navyDeep} roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}
