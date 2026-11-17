import { ACTIVATION_NOTICE_REREAD_REASONS } from "@polaris/domain/activation/notices";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ADDRESS_SUPPRESSED_STATEMENT,
  type ActivationSuppressionQuery,
  addressSuppressed,
  parseActivationNoticeReread,
} from "./activation-notice-store";

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

describe("the suppression check of an address", () => {
  const key = (byte: number, keyId: string) => ({
    hmac: new Uint8Array(32).fill(byte),
    keyId,
  });
  const NOW = new Date("2026-11-17T13:00:00.000Z");
  const answering = (rows: { suppressed: boolean }[]) => {
    const calls: { statement: string; values: readonly (string | null)[] }[] =
      [];
    const query: ActivationSuppressionQuery = (statement, values) => {
      calls.push({ statement, values });
      return Promise.resolve({ rows });
    };
    return { calls, query };
  };

  it("sends the current key alone with a null previous, the hex of the HMAC, the key id and the clock", async () => {
    const { calls, query } = answering([{ suppressed: false }]);

    expect(
      await addressSuppressed(query, { current: key(0xab, "0123abcd") }, NOW)
    ).toBe(false);

    expect(calls).toEqual([
      {
        statement: ACTIVATION_ADDRESS_SUPPRESSED_STATEMENT,
        values: [
          "ab".repeat(32),
          "0123abcd",
          null,
          null,
          "2026-11-17T13:00:00.000Z",
        ],
      },
    ]);
  });

  it("sends both keys while a previous one is set and passes on the database's answer", async () => {
    const { calls, query } = answering([{ suppressed: true }]);

    expect(
      await addressSuppressed(
        query,
        { current: key(1, "00000001"), previous: key(2, "00000002") },
        NOW
      )
    ).toBe(true);

    expect(calls[0]?.values.slice(0, 4)).toEqual([
      "01".repeat(32),
      "00000001",
      "02".repeat(32),
      "00000002",
    ]);
  });

  it("reads a missing function (42883, the Worker before the migration) as suppressed, so nothing is sent unchecked", async () => {
    const query: ActivationSuppressionQuery = () =>
      Promise.reject(
        Object.assign(
          new Error(
            "function public.activation_address_suppressed(bytea, text, bytea, text, timestamp with time zone) does not exist"
          ),
          { code: "42883" }
        )
      );

    expect(
      await addressSuppressed(query, { current: key(1, "00000001") }, NOW)
    ).toBe(true);
  });

  it("does not read a missing function of another name (42883 inside a body) as suppressed", async () => {
    const query: ActivationSuppressionQuery = () =>
      Promise.reject(
        Object.assign(
          new Error("function pg_catalog.nothing(text) does not exist"),
          {
            code: "42883",
          }
        )
      );

    await expect(
      addressSuppressed(query, { current: key(1, "00000001") }, NOW)
    ).rejects.toThrow("nothing(text)");
  });

  it.each([
    ["a permission refusal", "42501"],
    ["a connection fault", "08006"],
    ["a refused argument", "22023"],
  ])("does not read %s as suppressed", async (_label, code) => {
    const query: ActivationSuppressionQuery = () =>
      Promise.reject(Object.assign(new Error("database fault"), { code }));

    await expect(
      addressSuppressed(query, { current: key(1, "00000001") }, NOW)
    ).rejects.toThrow("database fault");
  });

  it("does not read a fault without a code as suppressed", async () => {
    const query: ActivationSuppressionQuery = () =>
      Promise.reject(new Error("socket closed"));

    await expect(
      addressSuppressed(query, { current: key(1, "00000001") }, NOW)
    ).rejects.toThrow("socket closed");
  });

  it.each([
    ["an HMAC of 31 bytes", { hmac: new Uint8Array(31), keyId: "00000001" }],
    ["a key id with capitals", { hmac: new Uint8Array(32), keyId: "ABCDEF01" }],
    ["a key id too short", { hmac: new Uint8Array(32), keyId: "abc" }],
  ])("refuses %s before asking", async (_label, current) => {
    const { calls, query } = answering([{ suppressed: false }]);

    await expect(addressSuppressed(query, { current }, NOW)).rejects.toThrow(
      "activation_suppression_hmac_invalid"
    );
    expect(calls).toEqual([]);
  });

  it("refuses a malformed previous key before asking", async () => {
    const { calls, query } = answering([{ suppressed: false }]);

    await expect(
      addressSuppressed(
        query,
        {
          current: key(1, "00000001"),
          previous: { hmac: new Uint8Array(5), keyId: "00000002" },
        },
        NOW
      )
    ).rejects.toThrow("activation_suppression_hmac_invalid");
    expect(calls).toEqual([]);
  });

  it("treats no row as not suppressed", async () => {
    const { query } = answering([]);

    expect(
      await addressSuppressed(query, { current: key(1, "00000001") }, NOW)
    ).toBe(false);
  });
});
