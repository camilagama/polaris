import { beforeAll, describe, expect, it } from "vitest";
import {
  type AccessJwtConfig,
  AccessJwtError,
  type AccessKey,
  accessIssuer,
  createAccessKeyStore,
  unverifiedKeyId,
  verifyAccessJwt,
} from "./access-jwt";

const issuer = "https://polaris.cloudflareaccess.com";
const audience = "a".repeat(64);
const config: AccessJwtConfig = { audience, issuer };
const now = new Date("2026-10-16T12:00:00.000Z");
const seconds = Math.floor(now.getTime() / 1000);

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

interface TestKey {
  jwk: AccessKey;
  privateKey: CryptoKey;
}

async function makeKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    jwk: { e: exported.e ?? "", kid, kty: "RSA", n: exported.n ?? "" },
    privateKey: pair.privateKey,
  };
}

const validPayload = () => ({
  aud: [audience],
  email: "owner@example.com",
  exp: seconds + 600,
  iat: seconds - 10,
  iss: issuer,
  sub: "subject-1",
  type: "app",
});

async function sign(
  signer: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: signer.jwk.kid }
): Promise<string> {
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signer.privateKey,
      encoder.encode(input)
    )
  );
  return `${input}.${base64Url(signature)}`;
}

let key: TestKey;
let other: TestKey;

beforeAll(async () => {
  key = await makeKey("key-1");
  other = await makeKey("key-2");
});

async function failure(token: string, keys = [key.jwk]): Promise<string> {
  try {
    await verifyAccessJwt(token, config, keys, now);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AccessJwtError);
    return (error as AccessJwtError).code;
  }
  throw new Error("expected the token to be refused");
}

describe("verifyAccessJwt", () => {
  it("accepts a token signed by a published key for this issuer and audience", async () => {
    const claims = await verifyAccessJwt(
      await sign(key, validPayload()),
      config,
      [other.jwk, key.jwk],
      now
    );
    expect(claims).toEqual({
      email: "owner@example.com",
      expiresAt: seconds + 600,
      issuedAt: seconds - 10,
      issuer,
      subject: "subject-1",
    });
  });

  it("accepts the audience as a plain string and a missing e-mail", async () => {
    const claims = await verifyAccessJwt(
      await sign(key, { ...validPayload(), aud: audience, email: undefined }),
      config,
      [key.jwk],
      now
    );
    expect(claims.email).toBeNull();
  });

  it("refuses a token signed by a key Access did not publish, and a tampered payload", async () => {
    expect(await failure(await sign(other, validPayload()))).toBe(
      "unknown_key"
    );
    const forged = await sign(other, validPayload(), {
      alg: "RS256",
      kid: "key-1",
    });
    expect(await failure(forged)).toBe("bad_signature");

    const token = await sign(key, validPayload());
    const [header, , signature] = token.split(".");
    const evil = base64Url(
      JSON.stringify({ ...validPayload(), sub: "someone-else" })
    );
    expect(await failure(`${header}.${evil}.${signature}`)).toBe(
      "bad_signature"
    );
  });

  it("refuses every algorithm but RS256, including none and a shared secret", async () => {
    for (const alg of ["none", "HS256", "RS512", "ES256", undefined]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each case is checked on its own
        await failure(
          await sign(key, validPayload(), { alg, kid: key.jwk.kid })
        )
      ).toBe("unsupported_algorithm");
    }
    const unsigned = `${base64Url(JSON.stringify({ alg: "none" }))}.${base64Url(JSON.stringify(validPayload()))}.`;
    expect(await failure(unsigned)).toBe("unsupported_algorithm");
  });

  it("refuses another issuer and another audience", async () => {
    expect(
      await failure(
        await sign(key, {
          ...validPayload(),
          iss: "https://other.cloudflareaccess.com",
        })
      )
    ).toBe("wrong_issuer");
    expect(
      await failure(
        await sign(key, { ...validPayload(), aud: ["b".repeat(64)] })
      )
    ).toBe("wrong_audience");
    expect(
      await failure(await sign(key, { ...validPayload(), aud: undefined }))
    ).toBe("wrong_audience");
  });

  it("refuses an expired token, one not yet valid, and malformed times, allowing a small skew", async () => {
    expect(
      await failure(await sign(key, { ...validPayload(), exp: seconds - 31 }))
    ).toBe("expired");
    await expect(
      verifyAccessJwt(
        await sign(key, { ...validPayload(), exp: seconds - 10 }),
        config,
        [key.jwk],
        now
      )
    ).resolves.toBeDefined();
    expect(
      await failure(await sign(key, { ...validPayload(), nbf: seconds + 120 }))
    ).toBe("not_yet_valid");
    expect(
      await failure(await sign(key, { ...validPayload(), iat: seconds + 120 }))
    ).toBe("not_yet_valid");
    expect(
      await failure(await sign(key, { ...validPayload(), exp: "soon" }))
    ).toBe("bad_claims");
    expect(
      await failure(await sign(key, { ...validPayload(), iat: undefined }))
    ).toBe("bad_claims");
  });

  it("refuses a service token and a token without a usable subject", async () => {
    expect(
      await failure(
        await sign(key, { ...validPayload(), type: "service-token" })
      )
    ).toBe("wrong_token_type");
    expect(
      await failure(await sign(key, { ...validPayload(), type: undefined }))
    ).toBe("wrong_token_type");
    // the Access service token is also an application token, but it names a common name, not a person
    expect(
      await failure(
        await sign(key, { ...validPayload(), common_name: "ci-client" })
      )
    ).toBe("wrong_token_type");
    for (const sub of [undefined, "", 5, "x".repeat(513)]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case is checked on its own
      expect(await failure(await sign(key, { ...validPayload(), sub }))).toBe(
        "bad_claims"
      );
    }
  });

  it("refuses what is not a token", async () => {
    for (const token of [
      "",
      "a.b",
      "a.b.c.d",
      "not base64!.x.y",
      `${"x".repeat(9000)}`,
      `${base64Url("[]")}.${base64Url("{}")}.sig`,
      `${base64Url("{not json")}.${base64Url("{}")}.sig`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case is checked on its own
      expect(await failure(token)).toBe("malformed");
    }
  });

  it("only finds RSA keys by their ID", async () => {
    const token = await sign(key, validPayload());
    expect(await failure(token, [{ ...key.jwk, kty: "EC" }])).toBe(
      "unknown_key"
    );
    expect(await failure(token, [])).toBe("unknown_key");
  });
});

