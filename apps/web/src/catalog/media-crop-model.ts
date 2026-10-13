import type { NormalizedMediaCropRect } from "@polaris/domain/catalog/media";

const MIN_SIZE = 0.01;
const SIZE_STEP = 0.05;
const MOVE_STEP = 0.01;

export const cropArrowKeys: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
]);

function between(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export interface CropKeyModifiers {
  /** Resize from the top and left edges instead of the bottom and right. */
  alt: boolean;
  /** Move the whole area instead of resizing it. */
  shift: boolean;
}

/**
 * One arrow-key step on the crop area:
 * - Shift moves the whole area;
 * - Alt resizes from the top-left corner: Left/Up grow the area outward and
 *   Right/Down shrink it;
 * - no modifier resizes from the bottom-right corner: Right/Down grow it and
 *   Left/Up shrink it.
 * Every edge can be reached, so every corner can be adjusted from the keyboard.
 */
export function adjustCropWithKey(
  crop: NormalizedMediaCropRect,
  key: string,
  modifiers: CropKeyModifiers
): NormalizedMediaCropRect {
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";

  if (modifiers.shift) {
    const delta = direction * MOVE_STEP;
    return horizontal
      ? { ...crop, x: between(crop.x + delta, 0, 1 - crop.width) }
      : { ...crop, y: between(crop.y + delta, 0, 1 - crop.height) };
  }

  if (modifiers.alt) {
    // Moving the near edge by `delta` keeps the far edge in place.
    const delta = direction * SIZE_STEP;
    if (horizontal) {
      const farEdge = crop.x + crop.width;
      const x = between(crop.x + delta, 0, farEdge - MIN_SIZE);
      return { ...crop, width: farEdge - x, x };
    }
    const farEdge = crop.y + crop.height;
    const y = between(crop.y + delta, 0, farEdge - MIN_SIZE);
    return { ...crop, height: farEdge - y, y };
  }

  const delta = direction * SIZE_STEP;
  return horizontal
    ? {
        ...crop,
        width: between(crop.width + delta, MIN_SIZE, 1 - crop.x),
      }
    : {
        ...crop,
        height: between(crop.height + delta, MIN_SIZE, 1 - crop.y),
      };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The crop in words, for the live region that follows keyboard changes. */
export function describeCrop(crop: NormalizedMediaCropRect): string {
  if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) {
    return "Recorte: imagem inteira.";
  }
  return `Recorte: ${percent(crop.width)} da largura por ${percent(crop.height)} da altura, a ${percent(crop.x)} da borda esquerda e ${percent(crop.y)} do topo.`;
}
