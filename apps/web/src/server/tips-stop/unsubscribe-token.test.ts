import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUnsubscribeToken,
  TIPS_STOP_PATH,
  UNSUBSCRIBE_TOKEN_PURPOSE,
  type UnsubscribeSecrets,
  unsubscribeLink,
  unsubscribeSecretsOf,
  verifyUnsubscribeToken,
} from "./unsubscribe-token";

const SECRET = "s".repeat(40);
const PREVIOUS = "p".repeat(40);
const SESSION_SECRET = "b".repeat(40);
const SUPPRESSION_SECRET = "x".repeat(40);
const USER = "Kq3vXbX0f1Lr9sTzUa2W";
const OTHER_USER = "ZZ7dPq0wNm4Lk2Jh1GfD";
const secrets: UnsubscribeSecrets = { current: SECRET };
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const DATE_IN_SOURCE = /\bDate\b|performance\.now|\bTemporal\b/;

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A token of the same shape for another purpose (the suppression of the series, say), signed as that purpose would. */
async function tokenOfPurpose(
  purpose: string,
  secret: string,
  userId: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${purpose}\u0000${userId}`)
    )
  );
  return `${toBase64Url(new TextEncoder().encode(userId))}.${toBase64Url(mac)}`;
}

/** The token with one character of `part` changed to another of the alphabet. */
function tampered(token: string, part: 0 | 1, at = 3): string {
  const parts = token.split(".");
  const text = parts[part] ?? "";
  const swapped = text[at] === "A" ? "B" : "A";
  parts[part] = `${text.slice(0, at)}${swapped}${text.slice(at + 1)}`;
  return parts.join(".");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the token that stops the tips e-mails", () => {
  it("opens for the person it was made for", async () => {
    const token = await createUnsubscribeToken(secrets, USER);
    await expect(verifyUnsubscribeToken(secrets, token)).resolves.toBe(USER);
  });

  it("carries the ID and the MAC and nothing else: no date, no address, no name", async () => {
    const token = await createUnsubscribeToken(secrets, USER);
    const parts = token.split(".");

    expect(parts).toHaveLength(2);
    const [user = "", mac = ""] = parts;
    expect(user).toMatch(BASE64URL_PART);
    expect(mac).toMatch(BASE64URL_PART);
    expect(new TextDecoder().decode(fromBase64Url(user))).toBe(USER);
    expect(fromBase64Url(mac)).toHaveLength(32);
  });

  it("has no field of date: the same person gets the same token a year later, and it still opens", async () => {
    const now = Date.UTC(2026, 10, 12, 2, 59, 59);
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const first = await createUnsubscribeToken(secrets, USER);
    vi.setSystemTime(now + 366 * 24 * 60 * 60 * 1000);
    const later = await createUnsubscribeToken(secrets, USER);

    expect(later).toBe(first);
    await expect(verifyUnsubscribeToken(secrets, first)).resolves.toBe(USER);
  });

  it("is made without reading any clock (the module names no Date, performance.now or Temporal)", () => {
    const source = readFileSync(
      new URL("./unsubscribe-token.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(DATE_IN_SOURCE);
  });

  it("refuses to be made for something that is not an internal ID (an address, a name)", async () => {
    const outcomes = await Promise.allSettled(
      ["ana@example.com", "Ana Souza", "", "a".repeat(129)].map((notAnId) =>
        createUnsubscribeToken(secrets, notAnId)
      )
    );
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect(String((outcome as PromiseRejectedResult).reason)).toContain(
        "not an ID of a person"
      );
    }
  });

  it("refuses a tampered token: the MAC changed, the person changed, or the MAC of another person", async () => {
    const token = await createUnsubscribeToken(secrets, USER);
    const other = await createUnsubscribeToken(secrets, OTHER_USER);
    const [userPart = ""] = token.split(".");
    const [, otherMac = ""] = other.split(".");

    const refused = [
      tampered(token, 1),
      tampered(token, 0),
      `${userPart}.${otherMac}`,
    ];
    expect(
      await Promise.all(
        refused.map((bad) => verifyUnsubscribeToken(secrets, bad))
      )
    ).toEqual(refused.map(() => undefined));
  });

  it("refuses a token of another purpose made with the same secret, and the other purpose refuses this one", async () => {
    const suppression = "polaris/email-suppression/v1";
    const foreign = await tokenOfPurpose(suppression, SECRET, USER);
    const own = await createUnsubscribeToken(secrets, USER);

    await expect(verifyUnsubscribeToken(secrets, foreign)).resolves.toBe(
      undefined
    );
    // the other purpose, checking our token the way it checks its own, finds a different MAC
    expect(await tokenOfPurpose(suppression, SECRET, USER)).not.toBe(own);
    expect(await tokenOfPurpose(UNSUBSCRIBE_TOKEN_PURPOSE, SECRET, USER)).toBe(
      own
    );
  });

  it("refuses a token signed with the session secret or with the one of the suppression", async () => {
    const foreign = await Promise.all(
      [SESSION_SECRET, SUPPRESSION_SECRET].map((secret) =>
        createUnsubscribeToken({ current: secret }, USER)
      )
    );
    expect(
      await Promise.all(
        foreign.map((token) => verifyUnsubscribeToken(secrets, token))
      )
    ).toEqual([undefined, undefined]);
    // and the reverse: a token of this secret does not open under the other ones
    const own = await createUnsubscribeToken(secrets, USER);
    await expect(
      verifyUnsubscribeToken({ current: SUPPRESSION_SECRET }, own)
    ).resolves.toBe(undefined);
  });

  it("refuses what is not a token at all", async () => {
    const token = await createUnsubscribeToken(secrets, USER);
    const [userPart = "", mac = ""] = token.split(".");
    const refused = [
      undefined,
      "",
      ".",
      userPart,
      `${token}.x`,
      `${userPart}.${mac.slice(0, -2)}`,
      `${userPart}=.${mac}`,
      `${userPart}.${mac}=`,
      `${userPart}+.${mac}`,
      `${toBase64Url(new TextEncoder().encode("a@b"))}.${mac}`,
    ];
    expect(
      await Promise.all(
        refused.map((bad) => verifyUnsubscribeToken(secrets, bad))
      )
    ).toEqual(refused.map(() => undefined));
  });

  it("keeps opening under the previous secret during a rotation, and stops once it is removed", async () => {
    const old = await createUnsubscribeToken({ current: PREVIOUS }, USER);
    const rotating = { current: SECRET, previous: PREVIOUS };

    await expect(verifyUnsubscribeToken(rotating, old)).resolves.toBe(USER);
    await expect(verifyUnsubscribeToken(secrets, old)).resolves.toBe(undefined);
    // a new token is always signed with the current secret
    expect(await createUnsubscribeToken(rotating, USER)).toBe(
      await createUnsubscribeToken(secrets, USER)
    );
  });
});

describe("the secrets of the token", () => {
  it("are the current and the previous one", () => {
    expect(
      unsubscribeSecretsOf({
        BETTER_AUTH_SECRET: SESSION_SECRET,
        UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET: PREVIOUS,
        UNSUBSCRIBE_TOKEN_SECRET: SECRET,
      })
    ).toEqual({ current: SECRET, previous: PREVIOUS });
  });

  it("are missing, so the page fails closed, without a secret, with a short one or with the session's", () => {
    for (const current of [undefined, "", "s".repeat(31), SESSION_SECRET]) {
      expect(
        unsubscribeSecretsOf({
          BETTER_AUTH_SECRET: SESSION_SECRET,
          UNSUBSCRIBE_TOKEN_SECRET: current,
        })
      ).toBeUndefined();
    }
    expect(unsubscribeSecretsOf(undefined)).toBeUndefined();
  });

  it("leave out a previous secret that is short, the session's or the current one", () => {
    for (const previous of ["p".repeat(31), SESSION_SECRET, SECRET]) {
      expect(
        unsubscribeSecretsOf({
          BETTER_AUTH_SECRET: SESSION_SECRET,
          UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET: previous,
          UNSUBSCRIBE_TOKEN_SECRET: SECRET,
        })
      ).toEqual({ current: SECRET });
    }
  });
});

describe("the link of the e-mail", () => {
  it("is the origin of the app, the path of the page and the token as its one parameter", async () => {
    const token = await createUnsubscribeToken(secrets, USER);
    const link = unsubscribeLink("https://dash.araute.app/entrar?x=1", token);
    const url = new URL(link);

    expect(url.origin).toBe("https://dash.araute.app");
    expect(url.pathname).toBe(TIPS_STOP_PATH);
    expect([...url.searchParams.keys()]).toEqual(["t"]);
    expect(url.searchParams.get("t")).toBe(token);
    expect(url.hash).toBe("");
  });
});
