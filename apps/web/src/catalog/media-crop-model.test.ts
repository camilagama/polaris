import { describe, expect, it } from "vitest";
import {
  adjustCropWithKey,
  cropArrowKeys,
  describeCrop,
} from "./media-crop-model";

const plain = { alt: false, shift: false };
const alt = { alt: true, shift: false };
const shift = { alt: false, shift: true };
const area = { height: 0.5, width: 0.5, x: 0.25, y: 0.25 };

describe("adjustCropWithKey", () => {
  it("grows and shrinks from the bottom-right corner with plain arrows", () => {
    expect(adjustCropWithKey(area, "ArrowRight", plain)).toMatchObject({
      width: 0.55,
      x: 0.25,
    });
    expect(adjustCropWithKey(area, "ArrowLeft", plain)).toMatchObject({
      width: 0.45,
      x: 0.25,
    });
    expect(adjustCropWithKey(area, "ArrowDown", plain)).toMatchObject({
      height: 0.55,
      y: 0.25,
    });
    expect(adjustCropWithKey(area, "ArrowUp", plain)).toMatchObject({
      height: 0.45,
      y: 0.25,
    });
  });

  it("grows and shrinks from the top-left corner with Alt, keeping the far edge", () => {
    const grown = adjustCropWithKey(area, "ArrowLeft", alt);
    expect(grown.x).toBeCloseTo(0.2);
    expect(grown.x + grown.width).toBeCloseTo(0.75);

    const shrunk = adjustCropWithKey(area, "ArrowRight", alt);
    expect(shrunk.x).toBeCloseTo(0.3);
    expect(shrunk.x + shrunk.width).toBeCloseTo(0.75);

    const taller = adjustCropWithKey(area, "ArrowUp", alt);
    expect(taller.y).toBeCloseTo(0.2);
    expect(taller.y + taller.height).toBeCloseTo(0.75);

    const shorter = adjustCropWithKey(area, "ArrowDown", alt);
    expect(shorter.y).toBeCloseTo(0.3);
    expect(shorter.y + shorter.height).toBeCloseTo(0.75);
  });

  it("moves the whole area with Shift without changing its size", () => {
    expect(adjustCropWithKey(area, "ArrowRight", shift)).toMatchObject({
      height: 0.5,
      width: 0.5,
      x: 0.26,
    });
    expect(adjustCropWithKey(area, "ArrowUp", shift)).toMatchObject({
      height: 0.5,
      y: 0.24,
    });
  });

  it("never leaves the image or collapses the area", () => {
    const corner = { height: 1, width: 1, x: 0, y: 0 };
    expect(adjustCropWithKey(corner, "ArrowRight", plain)).toEqual(corner);
    expect(adjustCropWithKey(corner, "ArrowLeft", alt)).toEqual(corner);
    expect(adjustCropWithKey(corner, "ArrowRight", shift)).toEqual(corner);
    const tiny = { height: 0.02, width: 0.02, x: 0.5, y: 0.5 };
    expect(adjustCropWithKey(tiny, "ArrowLeft", plain).width).toBe(0.01);
    expect(adjustCropWithKey(tiny, "ArrowRight", alt).width).toBeGreaterThan(
      0.0099
    );
    const edge = { height: 0.5, width: 0.3, x: 0.7, y: 0 };
    expect(adjustCropWithKey(edge, "ArrowRight", shift).x).toBeCloseTo(0.7);
  });

  it("only reacts to arrow keys", () => {
    expect(cropArrowKeys.has("ArrowUp")).toBe(true);
    expect(cropArrowKeys.has("Enter")).toBe(false);
    expect(cropArrowKeys.size).toBe(4);
  });
});

describe("describeCrop", () => {
  it("says the whole image is used when nothing is cropped", () => {
    expect(describeCrop({ height: 1, width: 1, x: 0, y: 0 })).toBe(
      "Recorte: imagem inteira."
    );
  });

  it("describes size and position in percentages for a screen reader", () => {
    expect(describeCrop(area)).toBe(
      "Recorte: 50% da largura por 50% da altura, a 25% da borda esquerda e 25% do topo."
    );
  });
});
