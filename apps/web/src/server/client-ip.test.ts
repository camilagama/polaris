import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

const identityOf = (value: string | null) =>
  clientIp(
    new Request("https://app.example.test/", {
      headers: value === null ? {} : { "cf-connecting-ip": value },
    })
  );

describe("clientIp", () => {
  it("keeps an IPv4 address whole, in one spelling", () => {
    expect(identityOf("203.0.113.17")).toBe("203.0.113.17");
    expect(identityOf("203.000.113.017")).toBe("203.0.113.17");
  });

  it("reads a mapped IPv4 address as the IPv4 address", () => {
    expect(identityOf("::ffff:203.0.113.17")).toBe("203.0.113.17");
    expect(identityOf("::FFFF:cb00:7111")).toBe("203.0.113.17");
  });

  it("counts an IPv6 address by its /64", () => {
    const net = identityOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(net).toBe("2001:db8:1:2::/64");
    expect(identityOf("2001:0DB8:0001:0002::1")).toBe(net);
    expect(identityOf("2001:db8:1:3::1")).not.toBe(net);
  });

  it("counts no address for a missing header or for text that is not an address", () => {
    for (const value of [
      null,
      "",
      "abc",
      "999.1.1.1",
      "1.2.3.4, 5.6.7.8",
      "2001:db8::1 2",
      `2001:db8::${"1".repeat(60)}`,
    ]) {
      expect(identityOf(value)).toBeUndefined();
    }
  });
});
