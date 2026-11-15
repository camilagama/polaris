import { ACTIVATION_NOTICE_REREAD_REASONS } from "@polaris/domain/activation/notices";
import { describe, expect, it } from "vitest";
import { parseActivationNoticeReread } from "./activation-notice-store";

describe("the reading of the database's re-read of an activation notice", () => {
  it("reads no answer as a notice not owed any more", () => {
    expect(parseActivationNoticeReread(null)).toBeNull();
    expect(parseActivationNoticeReread(undefined)).toBeNull();
  });

  it.each(ACTIVATION_NOTICE_REREAD_REASONS)(
    "passes on the code %s that stopped the notice",
    (code) => {
      expect(parseActivationNoticeReread({ skip: code })).toEqual({
        skip: code,
      });
    }
  );

  it("passes on the facts of the e-mail", () => {
    const facts = { hasProduct: false, step: "a2", store: "X" };
    expect(parseActivationNoticeReread(facts)).toEqual(facts);
  });

  it("refuses a code that is the Worker's and not the re-read's", () => {
    expect(() => parseActivationNoticeReread({ skip: "switched_off" })).toThrow(
      "activation_notice_reread_unknown"
    );
  });

  it.each([
    [
      "a step that does not exist",
      { hasProduct: true, step: "a4", store: "X" },
    ],
    ["hasProduct as text", { hasProduct: "true", step: "a1", store: "X" }],
    ["no store", { hasProduct: true, step: "a1" }],
    ["a store that is not text", { hasProduct: true, step: "a1", store: 7 }],
    ["an array", [{ hasProduct: true, step: "a1", store: "X" }]],
    ["a string", "a1"],
    ["an empty object", {}],
  ])("refuses %s as a fault of the database", (_label, answer) => {
    expect(() => parseActivationNoticeReread(answer)).toThrow(
      "activation_notice_reread_unknown"
    );
  });
});
