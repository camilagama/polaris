import type { Breadcrumb, ErrorEvent } from "@sentry/react";
import { describe, expect, it } from "vitest";
import {
  sanitizeBreadcrumb,
  sanitizeEvent,
  sanitizeUrl,
} from "./sentry-sanitize";

/** Made-up personal data and secrets: none of them may appear in what is sent. */
const SECRETS = {
  bearer: "Bearer abcdef0123456789abcdef",
  cnpj: "11.222.333/0001-81",
  code: "codigo-oauth-9f8e7d",
  cookie: "polaris.session_token=cookie-de-sessao-123456",
  cpf: "123.456.789-09",
  email: "maria.silva@example.com.br",
  phone: "(11) 99999-8888",
  state: "estado-oauth-1a2b3c",
  token: "tok-segredo-0123456789",
  typed: "Rua das Flores, 100",
};

function leaks(value: unknown): string[] {
  const json = JSON.stringify(value);
  return Object.values(SECRETS).filter((secret) => json.includes(secret));
}

function eventWithEverything(): ErrorEvent {
  return {
    breadcrumbs: [
      {
        category: "fetch",
        data: {
          body: `{"cpf":"${SECRETS.cpf}"}`,
          method: "POST",
          status_code: 500,
          url: `https://app.example/rpc/customer/create?token=${SECRETS.token}`,
        },
        type: "http",
      },
    ],
    contexts: {
      react: { componentStack: `at Form (cliente ${SECRETS.email})` },
    },
    exception: {
      values: [
        {
          stacktrace: {
            frames: [
              {
                abs_path: `https://app.example/assets/index-A1.js?token=${SECRETS.token}`,
                filename: "/assets/index-A1.js",
                function: "submit",
                lineno: 10,
              },
            ],
          },
          type: "Error",
          value: `Falha ao salvar ${SECRETS.email} (${SECRETS.cpf}, ${SECRETS.phone}) com ${SECRETS.bearer}`,
        },
      ],
    },
    extra: { cnpj: SECRETS.cnpj, form: { endereco: SECRETS.typed } },
    message: `cliente ${SECRETS.email} com CPF ${SECRETS.cpf}`,
    request: {
      cookies: { session: SECRETS.cookie },
      data: { cpf: SECRETS.cpf, email: SECRETS.email },
      headers: {
        Authorization: SECRETS.bearer,
        Cookie: SECRETS.cookie,
        Referer: `https://app.example/entrar?code=${SECRETS.code}&state=${SECRETS.state}#access_token=${SECRETS.token}`,
        "User-Agent": "Mozilla/5.0 (teste)",
        "X-Custom": SECRETS.typed,
      },
      method: "POST",
      query_string: `token=${SECRETS.token}&email=${SECRETS.email}`,
      url: `https://app.example/entrar?code=${SECRETS.code}&state=${SECRETS.state}&token=${SECRETS.token}`,
    },
    tags: { cliente: SECRETS.email, route: "/sales" },
    transaction: `/clientes?q=${SECRETS.email}`,
    type: undefined,
    user: { email: SECRETS.email, ip_address: "203.0.113.42" },
  };
}

