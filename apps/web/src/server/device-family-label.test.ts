import { describe, expect, it } from "vitest";
import { DEVICE_FAMILY_LABELS, deviceFamilyLabel } from "./device-family-label";

const UA = {
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42",
  firefoxAndroid:
    "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
  firefoxIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  firefoxWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  ipadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  ipadMobile:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  webkitLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

const CONTROL_CHARACTER = /\p{Cc}/u;
const headers = (values: Record<string, string>) => new Headers(values);

describe("deviceFamilyLabel", () => {
  it.each([
    [
      "Chrome on Android, by the Client Hints",
      {
        "sec-ch-ua":
          '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        "sec-ch-ua-platform": '"Android"',
        "user-agent": UA.chromeAndroid,
      },
      "Chrome no Android",
    ],
    [
      "Edge on Windows, by the Client Hints",
      {
        "sec-ch-ua":
          '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"',
        "sec-ch-ua-platform": '"Windows"',
        "user-agent": UA.edgeWindows,
      },
      "Edge no Windows",
    ],
    [
      "Samsung Internet, by the Client Hints",
      {
        "sec-ch-ua":
          '"Samsung Internet";v="25.0", "Chromium";v="121", "Not)A;Brand";v="24"',
        "sec-ch-ua-platform": '"Android"',
        "user-agent": UA.samsungAndroid,
      },
      "Samsung Internet no Android",
    ],
    [
      "Chrome on ChromeOS, by the Client Hints",
      {
        "sec-ch-ua": '"Google Chrome";v="128", "Not;A=Brand";v="24"',
        "sec-ch-ua-platform": '"Chrome OS"',
        "user-agent": UA.chromeOs,
      },
      "Chrome no ChromeOS",
    ],
    [
      "Chrome on a Mac, by the Client Hints",
      {
        "sec-ch-ua": '"Google Chrome";v="128"',
        "sec-ch-ua-platform": '"macOS"',
      },
      "Chrome no Mac",
    ],
    [
      "Safari on the iPhone",
      { "user-agent": UA.safariIphone },
      "Safari no iPhone",
    ],
    ["Safari on the iPad", { "user-agent": UA.ipadMobile }, "Safari no iPad"],
    [
      "an iPad in desktop mode (accepted: it says it is a Mac)",
      { "user-agent": UA.ipadDesktop },
      "Safari no Mac",
    ],
    [
      "Chrome on the iPhone (CriOS)",
      { "user-agent": UA.chromeIos },
      "Chrome no iPhone",
    ],
    [
      "Firefox on the iPhone (FxiOS)",
      { "user-agent": UA.firefoxIos },
      "Firefox no iPhone",
    ],
    [
      "Firefox on Windows",
      { "user-agent": UA.firefoxWindows },
      "Firefox no Windows",
    ],
    [
      "Firefox on Android",
      { "user-agent": UA.firefoxAndroid },
      "Firefox no Android",
    ],
    ["Firefox on Linux", { "user-agent": UA.firefoxLinux }, "Firefox no Linux"],
    [
      "Edge by the User-Agent alone",
      { "user-agent": UA.edgeWindows },
      "Edge no Windows",
    ],
    [
      "Opera by the User-Agent alone",
      { "user-agent": UA.operaWindows },
      "Opera no Windows",
    ],
    [
      "Samsung Internet by the User-Agent alone",
      { "user-agent": UA.samsungAndroid },
      "Samsung Internet no Android",
    ],
    ["a WebKit on Linux", { "user-agent": UA.webkitLinux }, "Safari no Linux"],
    ["no header at all", {}, null],
    ["an empty User-Agent", { "user-agent": "" }, null],
    ["a User-Agent of nothing known", { "user-agent": "curl/8.5.0" }, null],
    [
      "a browser of no known family on a known system",
      { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Something/1.0" },
      "Navegador no Linux",
    ],
    [
      "a known browser on no known system",
      { "user-agent": "Mozilla/5.0 (Haiku) Gecko/20100101 Firefox/128.0" },
      "Firefox",
    ],
  ])("%s", (_name, values, expected) => {
    expect(deviceFamilyLabel(headers(values))).toBe(expected);
  });

  describe("the Client Hints brands", () => {
    it("skips the GREASE brands in front and takes the first known brand", () => {
      for (const grease of [
        '"Not A(Brand";v="99"',
        '"Not/A)Brand";v="8"',
        '"Not;A=Brand";v="24"',
        '"Not_A Brand";v="8"',
        '"Not)A;Brand";v="99"',
      ]) {
        expect(
          deviceFamilyLabel(
            headers({
              "sec-ch-ua": `${grease}, "Chromium";v="128", "Google Chrome";v="128"`,
              "sec-ch-ua-platform": '"Windows"',
            })
          ),
          grease
        ).toBe("Chrome no Windows");
      }
    });

    it('"Chromium" alone is the unknown browser ("Navegador"), whatever the User-Agent says', () => {
      expect(
        deviceFamilyLabel(
          headers({
            "sec-ch-ua": '"Chromium";v="128", "Not A(Brand";v="24"',
            "sec-ch-ua-platform": '"Linux"',
            "user-agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          })
        )
      ).toBe("Navegador no Linux");
      expect(
        deviceFamilyLabel(headers({ "sec-ch-ua": '"Chromium";v="128"' }))
      ).toBeNull();
    });

    it("brands out of order: the order of the table decides, not the order of the header", () => {
      expect(
        deviceFamilyLabel(
          headers({
            "sec-ch-ua":
              '"Google Chrome";v="128", "Microsoft Edge";v="128", "Chromium";v="128"',
            "sec-ch-ua-platform": '"Windows"',
          })
        )
      ).toBe("Edge no Windows");
      expect(
        deviceFamilyLabel(
          headers({
            "sec-ch-ua":
              '"Chromium";v="121", "Opera";v="113", "Not)A;Brand";v="24"',
            "sec-ch-ua-platform": '"Windows"',
          })
        )
      ).toBe("Opera no Windows");
    });

    it("a brand that only contains a known name is not that brand", () => {
      expect(
        deviceFamilyLabel(
          headers({
            "sec-ch-ua": '"Google Chrome Fake";v="1", "My Opera";v="1"',
            "sec-ch-ua-platform": '"Windows"',
          })
        )
      ).toBe("Navegador no Windows");
    });

    it("an unknown platform falls back to the User-Agent for the system", () => {
      expect(
        deviceFamilyLabel(
          headers({
            "sec-ch-ua": '"Google Chrome";v="128"',
            "sec-ch-ua-platform": '"Unknown"',
            "user-agent": UA.chromeAndroid,
          })
        )
      ).toBe("Chrome no Android");
    });
  });

  describe("the limits (Rodrigo)", () => {
    it("never answers a piece of a header: control characters and odd text give a name of the table or null", () => {
      const odd = [
        "Firefox/1\u0000<script>alert(1)</script>",
        "<img src=x onerror=alert(1)> Windows Firefox",
        '"Google Chrome\u0007";v="1"',
        "\u001b[31mAndroid Chrome",
      ];
      for (const value of odd) {
        for (const name of ["user-agent", "sec-ch-ua", "sec-ch-ua-platform"]) {
          let result: string | null;
          try {
            result = deviceFamilyLabel(headers({ [name]: value }));
          } catch {
            // a header with a control character cannot even be built: nothing reaches the function
            continue;
          }
          expect(result === null || DEVICE_FAMILY_LABELS.has(result)).toBe(
            true
          );
        }
      }
    });

    it("a 2 KB header answers from the closed set in a few milliseconds, and only its start is looked at", () => {
      const padding = "a(".repeat(1024);
      const long = {
        "sec-ch-ua": `${'"Not A(Brand";v="99", '.repeat(100)}"Google Chrome";v="128"`,
        "sec-ch-ua-platform": `"${padding}"`,
        "user-agent": `Mozilla/5.0 (${padding}) Firefox/128.0 Windows`,
      };
      expect(long["user-agent"].length).toBeGreaterThan(2048);
      const started = performance.now();
      let result: string | null = null;
      for (let n = 0; n < 100; n += 1) {
        result = deviceFamilyLabel(headers(long));
      }
      const perCall = (performance.now() - started) / 100;
      expect(perCall).toBeLessThan(5);
      // the brand after the first 512 characters and the tokens after them are never seen
      expect(result).toBeNull();
      expect(result === null || DEVICE_FAMILY_LABELS.has(result)).toBe(true);
    });

    it("the output always belongs to the closed set (every pair of the tables, and random headers)", () => {
      const tokens = [
        "Edg",
        "SamsungBrowser",
        "OPR",
        "CriOS",
        "FxiOS",
        "Firefox",
        "Chrome",
        "Safari",
        "Version/",
        "iPhone",
        "iPad",
        "Android",
        "Windows",
        "CrOS",
        "Macintosh",
        "Linux",
        '"Google Chrome"',
        '"Microsoft Edge"',
        '"Opera"',
        '"Samsung Internet"',
        '"Chromium"',
        '"macOS"',
        '"Android"',
        "x",
        ",",
        ";",
        '"',
      ];
      let seed = 216;
      const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed;
      };
      const pick = (count: number) =>
        Array.from(
          { length: count },
          () => tokens[next() % tokens.length]
        ).join(" ");
      for (let n = 0; n < 2000; n += 1) {
        const result = deviceFamilyLabel(
          headers({
            "sec-ch-ua": next() % 2 === 0 ? pick(next() % 6) : "",
            "sec-ch-ua-platform": pick(next() % 2),
            "user-agent": pick(next() % 8),
          })
        );
        expect(result === null || DEVICE_FAMILY_LABELS.has(result)).toBe(true);
      }
    });

    it("every name of the set fits the device label column (at most 80 characters, no control character)", () => {
      for (const label of DEVICE_FAMILY_LABELS) {
        expect([...label].length).toBeLessThanOrEqual(80);
        expect(label).not.toMatch(CONTROL_CHARACTER);
      }
    });
  });
});
