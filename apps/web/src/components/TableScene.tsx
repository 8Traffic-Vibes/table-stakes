"use client";

import { useEffect, type JSX } from "react";
import { Canvas } from "@react-three/fiber";
import type { TableVM } from "@/lib/view-model";
import Atmosphere from "./scene/Atmosphere";
import Board from "./scene/Board";
import CameraRig from "./scene/CameraRig";
import Pot from "./scene/Pot";
import Seats from "./scene/Seats";
import Table from "./scene/Table";
import { COLORS } from "./scene/constants";
import { useReducedMotion } from "./scene/useReducedMotion";

export interface TableSceneProps {
  vm: TableVM;
  /** "mobile" caps dpr, disables antialias + particles, fixes the camera. */
  quality?: "mobile" | "desktop";
}

/**
 * The centerpiece 3D table. Fills its parent (absolute inset 0). Import only
 * via next/dynamic({ ssr: false }).
 */
export default function TableScene({ vm, quality = "desktop" }: TableSceneProps): JSX.Element {
  const reducedMotion = useReducedMotion();
  const mobile = quality === "mobile";

  // R3F occasionally mounts before this container is measured (dynamic import
  // + fresh load), leaving a 300x150 canvas and no render loop until a window
  // resize. Nudge one so the scene always boots.
  useEffect(() => {
    const t1 = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    const t2 = setTimeout(() => window.dispatchEvent(new Event("resize")), 400);
    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: COLORS.navy,
        pointerEvents: "none",
      }}
    >
      <Canvas
        dpr={mobile ? [1, 1.75] : [1, 2]}
        gl={{ antialias: !mobile, powerPreference: "high-performance", alpha: false }}
        camera={{ fov: 46, near: 0.1, far: 80, position: [0, 4.3, 6.2] }}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <Atmosphere particles={!mobile} reducedMotion={reducedMotion} />
        <CameraRig quality={quality} reducedMotion={reducedMotion} />
        <Table />
        <Seats vm={vm} reducedMotion={reducedMotion} />
        <Board board={vm.board} reducedMotion={reducedMotion} />
        <Pot pot={vm.pot} />
      </Canvas>
    </div>
  );
}
