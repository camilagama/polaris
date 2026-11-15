import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderBillingNoticeEmail } from "../../billing/emails/billing-notice-email";
import { renderClosureNoticeEmail } from "../../privacy/closure-notice-email";
import {
  ACTIVATION_SUBJECT_MAX,
  type ActivationNoticeEmail,
  type ActivationNoticeVariant,
  activationNoticeContent,
  activationNoticeHeaders,
  activationNoticeVariant,
  activationStoreName,
  renderActivationNoticeEmail,
} from "./activation-notice-email";

const BASE = "https://app.exemplo.app";
const TOKEN = "dXNlcl9hdXJvcmE.c2lnbmF0dXJlLW5vdC1yZWFs";
const STOP_URL = `${BASE}/api/parar-dicas?t=${TOKEN}`;
const STOP_LABEL = "Parar de receber estas dicas";
const SUPPLIER =
  "Polaris, um produto de Agência Summit, CNPJ 35.584.467/0001-00.";
const FORBIDDEN = /série|descadastro|opt-out|ativação|trial/i;
const IMAGE = /<img/i;
const TRACKING = /utm_/i;
const HREF = /href="([^"]*)"/g;
const BUTTON_MARK = "Se o botão não funcionar";
const NAMES_STOP_HEADER = /list-unsubscribe/i;
const REPLY_INVITATION = /responda este e-mail/i;
const CHECK_MARK = /✓/;
const LINE_BREAK = /[\r\n]/;
const ZERO_WIDTH = String.fromCodePoint(0x20_0b);
const ACUTE = String.fromCodePoint(0x3_01);
const RIGHT_TO_LEFT = String.fromCodePoint(0x20_2e);
const FAMILY = String.fromCodePoint(
  0x1_f4_68,
  0x20_0d,
  0x1_f4_69,
  0x20_0d,
  0x1_f4_67,
  0x20_0d,
  0x1_f4_66
);
const TS_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;

const VARIANTS: readonly ActivationNoticeVariant[] = [
  "a1",
  "a2_s0",
  "a2_s1",
  "a3_s0",
  "a3_s1",
];

function email(
  variant: ActivationNoticeVariant,
  store = "Loja Aurora"
): ActivationNoticeEmail {
  return {
    appBaseUrl: `${BASE}/qualquer/caminho?x=1`,
    store,
    supportEmail: "suporte@exemplo.app",
    unsubscribeToken: TOKEN,
    variant,
  };
}