describe("the URL of a report", () => {
  it("keeps the path and masks every query value and the fragment", () => {
    expect(
      sanitizeUrl(
        `https://app.example/entrar?token=${SECRETS.token}&code=${SECRETS.code}&state=${SECRETS.state}&page=2#access_token=${SECRETS.token}`
      )
    ).toBe(
      "https://app.example/entrar?token=[REDACTED]&code=[REDACTED]&state=[REDACTED]&page=[REDACTED]"
    );
  });

  it("leaves a URL without a query alone and masks a token in the path", () => {
    expect(sanitizeUrl("/sales/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe(
      "/sales/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
    );
    expect(sanitizeUrl(`/verificar/${SECRETS.email}`)).not.toContain(
      SECRETS.email
    );
  });

  it("masks credentials inside the URL", () => {
    expect(sanitizeUrl("https://user:senha@app.example/x")).not.toContain(
      "senha"
    );
  });
});

describe("the event sent to Sentry", () => {
  it("leaves without a cookie, token, e-mail, CPF, CNPJ, phone, body, form data or query value", () => {
    const sent = sanitizeEvent(eventWithEverything());

    expect(leaks(sent)).toEqual([]);
  });

  it("drops the user, the cookies and the body of the request, and keeps what helps to diagnose", () => {
    const sent = sanitizeEvent(eventWithEverything());

    expect(sent.user).toBeUndefined();
    expect(sent.request?.cookies).toBeUndefined();
    expect(sent.request?.data).toBeUndefined();
    expect(sent.request?.query_string).toBeUndefined();
    expect(Object.keys(sent.request?.headers ?? {}).sort()).toEqual([
      "Referer",
      "User-Agent",
    ]);
    expect(sent.request?.method).toBe("POST");
    expect(sent.request?.url).toBe(
      "https://app.example/entrar?code=[REDACTED]&state=[REDACTED]&token=[REDACTED]"
    );
    expect(sent.exception?.values?.[0]?.type).toBe("Error");
    expect(sent.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: "/assets/index-A1.js",
      function: "submit",
      lineno: 10,
    });
    expect(sent.tags).toMatchObject({ route: "/sales" });
  });

  it("drops what a thrown value that is not an Error carries, and the free text of a mechanism", () => {
    const sent = sanitizeEvent({
      exception: {
        values: [
          {
            mechanism: {
              data: { handler: "onunhandledrejection", name: SECRETS.typed },
              handled: false,
              type: "auto.browser.global_handlers.onunhandledrejection",
            },
            type: "UnhandledRejection",
          },
        ],
      },
      extra: { __serialized__: { endereco: SECRETS.typed }, route: "/sales" },
      fingerprint: [SECRETS.email],
      type: undefined,
    });

    expect(leaks(sent)).toEqual([]);
    expect(sent.extra).toEqual({ route: "/sales" });
    expect(sent.exception?.values?.[0]?.mechanism?.data).toEqual({
      handler: "onunhandledrejection",
    });
  });

  it("does not shorten a long stack trace", () => {
    const frames = Array.from({ length: 150 }, (_, index) => ({
      filename: `/assets/chunk-${index}.js`,
      lineno: index,
    }));
    const sent = sanitizeEvent({
      exception: { values: [{ stacktrace: { frames }, type: "Error" }] },
      type: undefined,
    });

    expect(sent.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(150);
  });

  it("does not change the event it receives", () => {
    const original = eventWithEverything();
    const before = JSON.stringify(original);
    sanitizeEvent(original);

    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("the breadcrumbs sent to Sentry", () => {
  it("masks the query of a request and drops its body", () => {
    const [crumb] = eventWithEverything().breadcrumbs as Breadcrumb[];
    const sent = sanitizeBreadcrumb(crumb as Breadcrumb);

    expect(leaks(sent)).toEqual([]);
    expect(sent?.data).toEqual({
      method: "POST",
      status_code: 500,
      url: "https://app.example/rpc/customer/create?token=[REDACTED]",
    });
  });

  it("masks both ends of a navigation", () => {
    const sent = sanitizeBreadcrumb({
      category: "navigation",
      data: {
        from: `/entrar?code=${SECRETS.code}`,
        to: `/sales?state=${SECRETS.state}`,
      },
    });

    expect(leaks(sent)).toEqual([]);
    expect(sent?.data).toEqual({
      from: "/entrar?code=[REDACTED]",
      to: "/sales?state=[REDACTED]",
    });
  });

  it("masks personal data in the message", () => {
    const sent = sanitizeBreadcrumb({
      category: "fetch",
      message: `salvou ${SECRETS.email} ${SECRETS.cpf} ${SECRETS.cookie}`,
    });

    expect(leaks(sent)).toEqual([]);
  });

  it.each(["console", "ui.input", "ui.click", "custom"])(
    "drops a %s breadcrumb",
    (category) => {
      expect(
        sanitizeBreadcrumb({ category, message: SECRETS.typed })
      ).toBeNull();
    }
  );

  it("drops a breadcrumb that names no category", () => {
    expect(sanitizeBreadcrumb({ message: SECRETS.typed })).toBeNull();
  });

  it("drops what the user typed or the page sent, under any spelling of the key", () => {
    const sent = sanitizeBreadcrumb({
      category: "xhr",
      data: {
        arguments: [SECRETS.typed],
        Body: SECRETS.typed,
        requestBody: SECRETS.typed,
        status_code: 200,
        value: SECRETS.typed,
      },
    });

    expect(sent?.data).toEqual({ status_code: 200 });
  });
});
