import { beforeAll, describe, expect, it } from "vitest";
import { ProviderNotConfiguredError } from "../provider-port";
import {
  MAX_WOOVI_WEBHOOK_BYTES,
  wooviPublicKeys,
  wooviSignatureMatches,
} from "./signature";
import { generateSigningKey, subscriptionWebhookBody } from "./test-fixtures";

type Signer = Awaited<ReturnType<typeof generateSigningKey>>;

const BODY = JSON.stringify(subscriptionWebhookBody("PIX_AUTOMATIC_APPROVED"));
const SPACED = JSON.stringify(
  subscriptionWebhookBody("PIX_AUTOMATIC_APPROVED"),
  null,
  2
);
const PEM_LINE = /.{1,64}/g;

let current: Signer;
let next: Signer;
let stranger: Signer;

beforeAll(async () => {
  [current, next, stranger] = await Promise.all([
    generateSigningKey(1024),
    generateSigningKey(2048),
    generateSigningKey(1024),
  ]);
});

async function matches(
  body: string,
  signature: string | null,
  setting: string
): Promise<boolean> {
  return await wooviSignatureMatches(
    body,
    signature,
    await wooviPublicKeys(setting)
  );
}

function reorder(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
}

describe("AC-1b: the signature of the raw bytes", () => {
  it("accepts the signature Woovi's key made over the body", async () => {
    expect(
      await matches(BODY, await current.sign(BODY), current.publicKey)
    ).toBe(true);
  });

  it("refuses a missing or empty signature", async () => {
    expect(await matches(BODY, null, current.publicKey)).toBe(false);
    expect(await matches(BODY, "", current.publicKey)).toBe(false);
  });

  it("refuses a body changed by one byte", async () => {
    const signature = await current.sign(BODY);
    const changed = `${BODY.slice(0, 10)}X${BODY.slice(11)}`;
    expect(changed).toHaveLength(BODY.length);
    expect(await matches(changed, signature, current.publicKey)).toBe(false);
  });

  it("refuses the same JSON with its keys reordered", async () => {
    const signature = await current.sign(BODY);
    const reordered = reorder(BODY);
    expect(JSON.parse(reordered)).toEqual(JSON.parse(BODY));
    expect(reordered).not.toBe(BODY);
    expect(await matches(reordered, signature, current.publicKey)).toBe(false);
  });

  it("refuses the same JSON with other spacing", async () => {
    const signature = await current.sign(BODY);
    expect(JSON.parse(SPACED)).toEqual(JSON.parse(BODY));
    expect(await matches(SPACED, signature, current.publicKey)).toBe(false);
    expect(await matches(`${BODY}\n`, signature, current.publicKey)).toBe(
      false
    );
    // and the spaced text has a signature of its own that does hold
    expect(
      await matches(SPACED, await current.sign(SPACED), current.publicKey)
    ).toBe(true);
  });

  it("refuses a signature made by another key", async () => {
    expect(
      await matches(BODY, await stranger.sign(BODY), current.publicKey)
    ).toBe(false);
  });

  it("keeps the byte order mark: the signed bytes are the bytes received", async () => {
    const withBom = `﻿${BODY}`;
    const signature = await current.sign(withBom);
    expect(await matches(withBom, signature, current.publicKey)).toBe(true);
    expect(await matches(BODY, signature, current.publicKey)).toBe(false);
    expect(
      await matches(withBom, await current.sign(BODY), current.publicKey)
    ).toBe(false);
  });

  it("signs non-ASCII text as UTF-8", async () => {
    const text = JSON.stringify({ event: "X", name: "José Conceição ✓" });
    expect(
      await matches(text, await current.sign(text), current.publicKey)
    ).toBe(true);
  });
});

describe("the signature as text", () => {
  it.each([
    ["not base64", "!!!not-base64!!!"],
    ["base64 with spaces", "AAAA AAAA"],
    ["base64 of a wrong length", "AAAAA"],
    ["too long", "A".repeat(1028)],
    ["only padding", "===="],
  ])("refuses a signature that is %s", async (_name, signature) => {
    expect(await matches(BODY, signature, current.publicKey)).toBe(false);
  });

  it("refuses a body above 64 KiB even with a valid signature", async () => {
    const big = JSON.stringify({ filler: "a".repeat(MAX_WOOVI_WEBHOOK_BYTES) });
    expect(new TextEncoder().encode(big).byteLength).toBeGreaterThan(
      MAX_WOOVI_WEBHOOK_BYTES
    );
    expect(await matches(big, await current.sign(big), current.publicKey)).toBe(
      false
    );
  });
});

describe("the pinned public keys", () => {
  it("accepts either of two keys during a rotation", async () => {
    const setting = `${current.publicKey},${next.publicKey}`;
    expect(await matches(BODY, await current.sign(BODY), setting)).toBe(true);
    expect(await matches(BODY, await next.sign(BODY), setting)).toBe(true);
    expect(await matches(BODY, await stranger.sign(BODY), setting)).toBe(false);
  });

  it("tolerates spaces around the keys of a rotation", async () => {
    const setting = ` ${current.publicKey} , ${next.publicKey} `;
    expect(await matches(BODY, await next.sign(BODY), setting)).toBe(true);
  });

  it("accepts a key written as PEM, with its header", async () => {
    const lines = current.publicKey.match(PEM_LINE)?.join("\n") ?? "";
    const pem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
    expect(await matches(BODY, await current.sign(BODY), pem)).toBe(true);
  });

  it.each([
    ["an empty setting", ""],
    ["only commas and spaces", " , ,"],
    ["garbage", "not a key at all"],
    ["base64 that is not a key", btoa("this is not an spki structure")],
  ])("%s is not configured", async (_name, setting) => {
    await expect(wooviPublicKeys(setting)).rejects.toBeInstanceOf(
      ProviderNotConfiguredError
    );
  });

  it("a missing setting is not configured", async () => {
    await expect(wooviPublicKeys(undefined)).rejects.toBeInstanceOf(
      ProviderNotConfiguredError
    );
  });

  it("three keys are not configured", async () => {
    await expect(
      wooviPublicKeys(
        `${current.publicKey},${next.publicKey},${stranger.publicKey}`
      )
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("one good key and one bad key are not configured", async () => {
    await expect(
      wooviPublicKeys(`${current.publicKey},garbage`)
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("a failed setting is read again once it is fixed", async () => {
    await expect(wooviPublicKeys("garbage")).rejects.toBeInstanceOf(
      ProviderNotConfiguredError
    );
    await expect(wooviPublicKeys(current.publicKey)).resolves.toHaveLength(1);
  });
});
