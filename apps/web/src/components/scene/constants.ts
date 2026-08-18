"use client";

/** Shared layout + palette constants for the Table Stakes 3D scene. */

export const COLORS = {
  navy: "#0a1530",
  navyDeep: "#070f24",
  navyMid: "#1a2a52",
  felt: "#1e5b47",
  feltGlow: "#2f8266",
  gold: "#d8b45a",
  cardRed: "#d43a45",
  ink: "#1a1a1a",
  walnut: "#3b2a1d",
  walnutDark: "#2c1f15",
  primary: "#5645d4",
  white: "#ffffff",
} as const;

/** Felt playing-surface ellipse radii (world units). */
export const TABLE_RX = 3.1;
export const TABLE_RZ = 1.95;
/** Rail outer ellipse radii. */
export const RAIL_RX = TABLE_RX + 0.42;
export const RAIL_RZ = TABLE_RZ + 0.42;
/** Y of the felt surface. */
export const FELT_Y = 0.02;

export const MAX_SEATS = 6;

/** Chip cylinder dimensions. */
export const CHIP_RADIUS = 0.155;
export const CHIP_HEIGHT = 0.042;

/** Card dimensions (world units, poker 2.5:3.5 ratio). */
export const CARD_W = 0.46;
export const CARD_H = 0.644;

/** Felt-toned chip body colors, cycled per stack layer group. */
export const CHIP_COLORS = ["#255f4c", "#1c4a3a", "#2f8266", "#173d30", "#286852"] as const;

export interface SeatPlacement {
  /** Anchor on the felt where the seat's tableau (cards/chips) sits. */
  readonly x: number;
  readonly z: number;
  /** Rotation (Y) so the tableau faces table center. */
  readonly rotY: number;
  /** Outward unit direction from center. */
  readonly outX: number;
  readonly outZ: number;
}

/**
 * Place up to MAX_SEATS seats around the felt ellipse. Seat 0 is at the
 * "bottom" (toward the default camera), proceeding clockwise.
 */
export function seatPlacement(index: number, count: number): SeatPlacement {
  const n = Math.max(1, Math.min(count, MAX_SEATS));
  const angle = Math.PI / 2 + (index / n) * Math.PI * 2;
  const rx = TABLE_RX * 0.74;
  const rz = TABLE_RZ * 0.68;
  const x = Math.cos(angle) * rx;
  const z = Math.sin(angle) * rz;
  const len = Math.hypot(x, z) || 1;
  return {
    x,
    z,
    rotY: Math.atan2(x, z) + Math.PI,
    outX: x / len,
    outZ: z / len,
  };
}

/** Map a token stack to a chip count on a log scale, clamped 3..14. */
export function chipCountForStack(stack: number): number {
  if (stack <= 0) return 3;
  const c = Math.round(3 + Math.log10(1 + stack) * 2.1);
  return Math.max(3, Math.min(14, c));
}

export function easeOutCubic(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - u, 3);
}
