import { describe, expect, it } from "vitest";
import {
  createTypedFields,
  type FieldLike,
  type SwapState,
  swapHolds,
  swapIsSafe,
} from "./swap-guard";
import { NO_PENDING_WORK } from "./update-model";

const QUIET: SwapState = {
  keptDrafts: 0,
  openDialogs: 0,
  screensHolding: 0,
  typedFields: 0,
  work: NO_PENDING_WORK,
  writesInFlight: 0,
};

describe("swapIsSafe: the page may swap only when it holds nothing", () => {
  it("swaps when nothing is open, typed, kept, on its way or queued", () => {
    expect(swapIsSafe(QUIET)).toBe(true);
    expect(swapHolds(QUIET)).toEqual([]);
  });

  it.each<[string, Partial<SwapState>, string]>([
    ["a dialog open, of form or not", { openDialogs: 1 }, "dialog"],
    [
      "a screen that edits and was changed (the sale with an item, the import with a file)",
      { screensHolding: 1 },
      "screen",
    ],
    [
      "a draft kept for the way back (kept-for-return)",
      { keptDrafts: 1 },
      "kept_draft",
    ],
    ["a write to the server on its way", { writesInFlight: 1 }, "write"],
    [
      "the sync queue with a command pending",
      { work: { ...NO_PENDING_WORK, pending: 1 } },
      "queue",
    ],
    [
      "the sync queue sending",
      { work: { ...NO_PENDING_WORK, sending: 1 } },
      "queue",
    ],
    [
      "a record refused by the server, waiting in Pendências",
      { work: { ...NO_PENDING_WORK, rejected: 1 } },
      "refused",
    ],
    [
      "a field outside a dialog with text typed",
      { typedFields: 1 },
      "typed_field",
    ],
  ])("holds the swap: %s", (_name, change, hold) => {
    const state = { ...QUIET, ...change };
    expect(swapIsSafe(state)).toBe(false);
    expect(swapHolds(state)).toEqual([hold]);
  });

  it("lists every hold at once, in a fixed order", () => {
    expect(
      swapHolds({
        keptDrafts: 2,
        openDialogs: 1,
        screensHolding: 1,
        typedFields: 3,
        work: { pending: 1, rejected: 1, sending: 0 },
        writesInFlight: 1,
      })
    ).toEqual([
      "dialog",
      "screen",
      "kept_draft",
      "write",
      "refused",
      "queue",
      "typed_field",
    ]);
  });
});

/** A field as the count reads it: where it is (in a dialog, under `data-swap-ignore`) and what it holds. */
function field(
  options: {
    connected?: boolean;
    contentEditable?: boolean;
    ignored?: boolean;
    inDialog?: boolean;
    tagName?: string;
    text?: string;
    type?: string;
  } = {}
): FieldLike & { value?: string } {
  const {
    connected = true,
    contentEditable = false,
    ignored = false,
    inDialog = false,
    tagName = "INPUT",
    text = "",
    type = "text",
  } = options;
  const editable = tagName !== "INPUT" && tagName !== "TEXTAREA";
  return {
    closest: (selector: string) => {
      if (selector.includes("data-swap-ignore")) {
        return ignored ? {} : null;
      }
      return inDialog && selector.includes("dialog") ? {} : null;
    },
    isConnected: connected,
    isContentEditable: contentEditable,
    tagName,
    textContent: editable ? text : null,
    type,
    ...(editable ? {} : { value: text }),
  };
}

describe("the fields typed in, outside a dialog", () => {
  it("counts a field with text the person typed", () => {
    const fields = createTypedFields();
    const name = field({ text: "Camiseta" });
    fields.onInput({ target: name });
    expect(fields.count()).toBe(1);
    // emptied again, it holds nothing
    name.value = "";
    expect(fields.count()).toBe(0);
  });

  it("does not count a search, marked with data-swap-ignore", () => {
    const fields = createTypedFields();
    fields.onInput({ target: field({ ignored: true, text: "camiseta" }) });
    fields.onInput({
      target: field({ ignored: true, text: "azul", type: "search" }),
    });
    expect(fields.count()).toBe(0);
  });

  it("does not count a field inside a dialog: the open dialog holds by itself", () => {
    const fields = createTypedFields();
    fields.onInput({ target: field({ inDialog: true, text: "Camiseta" }) });
    expect(fields.count()).toBe(0);
  });

  it("does not count a field never typed in, whatever the screen filled in it", () => {
    const fields = createTypedFields();
    field({ text: "Loja do teste" }); // filled by the screen, no input event
    expect(fields.count()).toBe(0);
  });

  it("counts a text area and a contenteditable, never a checkbox, a radio or a file", () => {
    const fields = createTypedFields();
    fields.onInput({ target: field({ tagName: "TEXTAREA", text: "nota" }) });
    fields.onInput({
      target: field({ contentEditable: true, tagName: "DIV", text: "texto" }),
    });
    for (const type of ["checkbox", "radio", "file", "range"]) {
      fields.onInput({ target: field({ text: "on", type }) });
    }
    expect(fields.count()).toBe(2);
  });

  it("forgets a field that left the page", () => {
    const fields = createTypedFields();
    fields.onInput({ target: field({ connected: false, text: "Camiseta" }) });
    expect(fields.count()).toBe(0);
  });

  it("tells its listeners when something was typed", () => {
    const fields = createTypedFields();
    let heard = 0;
    const stop = fields.subscribe(() => {
      heard += 1;
    });
    fields.onInput({ target: field({ text: "a" }) });
    stop();
    fields.onInput({ target: field({ text: "b" }) });
    expect(heard).toBe(1);
  });
});
