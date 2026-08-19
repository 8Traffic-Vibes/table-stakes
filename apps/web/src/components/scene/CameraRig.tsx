"use client";

import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RAIL_RX } from "./constants";

const DRIFT_DEG = 6;
const DRIFT_PERIOD_S = 20;
const DESKTOP_RADIUS = 7.6;
const DESKTOP_ELEVATION = 0.62; // rad, ~35deg
const MOBILE_ELEVATION = 0.95; // rad, ~54deg — higher angle to frame the oval in portrait

export interface CameraRigProps {
  quality: "mobile" | "desktop";
  reducedMotion: boolean;
}

/**
 * Manual camera control (no OrbitControls): desktop drifts +/-6deg over 20s;
 * mobile sits at a fixed higher angle with distance derived from viewport
 * aspect so the full oval fits in portrait.
 */
export default function CameraRig({ quality, reducedMotion }: CameraRigProps): null {
  const size = useThree((s) => s.size);

  useFrame(({ camera, clock, scene }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;

    if (quality === "mobile") {
      // Fit the table's bounding sphere in the frustum — correct at ANY
      // aspect, portrait or squat: distance = R / sin(min half-angle).
      const aspect = Math.max(0.3, size.width / Math.max(1, size.height));
      const halfV = THREE.MathUtils.degToRad(camera.fov) / 2;
      const halfH = Math.atan(Math.tan(halfV) * aspect);
      const sphereR = RAIL_RX + 0.9;
      const dist = THREE.MathUtils.clamp(
        sphereR / Math.sin(Math.min(halfV, halfH)),
        6.0,
        30,
      );
      camera.position.set(
        0,
        Math.sin(MOBILE_ELEVATION) * dist,
        Math.cos(MOBILE_ELEVATION) * dist,
      );
      // Slight downward aim bias lifts the table toward the upper half —
      // the action bar and chat sheet own the bottom on phones.
      camera.lookAt(0, -0.5, 0);
      // The static fog range is tuned for the desktop camera (~7.6 away);
      // portrait fit can sit 20+ units out, which would fog the table into
      // pure navy. Keep fog relative to the camera instead.
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.near = Math.max(1, dist - sphereR);
        scene.fog.far = dist + sphereR * 3;
      }
      return;
    }

    const drift = reducedMotion
      ? 0
      : Math.sin((clock.elapsedTime * Math.PI * 2) / DRIFT_PERIOD_S) *
        THREE.MathUtils.degToRad(DRIFT_DEG);
    const az = drift;
    const y = Math.sin(DESKTOP_ELEVATION) * DESKTOP_RADIUS;
    const ground = Math.cos(DESKTOP_ELEVATION) * DESKTOP_RADIUS;
    camera.position.set(Math.sin(az) * ground, y, Math.cos(az) * ground);
    camera.lookAt(0, 0.05, 0);
  });

  return null;
}