describe("accessIssuer", () => {
  it("turns a team domain into an issuer and refuses anything else", () => {
    expect(accessIssuer("polaris.cloudflareaccess.com")).toBe(issuer);
    for (const bad of [
      "",
      "evil.example.com",
      "polaris.cloudflareaccess.com.evil.com",
      "https://polaris.cloudflareaccess.com",
      "a/b.cloudflareaccess.com",
      "-x.cloudflareaccess.com",
    ]) {
      expect(accessIssuer(bad)).toBeNull();
    }
  });
});

describe("unverifiedKeyId", () => {
  it("reads the key ID from a well-formed header only", async () => {
    expect(unverifiedKeyId(await sign(key, validPayload()))).toBe("key-1");
    expect(unverifiedKeyId("garbage")).toBeUndefined();
    expect(unverifiedKeyId("")).toBeUndefined();
  });
});

describe("the key store", () => {
  const certs = (...keys: AccessKey[]) => ({ keys });

  it("fetches once and serves from memory until the keys are stale", async () => {
    let calls = 0;
    let clock = 0;
    const store = createAccessKeyStore({
      fetchKeys: () => {
        calls += 1;
        return Promise.resolve(certs(key.jwk));
      },
      now: () => clock,
      teamDomain: "polaris.cloudflareaccess.com",
    });
    await store.keys("key-1");
    await store.keys("key-1");
    expect(calls).toBe(1);
    clock = 6 * 60 * 1000;
    await store.keys("key-1");
    expect(calls).toBe(2);
  });

  it("asks the team's certs address and refreshes for an unknown key, but not too often", async () => {
    const urls: string[] = [];
    let clock = 0;
    let published = certs(key.jwk);
    const store = createAccessKeyStore({
      fetchKeys: (url) => {
        urls.push(url);
        return Promise.resolve(published);
      },
      now: () => clock,
      teamDomain: "polaris.cloudflareaccess.com",
    });
    await store.keys("key-1");
    expect(urls).toEqual([
      "https://polaris.cloudflareaccess.com/cdn-cgi/access/certs",
    ]);
    published = certs(key.jwk, other.jwk);
    clock = 10_000;
    expect((await store.keys("key-2")).length).toBe(1);
    clock = 61_000;
    expect((await store.keys("key-2")).length).toBe(2);
    expect(urls.length).toBe(2);
  });

  it("shares one download among a burst of requests with an unknown key", async () => {
    let calls = 0;
    let clock = 0;
    const store = createAccessKeyStore({
      fetchKeys: async () => {
        calls += 1;
        await Promise.resolve();
        return certs(key.jwk);
      },
      now: () => clock,
      teamDomain: "polaris.cloudflareaccess.com",
    });
    await store.keys("key-1");
    clock = 61_000;
    await Promise.all(Array.from({ length: 10 }, () => store.keys("nope")));
    expect(calls).toBe(2);
  });

  it("keeps serving the last keys when a renewal fails, retries only after a pause, and stops serving them after an hour", async () => {
    let calls = 0;
    let clock = 0;
    const state: { working: boolean } = { working: true };
    const store = createAccessKeyStore({
      fetchKeys: () => {
        calls += 1;
        return state.working
          ? Promise.resolve(certs(key.jwk))
          : Promise.reject(new Error("offline"));
      },
      now: () => clock,
      teamDomain: "polaris.cloudflareaccess.com",
    });
    await store.keys("key-1");
    state.working = false;
    clock = 6 * 60 * 1000;
    expect((await store.keys("key-1")).length).toBe(1);
    expect(calls).toBe(2);
    clock += 5000;
    await store.keys("key-1");
    expect(calls).toBe(2);
    clock += 10_000;
    await store.keys("key-1");
    expect(calls).toBe(3);
    clock = 61 * 60 * 1000;
    await expect(store.keys("key-1")).rejects.toThrow("offline");
  });

  it("fails when the keys cannot be read, rather than accepting without them", async () => {
    const store = createAccessKeyStore({
      fetchKeys: () => Promise.resolve({ keys: [] }),
      teamDomain: "polaris.cloudflareaccess.com",
    });
    await expect(store.keys()).rejects.toThrow("access_keys_unavailable");
    const broken = createAccessKeyStore({
      fetchKeys: () => Promise.reject(new Error("offline")),
      teamDomain: "polaris.cloudflareaccess.com",
    });
    await expect(broken.keys()).rejects.toThrow("offline");
  });
});
