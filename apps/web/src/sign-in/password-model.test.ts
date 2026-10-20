import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthAnswer,
  changeOutcome,
  emailProblem,
  errorCode,
  linkOutcome,
  lockMinutes,
  newPasswordProblem,
  postAuth,
  resetOutcome,
  signInOutcome,
  signUpLegalAcceptance,
  signUpOutcome,
  takeFragmentToken,
} from "./password-model";

const answer = (
  status: number,
  code: string | null = null,
  body: Record<string, unknown> | null = null
): AuthAnswer => ({ body, code, status });

describe("the token of a link", () => {
  const take = (hash: string) => {
    const replaceState = vi.fn();
    const token = takeFragmentToken(
      { hash, pathname: "/redefinir-senha", search: "" },
      { replaceState }
    );
    return { replaceState, token };
  };

  it("is read from the fragment and leaves the address bar at once (AC-53)", () => {
    const { replaceState, token } = take("#token=abc.DEF-123_x");
    expect(token).toBe("abc.DEF-123_x");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/redefinir-senha");
  });

  it("is never taken from anything but `#token=`, and a bad fragment still leaves the bar", () => {
    for (const hash of [
      "#token=",
      "#tok=abc",
      "#token=a&x=1",
      "#token=%E0%A4%A",
    ]) {
      const { replaceState, token } = take(hash);
      expect(token, hash).toBeNull();
      expect(replaceState, hash).toHaveBeenCalledOnce();
    }
    expect(take(`#token=${"a".repeat(2049)}`).token).toBeNull();
  });

  it("is read before the address changes, as `window.location` is live", () => {
    const location = {
      hash: "#token=vivo",
      pathname: "/confirmar-email",
      search: "",
    };
    const history = {
      replaceState: vi.fn(() => {
        location.hash = "";
      }),
    };
    expect(takeFragmentToken(location, history)).toBe("vivo");
    expect(location.hash).toBe("");
  });

  it("is absent after a reload, and then nothing touches the address", () => {
    const { replaceState, token } = take("");
    expect(token).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  it("sends JSON, the challenge token in its header, and reads both shapes of error", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { error: { code: "auth_challenge_failed" } },
          { status: 403 }
        )
      )
    );
    const result = await postAuth(
      "/api/auth/sign-in/email",
      { email: "a@b.co", password: "x" },
      { fetcher, turnstileToken: "tt" }
    );
    const [path, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/auth/sign-in/email");
    expect(new Headers(init.headers).get("x-turnstile-token")).toBe("tt");
    expect(init.method).toBe("POST");
    expect(result).toMatchObject({
      code: "auth_challenge_failed",
      status: 403,
    });
    expect(errorCode({ code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(
      "INVALID_EMAIL_OR_PASSWORD"
    );
  });

  it("sends no challenge header without a token, and a network failure is no answer", async () => {
    const fetcher = vi.fn(() => Promise.reject(new TypeError("offline")));
    expect(await postAuth("/x", {}, { fetcher })).toEqual({
      body: null,
      code: null,
      status: 0,
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("x-turnstile-token")).toBe(false);
  });
});

describe("the fields", () => {
  it("checks the shape of the e-mail only", () => {
    expect(emailProblem("  ")).toBe("required");
    expect(emailProblem("nome")).toBe("invalid");
    expect(emailProblem("nome@exemplo")).toBe("invalid");
    expect(emailProblem(" nome@exemplo.com ")).toBeNull();
  });

  it("applies the size rule after NFC, counting characters, with spaces allowed (AC-47)", () => {
    expect(newPasswordProblem("a".repeat(14))).toBe("too_short");
    expect(newPasswordProblem("frase com espaços")).toBeNull();
    // 15 characters of two code units each
    expect(newPasswordProblem("😀".repeat(15))).toBeNull();
    // "e" + combining accent is one character after NFC
    expect(newPasswordProblem("é".repeat(14))).toBe("too_short");
    expect(newPasswordProblem("a".repeat(129))).toBe("too_long");
  });
});

describe("what each answer means on the screen", () => {
  it("signs in, and says 'incorrect' alike for a wrong password and an unknown e-mail (AC-50, AC-63)", () => {
    expect(signInOutcome(answer(200))).toEqual({ kind: "signed-in" });
    expect(signInOutcome(answer(401, "INVALID_EMAIL_OR_PASSWORD"))).toEqual({
      kind: "incorrect",
    });
    expect(signInOutcome(answer(403, "EMAIL_NOT_VERIFIED"))).toEqual({
      kind: "unverified",
    });
  });

  it("tells the pause from the limit of the address, with the minutes rounded up (AC-62)", () => {
    expect(
      signInOutcome(answer(429, "auth_login_locked", { retryAfterSeconds: 61 }))
    ).toEqual({ kind: "locked", retryAfterSeconds: 120 });
    expect(signInOutcome(answer(429, "auth_rate_limited"))).toEqual({
      failure: "limit",
      kind: "failure",
    });
    expect(lockMinutes(899)).toBe(15);
    expect(lockMinutes("x")).toBe(15);
    expect(lockMinutes(0)).toBe(1);
  });

  it("names the challenge failure, and every other refusal or silence is 'unavailable'", () => {
    expect(signInOutcome(answer(403, "auth_challenge_failed"))).toEqual({
      failure: "challenge",
      kind: "failure",
    });
    for (const failed of [
      answer(0),
      answer(503, "auth_challenge_unavailable"),
      answer(500),
    ]) {
      expect(signInOutcome(failed)).toEqual({
        failure: "unavailable",
        kind: "failure",
      });
    }
  });

  it("sends the versions in force with the sign-up, and reads its refusals (AC-68)", () => {
    expect(signUpLegalAcceptance()).toEqual({
      privacy: LEGAL_DOCUMENTS.privacy.version,
      terms: LEGAL_DOCUMENTS.terms.version,
    });
    expect(signUpOutcome(answer(200))).toEqual({ kind: "created" });
    expect(signUpOutcome(answer(400, "legal_acceptance_required"))).toEqual({
      kind: "acceptance",
    });
    expect(signUpOutcome(answer(400, "password_compromised"))).toEqual({
      kind: "password",
      problem: "compromised",
    });
    expect(signUpOutcome(answer(503, "password_hibp_unavailable"))).toEqual({
      failure: "hibp_unavailable",
      kind: "failure",
    });
  });

  it("says a reset link is no good for any 400 that is not about the password (AC-53)", () => {
    expect(resetOutcome(answer(200))).toEqual({ kind: "done" });
    expect(resetOutcome(answer(400, "INVALID_TOKEN"))).toEqual({
      kind: "link-invalid",
    });
    expect(resetOutcome(answer(400, "password_too_short"))).toEqual({
      kind: "password",
      problem: "too_short",
    });
    expect(resetOutcome(answer(429, "auth_rate_limited"))).toEqual({
      failure: "limit",
      kind: "failure",
    });
  });

  it("reads the verification and the unlock links", () => {
    expect(linkOutcome(answer(200))).toBe("done");
    expect(linkOutcome(answer(400, "verification_link_expired"))).toBe(
      "expired"
    );
    expect(linkOutcome(answer(400, "unlock_link_invalid"))).toBe("invalid");
    expect(linkOutcome(answer(429))).toBe("limit");
    expect(linkOutcome(answer(0))).toBe("unavailable");
  });

  it("reads the change of password inside the app (AC-57)", () => {
    expect(changeOutcome(answer(200))).toEqual({ kind: "done" });
    expect(changeOutcome(answer(401, "session_required"))).toEqual({
      kind: "session-ended",
    });
    expect(changeOutcome(answer(403, "fresh_session_required"))).toEqual({
      kind: "recent-required",
    });
    expect(changeOutcome(answer(400, "INVALID_PASSWORD"))).toEqual({
      kind: "current-wrong",
    });
    expect(changeOutcome(answer(400, "CREDENTIAL_ACCOUNT_NOT_FOUND"))).toEqual({
      kind: "no-password",
    });
    expect(
      changeOutcome(
        answer(429, "auth_login_locked", { retryAfterSeconds: 900 })
      )
    ).toEqual({ kind: "locked", retryAfterSeconds: 900 });
  });
});
