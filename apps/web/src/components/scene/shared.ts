"use client";

import * as THREE from "three";
import { CARD_H, CARD_W, CHIP_COLORS, CHIP_HEIGHT, CHIP_RADIUS, COLORS } from "./constants";

/**
 * Lazily created module-level geometries and materials, reused by every mesh
 * in the scene to keep draw-call setup and GPU memory modest.
 */

let chipGeom: THREE.CylinderGeometry | null = null;
export function getChipGeometry(): THREE.CylinderGeometry {
  if (!chipGeom) chipGeom = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 24);
  return chipGeom;
}

let cardGeom: THREE.PlaneGeometry | null = null;
export function getCardGeometry(): THREE.PlaneGeometry {
  if (!cardGeom) cardGeom = new THREE.PlaneGeometry(CARD_W, CARD_H);
  return cardGeom;
}

const chipMats: THREE.MeshStandardMaterial[] = [];
export function getChipMaterials(): THREE.MeshStandardMaterial[] {
  if (chipMats.length === 0) {
    for (const color of CHIP_COLORS) {
      chipMats.push(
        new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08 })
      );
    }
  }
  return chipMats;
}

let goldChipMat: THREE.MeshStandardMaterial | null = null;
export function getGoldChipMaterial(): THREE.MeshStandardMaterial {
  if (!goldChipMat) {
    goldChipMat = new THREE.MeshStandardMaterial({
      color: COLORS.gold,
      roughness: 0.32,
      metalness: 0.55,
    });
  }
  return goldChipMat;
}

let ghostChipMat: THREE.MeshStandardMaterial | null = null;
/** Translucent chip material for sitting-out seats (whole seat at 40%). */
export function getGhostChipMaterial(): THREE.MeshStandardMaterial {
  if (!ghostChipMat) {
    ghostChipMat = new THREE.MeshStandardMaterial({
      color: COLORS.feltGlow,
      transparent: true,
      opacity: 0.4,
      roughness: 0.6,
      metalness: 0.05,
    });
  }
  return ghostChipMat;
}

const faceMats = new Map<string, THREE.MeshStandardMaterial>();
let backMat: THREE.MeshStandardMaterial | null = null;

export function getCardBackMaterial(getTex: () => THREE.Texture): THREE.MeshStandardMaterial {
  if (!backMat) {
    backMat = new THREE.MeshStandardMaterial({
      map: getTex(),
      transparent: true,
      alphaTest: 0.4,
      roughness: 0.6,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
  }
  return backMat;
}

let dimBackMat: THREE.MeshStandardMaterial | null = null;
/** Dimmed card back used for folded seats' mucked cards. */
export function getDimmedCardBackMaterial(getTex: () => THREE.Texture): THREE.MeshStandardMaterial {
  if (!dimBackMat) {
    dimBackMat = new THREE.MeshStandardMaterial({
      map: getTex(),
      transparent: true,
      opacity: 0.32,
      alphaTest: 0.1,
      roughness: 0.7,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
  }
  return dimBackMat;
}

export function getCardFaceMaterial(code: string, getTex: (c: string) => THREE.Texture): THREE.MeshStandardMaterial {
  const cached = faceMats.get(code);
  if (cached) return cached;
  const mat = new THREE.MeshStandardMaterial({
    map: getTex(code),
    transparent: true,
    alphaTest: 0.4,
    roughness: 0.6,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  faceMats.set(code, mat);
  return mat;
}
