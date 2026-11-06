/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";

const LABELS = ["Quantidade", "Preço cobrado", "Preço de tabela"] as const;
type FieldLabel = (typeof LABELS)[number];

interface ItemBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface ItemGeometry {
  boxes: Record<FieldLabel, ItemBox>;
  clipped: string[];
  overlaps: string[];
  rem: number;
  width: number;
}

interface InPage {
  boxes: Partial<Record<FieldLabel, ItemBox>>;
  clipped: string[];
  rem: number;
  width: number;
}

function readFields(root: HTMLElement, labels: readonly string[]): InPage {
  const boxes: Record<string, ItemBox> = {};
  const clipped: string[] = [];
  const limit = root.getBoundingClientRect().right + 0.5;
  for (const text of labels) {
    const label = [...root.querySelectorAll("label")].find(
      (candidate) => candidate.textContent?.trim() === text
    );
    const field = label?.closest("[data-slot=field]");
    if (!(label && field)) {
      clipped.push(`${text}: ausente`);
      continue;
    }
    const { bottom, left, right, top } = field.getBoundingClientRect();
    boxes[text] = { bottom, left, right, top };
    const input = field.querySelector("input");
    const cuts = [
      [label.scrollWidth > label.clientWidth, "rótulo cortado"],
      [getComputedStyle(label).textOverflow === "ellipsis", "reticências"],
      [
        Boolean(input && input.scrollWidth > input.clientWidth),
        "valor com rolagem",
      ],
      [
        [field, ...field.querySelectorAll("*")].some(
          (element) => element.getBoundingClientRect().right > limit
        ),
        "passa da direita do item",
      ],
    ] as const;
    for (const [cut, reason] of cuts) {
      if (cut) {
        clipped.push(`${text}: ${reason}`);
      }
    }
  }
  return {
    boxes,
    clipped,
    rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    width: root.getBoundingClientRect().width,
  };
}

function intersect(a: ItemBox, b: ItemBox) {
  return (
    a.left < b.right - 0.5 &&
    b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 &&
    b.top < a.bottom - 0.5
  );
}

/**
 * What the item of the sale shows of its three fields: the boxes, and what is cut or overlapped. A label is cut when
 * its text is wider than its box or ends in an ellipsis; a value is cut when the input scrolls inside; a box that
 * leaves the item on the right is cut by the page or by the card around it.
 */
export async function measureItem(item: Locator): Promise<ItemGeometry> {
  const read = await item.evaluate(readFields, LABELS);
  const overlaps: string[] = [];
  const present = LABELS.filter((name) => read.boxes[name]);
  for (const [index, first] of present.entries()) {
    for (const second of present.slice(index + 1)) {
      const a = read.boxes[first];
      const b = read.boxes[second];
      if (a && b && intersect(a, b)) {
        overlaps.push(`${first} × ${second}`);
      }
    }
  }
  return { ...read, boxes: read.boxes as ItemGeometry["boxes"], overlaps };
}

type Layout = "tres" | "celular" | "empilhada";

/** The disposition of the three fields, read from where their boxes are. */
export function layoutOf({ boxes }: ItemGeometry): Layout {
  const quantity = boxes.Quantidade;
  const charged = boxes["Preço cobrado"];
  const listed = boxes["Preço de tabela"];
  const sameRow = (a: ItemBox, b: ItemBox) => Math.abs(a.top - b.top) < 1;
  if (sameRow(quantity, charged) && sameRow(quantity, listed)) {
    return "tres";
  }
  return sameRow(quantity, charged) ? "celular" : "empilhada";
}

export async function setBrowserFont(page: Page, pixels: number) {
  const session = await page.context().newCDPSession(page);
  await session.send("Page.setFontSizes", {
    fontSizes: { fixed: pixels, standard: pixels },
  });
}

function stateProblems(root: HTMLElement) {
  const problems: string[] = [];
  const itemRight = root.getBoundingClientRect().right + 0.5;
  const fields = [...root.querySelectorAll("[data-slot=field]")];
  const texts = [
    ...root.querySelectorAll(
      "[role=status], [role=note], [id$=-error], [role=alert]"
    ),
  ].filter((element) => element.getClientRects().length > 0);
  for (const text of texts) {
    const name = (text.textContent ?? "").trim().slice(0, 28);
    const box = text.getBoundingClientRect();
    if (text.scrollWidth > text.clientWidth || box.right > itemRight) {
      problems.push(`cortado: ${name}`);
    }
    for (const field of fields) {
      const other = field.getBoundingClientRect();
      const inside = field.contains(text) || text.contains(field);
      const crosses =
        box.left < other.right - 0.5 &&
        other.left < box.right - 0.5 &&
        box.top < other.bottom - 0.5 &&
        other.top < box.bottom - 0.5;
      if (crosses && !inside) {
        problems.push(`sobrepõe campo: ${name}`);
      }
    }
  }
  return { checked: texts.length, problems };
}

/** The warnings, hints and errors of the item: none is cut by the item's right edge or sits over another field. */
export async function measureStates(item: Locator) {
  const { checked, problems } = await item.evaluate(stateProblems);
  return { checked, problems };
}
