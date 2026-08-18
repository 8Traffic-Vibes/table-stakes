"use client";

import * as THREE from "three";
import { COLORS } from "./constants";

/**
 * CanvasTexture factory for card faces ("As", "Td", ...) and the shared navy
 * card back. Textures are cached in module maps so each code is drawn once.
 */

const FACE_CACHE = new Map<string, THREE.CanvasTexture>();
let BACK_TEXTURE: THREE.CanvasTexture | null = null;

const CW = 256;
const CH = 358;
const CORNER = 26;

const SUIT_GLYPH: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return [canvas, ctx];
}

function finishTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Face texture for a code like "As", "Td", "9h". Cached per code. */
export function getCardFaceTexture(code: string): THREE.CanvasTexture {
  const cached = FACE_CACHE.get(code);
  if (cached) return cached;

  const [canvas, ctx] = makeCanvas();
  const rank = code.charAt(0).toUpperCase();
  const suit = code.charAt(1)?.toLowerCase() ?? "s";
  const glyph = SUIT_GLYPH[suit] ?? "♠";
  const red = suit === "h" || suit === "d";
  const inkColor = red ? COLORS.cardRed : COLORS.ink;
  const rankLabel = rank === "T" ? "10" : rank;

  ctx.clearRect(0, 0, CW, CH);
  roundedRect(ctx, 0, 0, CW, CH, CORNER);
  ctx.fillStyle = "#fdfdfa";
  ctx.fill();
  // hairline edge
  roundedRect(ctx, 3, 3, CW - 6, CH - 6, CORNER - 3);
  ctx.strokeStyle = "rgba(26,26,26,0.12)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // rank top-left (+ small suit under it), mirrored bottom-right
  ctx.fillStyle = inkColor;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 64px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(rankLabel, 20, 70);
  ctx.font = "48px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(glyph, 22, 122);
  ctx.save();
  ctx.translate(CW, CH);
  ctx.rotate(Math.PI);
  ctx.font = "700 64px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(rankLabel, 20, 70);
  ctx.font = "48px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(glyph, 22, 122);
  ctx.restore();

  // large center suit glyph
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "150px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(glyph, CW / 2, CH / 2 + 8);

  const tex = finishTexture(canvas);
  FACE_CACHE.set(code, tex);
  return tex;
}

/** Shared navy card back with a gold border pattern. */
export function getCardBackTexture(): THREE.CanvasTexture {
  if (BACK_TEXTURE) return BACK_TEXTURE;

  const [canvas, ctx] = makeCanvas();
  ctx.clearRect(0, 0, CW, CH);
  roundedRect(ctx, 0, 0, CW, CH, CORNER);
  ctx.fillStyle = COLORS.navy;
  ctx.fill();

  // double gold border
  roundedRect(ctx, 12, 12, CW - 24, CH - 24, CORNER - 8);
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 4;
  ctx.stroke();
  roundedRect(ctx, 24, 24, CW - 48, CH - 48, CORNER - 14);
  ctx.strokeStyle = "rgba(216,180,90,0.45)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // diamond lattice
  ctx.save();
  roundedRect(ctx, 30, 30, CW - 60, CH - 60, CORNER - 16);
  ctx.clip();
  ctx.strokeStyle = "rgba(216,180,90,0.22)";
  ctx.lineWidth = 1.5;
  const step = 28;
  for (let i = -CH; i < CW + CH; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + CH, CH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i + CH, 0);
    ctx.lineTo(i, CH);
    ctx.stroke();
  }
  ctx.restore();

  // center medallion
  ctx.fillStyle = "rgba(216,180,90,0.8)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "44px Georgia, serif";
  ctx.fillText("♦", CW / 2, CH / 2);

  BACK_TEXTURE = finishTexture(canvas);
  return BACK_TEXTURE;
}
