import { describe, expect, it, vi } from "vitest";
import {
  normalizePassword,
  PasswordPolicyError,
  validateNewPassword,
  type PasswordRangeFetcher,
} from "./password-policy";

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("")
    .toUpperCase();
}

describe("password policy", () => {
  it("normalizes NFC, counts Unicode code points, and checks only a padded hash range", async () => {
    const password = `${"A".repeat(14)}e\u0301`;
    const normalizedPassword = `${"A".repeat(14)}é`;
    const hash = await sha1Hex(normalizedPassword);
    const fetcher = vi.fn<PasswordRangeFetcher>();
    fetcher.mockResolvedValue(new Response(`${"0".repeat(35)}:0\r\n`));

    const result = await validateNewPassword(password, fetcher);

    expect(result).toBe(normalizedPassword);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requestURL, requestOptions] = fetcher.mock.calls[0] ?? [];
    expect(requestURL).toBe(
      `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`
    );
    expect(requestOptions?.headers).toEqual({
      "Add-Padding": "true",
      "User-Agent": "Polaris/1.0",
    });
    expect(requestOptions?.body).toBeUndefined();
    expect(String(requestURL)).not.toContain(normalizedPassword);
    expect(String(requestURL)).not.toContain(hash);
  });

  it("rejects a compromised password when the matching suffix has a positive count", async () => {
    const password = "ThisIsACompromisedTestPassphrase!";
    const hash = await sha1Hex(password);
    const response = `${hash.slice(5)}:3\r\n${"0".repeat(35)}:0\r\n`;
    const fetcher = vi.fn<PasswordRangeFetcher>();
    fetcher.mockResolvedValue(new Response(response));

    await expect(validateNewPassword(password, fetcher)).rejects.toMatchObject({
      code: "password_compromised",
    });
  });

  it("fails closed if the HIBP request fails without exposing the password", async () => {
    const password = "A long and unique test passphrase";
    const fetcher = vi.fn<PasswordRangeFetcher>();
    fetcher.mockRejectedValue(new Error("network failure"));

    const error = await validateNewPassword(password, fetcher).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(error).toMatchObject({ code: "password_hibp_unavailable" });
    expect((error as Error).message).not.toContain(password);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("counts password length by normalized Unicode code points", async () => {
    expect(normalizePassword(`${"x".repeat(14)}e\u0301`)).toBe(
      `${"x".repeat(14)}é`
    );
    const fetcher = vi.fn<PasswordRangeFetcher>();
    fetcher.mockResolvedValue(new Response(`${"0".repeat(35)}:0\r\n`));

    await expect(validateNewPassword("short", fetcher)).rejects.toMatchObject({
      code: "password_too_short",
    });
    await expect(
      validateNewPassword(`${"🙂".repeat(129)}`, fetcher)
    ).rejects.toMatchObject({ code: "password_too_long" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unpaired UTF-16 surrogates", () => {
    for (const password of ["invalid\uD800password", "trailing\uD800"]) {
      expect(() => normalizePassword(password)).toThrow(
        "password_invalid_unicode"
      );
    }
  });
});
