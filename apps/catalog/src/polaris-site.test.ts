import { describe, expect, it } from "vitest";
import { polarisSiteHref } from "./polaris-site";

describe("the address of the Polaris site in the footer", () => {
  it("accepts a plain https address and gives back the parsed address", () => {
    expect(polarisSiteHref("https://polaris.example")).toBe(
      "https://polaris.example/"
    );
    expect(polarisSiteHref("https://www.polaris.example/sobre")).toBe(
      "https://www.polaris.example/sobre"
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
    ["a javascript: address", "javascript:alert(1)"],
    ["a data: address", "data:text/html,<p>x</p>"],
    ["plain http", "http://polaris.example"],
    ["no scheme", "polaris.example"],
    ["a protocol-relative address", "//polaris.example"],
    ["junk", "lixo ??"],
    ["credentials", "https://user:senha@polaris.example"],
    ["a user only", "https://user@polaris.example"],
    ["a fragment", "https://polaris.example/#topo"],
    ["an empty fragment", "https://polaris.example/#"],
    ["surrounding spaces", " https://polaris.example"],
    ["a line break inside", "https://polaris.\nexample"],
    ["a backslash", "https:\\\\polaris.example"],
    ["no host", "https://"],
    ["a soft hyphen in the host", "https://exam\u00adple.com"],
    ["a non-ASCII host", "https://polaris.exemplo.com.br/ação"],
    ["a zero-width space", "https://polaris\u200b.example"],
  ])("is no link for %s", (_name, value) => {
    expect(polarisSiteHref(value)).toBeNull();
  });
});
