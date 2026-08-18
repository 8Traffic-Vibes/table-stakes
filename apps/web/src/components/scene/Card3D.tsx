"use client";

import { useMemo } from "react";
import type { JSX } from "react";
import { getCardBackTexture, getCardFaceTexture } from "./cardTextures";
import {
  getCardBackMaterial,
  getCardFaceMaterial,
  getCardGeometry,
  getDimmedCardBackMaterial,
} from "./shared";

export interface Card3DProps {
  /** Card code like "As"; null renders the navy back. */
  code: string | null;
  dimmed?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number];
}

/** One flat card mesh; geometry and materials are shared module singletons. */
export default function Card3D({ code, dimmed = false, position, rotation }: Card3DProps): JSX.Element {
  const material = useMemo(() => {
    if (code) return getCardFaceMaterial(code, getCardFaceTexture);
    if (dimmed) return getDimmedCardBackMaterial(getCardBackTexture);
    return getCardBackMaterial(getCardBackTexture);
  }, [code, dimmed]);

  return (
    <mesh
      geometry={getCardGeometry()}
      material={material}
      {...(position ? { position } : {})}
      {...(rotation ? { rotation } : {})}
    />
  );
}