function renderAll() {
  return Promise.all(
    VARIANTS.map(async (variant) => ({
      content: activationNoticeContent(email(variant)),
      rendered: await renderActivationNoticeEmail(email(variant)),
      variant,
    }))
  );
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("the model of each step and state", () => {
  it("A1 only for a store with no product; A2 and A3 by the state", () => {
    expect(activationNoticeVariant("a1", false)).toBe("a1");
    expect(activationNoticeVariant("a1", true)).toBeNull();
    expect(activationNoticeVariant("a2", false)).toBe("a2_s0");
    expect(activationNoticeVariant("a2", true)).toBe("a2_s1");
    expect(activationNoticeVariant("a3", false)).toBe("a3_s0");
    expect(activationNoticeVariant("a3", true)).toBe("a3_s1");
  });
});

describe("the rendered e-mails", () => {
  for (const variant of VARIANTS) {
    it(`${variant}: the HTML and the text are the approved ones`, async () => {
      const rendered = await renderActivationNoticeEmail(email(variant));
      await expect(rendered.html).toMatchFileSnapshot(
        `./__golden__/${variant}.html.txt`
      );
      await expect(
        `Assunto: ${rendered.subject}\n\n${rendered.text}`
      ).toMatchFileSnapshot(`./__golden__/${variant}.text.txt`);
    });
  }

  it("the same notice renders the same message", async () => {
    const first = await renderActivationNoticeEmail(email("a2_s1"));
    expect(await renderActivationNoticeEmail(email("a2_s1"))).toEqual(first);
  });

  it("the four subjects fit in 40 characters, have no store and are one line", () => {
    const subjects = new Set<string>();
    for (const variant of VARIANTS) {
      const { subject } = activationNoticeContent(
        email(variant, "Loja Nome Que Não Pode Ir")
      );
      subjects.add(subject);
      expect(Array.from(subject).length).toBeLessThanOrEqual(
        ACTIVATION_SUBJECT_MAX
      );
      expect(subject).not.toContain("Loja Nome");
      expect(subject).not.toMatch(LINE_BREAK);
    }
    expect([...subjects]).toEqual([
      "Falta só o primeiro produto na sua loja",
      "Sua loja ainda está sem produtos",
      "Falta só a primeira venda",
      "Algo está travando na sua loja?",
    ]);
  });

  it("A1 and A2 have one button and no invitation to reply; A3 has no button, a text link and asks for a reply", async () => {
    for (const { content, rendered, variant } of await renderAll()) {
      const { html, text } = rendered;
      const isA3 = variant.startsWith("a3");
      expect(content.action === null).toBe(isA3);
      expect(content.textLink === null).toBe(!isA3);
      expect(count(html, BUTTON_MARK)).toBe(isA3 ? 0 : 1);
      expect(count(html, "<a ")).toBe(3);
      expect(REPLY_INVITATION.test(text)).toBe(isA3);
      expect(text).not.toMatch(CHECK_MARK);
      expect(content.paragraphs[0]?.startsWith(content.preview)).toBe(true);
    }
    const a3 = await renderActivationNoticeEmail(email("a3_s1"));
    expect(a3.html).toContain(
      `<a href="${BASE}/" style="color:#171613;text-decoration-line:underline`
    );
    expect(a3.text).toContain(`Abrir a loja ${BASE}/`);
  });

  it("A3 has the fixed sentence of each state", () => {
    expect(activationNoticeContent(email("a3_s0")).paragraphs[0]).toBe(
      "Faz alguns dias que a loja Loja Aurora foi criada e ainda falta cadastrar o primeiro produto."
    );
    expect(activationNoticeContent(email("a3_s1")).paragraphs[0]).toBe(
      "Faz alguns dias que a loja Loja Aurora foi criada e ainda falta fazer a primeira venda."
    );
  });

  it("the buttons lead to Produtos and Nova venda on the app's origin, with no store, token or query", () => {
    expect(activationNoticeContent(email("a1")).action?.url).toBe(
      `${BASE}/products`
    );
    expect(activationNoticeContent(email("a2_s0")).action?.url).toBe(
      `${BASE}/products`
    );
    expect(activationNoticeContent(email("a2_s1")).action).toEqual({
      label: "Fazer a primeira venda",
      url: `${BASE}/sales`,
    });
  });
});

describe("the store's name", () => {
  it("is cut at 24 characters with an ellipsis, by grapheme", () => {
    expect(activationStoreName("Loja Aurora")).toBe("Loja Aurora");
    expect(activationStoreName("Ateliê de Cerâmica da Vovó Joana")).toBe(
      "Ateliê de Cerâmica da Vo…"
    );
    expect(activationStoreName(`${"a".repeat(23)}${FAMILY}`)).toBe(
      `${"a".repeat(23)}${FAMILY}`
    );
    expect(activationStoreName(`${"a".repeat(24)}${FAMILY}`)).toBe(
      `${"a".repeat(24)}…`
    );
    const decomposed = `${"b".repeat(23)}e${ACUTE}xyz`;
    expect(activationStoreName(decomposed)).toBe(`${"b".repeat(23)}e${ACUTE}…`);
  });

  it("is one line and loses the bidirectional controls", () => {
    expect(activationStoreName("Loja\n\tAurora  ")).toBe("Loja Aurora");
    expect(activationStoreName(`Loja ${RIGHT_TO_LEFT}axe.exe`)).toBe(
      "Loja axe.exe"
    );
    for (const blank of [ZERO_WIDTH, "\u3164", "\u2800\u2800", "\u00ad"]) {
      expect(() => activationStoreName(blank)).toThrow(
        "activation_notice_store_missing"
      );
    }
    expect(() => activationStoreName(` ${RIGHT_TO_LEFT} `)).toThrow(
      "activation_notice_store_missing"
    );
  });

  it("is escaped in the HTML and is only in the body and the footer", async () => {
    const hostile = `<b onclick="x">&'Loja`;
    const rendered = await renderActivationNoticeEmail(email("a1", hostile));
    expect(rendered.html).not.toContain("<b onclick");
    expect(rendered.html).toContain(
      "&lt;b onclick=&quot;x&quot;&gt;&amp;&#x27;Loja"
    );
    expect(rendered.subject).not.toContain("Loja");
    expect(JSON.stringify(rendered.headers)).not.toContain("Loja");
    expect(count(rendered.text, `${hostile}`)).toBe(2);
  });
});

describe("the words, the images and the links", () => {
  it("no e-mail has a forbidden word, an image or a tracking parameter", async () => {
    for (const { rendered } of await renderAll()) {
      const { html, subject, text } = rendered;
      for (const part of [html, subject, text]) {
        expect(part).not.toMatch(FORBIDDEN);
        expect(part).not.toMatch(IMAGE);
        expect(part).not.toMatch(TRACKING);
      }
    }
  });

  it("every link is absolute on the app's origin, and only the stop link has a query (the token)", async () => {
    for (const { rendered } of await renderAll()) {
      const links = [...rendered.html.matchAll(HREF)].map(
        (match) => match[1] ?? ""
      );
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        const url = new URL(link.replaceAll("&amp;", "&"));
        expect(url.origin).toBe(BASE);
        if (url.pathname === "/api/parar-dicas") {
          expect([...url.searchParams.keys()]).toEqual(["t"]);
        } else {
          expect(url.search).toBe("");
          expect(url.hash).toBe("");
        }
        expect(link).not.toContain("org");
      }
    }
  });

  it("the footer says why, then the stop link, then the corporate name, in this order", async () => {
    for (const { rendered } of await renderAll()) {
      const { html, text } = rendered;
      const why = text.indexOf(
        "Você recebe este e-mail porque criou a loja Loja Aurora no Polaris"
      );
      const stop = text.indexOf(`${STOP_LABEL} ${STOP_URL}`);
      const supplier = text.indexOf(SUPPLIER);
      expect(why).toBeGreaterThan(0);
      expect(stop).toBeGreaterThan(why);
      expect(supplier).toBeGreaterThan(stop);
      expect(count(text, STOP_LABEL)).toBe(1);
      expect(count(html, STOP_LABEL)).toBe(1);
      expect(html).toContain(
        `<a href="${STOP_URL}" style="color:#171613;text-decoration-line:underline;font-size:16px;`
      );
    }
  });

  it("the billing and closure e-mails have no stop link", async () => {
    const billing = await renderBillingNoticeEmail(
      {
        endedAt: new Date("2026-10-29T03:00:00.000Z"),
        kind: "access_ended",
        overLimit: null,
        store: {
          appOrigin: BASE,
          name: "Loja Aurora",
          timeZone: "America/Sao_Paulo",
        },
      },
      "suporte@exemplo.app"
    );
    const closure = await renderClosureNoticeEmail(
      {
        deletableFrom: new Date("2027-01-18T03:00:00.000Z"),
        deletionDate: "2027-01-18",
        dueAt: new Date("2027-01-11T03:00:00.000Z"),
        milestone: "d7",
        noticeId: "0199f0aa-2b3c-7d4e-8f90-123456789abc",
        organizationId: "org_closure_notice",
        organizationName: "Loja Aurora",
        purgeFrom: null,
        recoverUntil: new Date("2026-11-19T12:00:00.000Z"),
        reissue: 0,
        requestedAt: new Date("2026-10-20T12:00:00.000Z"),
        timeZone: "America/Sao_Paulo",
        userId: "user_closure_notice",
      },
      BASE
    );
    for (const rendered of [billing, closure]) {
      expect(rendered.html).not.toContain(STOP_LABEL);
      expect(rendered.text).not.toContain("parar-dicas");
      expect(Object.keys(rendered)).not.toContain("headers");
    }
  });
});

