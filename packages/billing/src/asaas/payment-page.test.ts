import { describe, expect, it } from "vitest";
import { asaasPaymentPageUrl } from "./payment-page";

const production = { sandbox: false };
const sandbox = { sandbox: true };

describe("asaasPaymentPageUrl", () => {
  it.each([
    "https://www.asaas.com/i/abc",
    "https://asaas.com/i/abc",
  ])("accepts %s", (url) => {
    expect(asaasPaymentPageUrl(url, production)).toBe(url);
    expect(asaasPaymentPageUrl(url, sandbox)).toBe(url);
  });

  it("refuses a host that only ends with asaas.com", () => {
    expect(
      asaasPaymentPageUrl("https://asaas.com.evil/i/abc", production)
    ).toBeNull();
    expect(
      asaasPaymentPageUrl("https://evilasaas.com/i/abc", production)
    ).toBeNull();
    expect(
      asaasPaymentPageUrl("https://asaas.com.evil/i/abc", sandbox)
    ).toBeNull();
  });

  it("refuses a page that is not https", () => {
    expect(
      asaasPaymentPageUrl("http://www.asaas.com/i/abc", production)
    ).toBeNull();
  });

  it("refuses a port", () => {
    expect(
      asaasPaymentPageUrl("https://www.asaas.com:8443/i/abc", production)
    ).toBeNull();
  });

  it("refuses a user", () => {
    expect(
      asaasPaymentPageUrl("https://user@www.asaas.com/i/abc", production)
    ).toBeNull();
  });

  it("refuses a user and a password", () => {
    expect(
      asaasPaymentPageUrl("https://user:pw@asaas.com/", production)
    ).toBeNull();
  });

  it("refuses a javascript: address", () => {
    expect(
      asaasPaymentPageUrl("javascript:alert(1)//www.asaas.com/i/abc", production)
    ).toBeNull();
  });

  it.each([
    undefined,
    null,
    42,
    {},
    ["https://www.asaas.com/i/abc"],
  ])("refuses what is not a string (%j)", (value) => {
    expect(asaasPaymentPageUrl(value, production)).toBeNull();
  });

  it("refuses an address that is not a URL", () => {
    expect(asaasPaymentPageUrl("not a url", production)).toBeNull();
  });

  it("refuses the sandbox's host in production", () => {
    expect(
      asaasPaymentPageUrl("https://sandbox.asaas.com/i/x", production)
    ).toBeNull();
  });

  it("accepts the sandbox's host with the sandbox's API", () => {
    expect(asaasPaymentPageUrl("https://sandbox.asaas.com/i/x", sandbox)).toBe(
      "https://sandbox.asaas.com/i/x"
    );
  });
});