describe("the stop headers", () => {
  it("are RFC 8058's, with the app's origin and the token only", async () => {
    const { headers } = await renderActivationNoticeEmail(email("a1"));
    expect(headers).toEqual({
      "List-Unsubscribe": `<${STOP_URL}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(activationNoticeHeaders(STOP_URL)).toEqual(headers);
  });

  it("the scan finds the header names in any case", () => {
    for (const planted of [
      "List-Unsubscribe",
      "list-unsubscribe-post",
      "LIST-UNSUBSCRIBE",
    ]) {
      expect(NAMES_STOP_HEADER.test(`headers: { "${planted}": x }`)).toBe(true);
    }
    expect(NAMES_STOP_HEADER.test("headers: { Authorization: x }")).toBe(false);
  });

  it("are built only by the tips e-mail: no other source file of the server names them", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (
          TS_FILE.test(entry.name) &&
          !TEST_FILE.test(entry.name) &&
          NAMES_STOP_HEADER.test(readFileSync(path, "utf8"))
        ) {
          found.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(found.sort()).toEqual([
      "server/activation/emails/activation-notice-email.tsx",
      "server/middleware/origin-check.ts",
      "server/privacy/closure-notice-email.tsx",
      "server/tips-stop/tips-stop-page.ts",
      "server/tips-stop/tips-stop-routes.ts",
      "server/tips-stop/unsubscribe-token.ts",
    ]);
  });
});
