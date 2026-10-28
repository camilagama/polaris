import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorInfo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ClientErrorEnvironment,
  clientErrorEvent,
  clientErrorRouteId,
  createClientErrorReporter,
  installClientErrorListeners,
} from "./client-errors";

const ORIGIN = "https://app.example";
const RELEASE = "9b3d37ed5c22";

function setup(overrides: Partial<ClientErrorEnvironment> = {}) {
  const send = vi.fn<(body: string) => void>();
  const reportRender = vi.fn<(error: Error, info: ErrorInfo) => void>();
  const environment: ClientErrorEnvironment = {
    address: () => ({ pathname: "/sales", search: "" }),
    enabled: true,
    online: () => true,
    origin: () => ORIGIN,
    release: undefined,
    send,
    sentry: { active: () => false, reportRender },
    ...overrides,
  };
  return { report: createClientErrorReporter(environment), reportRender, send };
}

function bodyOf(send: { mock: { calls: unknown[][] } }, call = 0) {
  return JSON.parse(String(send.mock.calls[call]?.[0])) as Record<
    string,
    unknown
  >;
}

function hostileError() {
  const error = new TypeError(
    "maria@example.com 123.456.789-09 https://x.example/?token=abc"
  );
  Object.defineProperty(error, "cause", {
    value: { email: "maria@example.com" },
  });
  error.stack = [
    "TypeError: maria@example.com 123.456.789-09 https://x.example/?token=abc",
    `    at renderSecretCustomer (${ORIGIN}/assets/sale-form-model-BX3k9a1Z.js:12:34)`,
    "    at https://evil.example/assets/foreign-QQQQQQQQ.js:1:2",
    `    at maria@example.com (${ORIGIN}/assets/second-model-AAAAAAA1.js:5:6)`,
    `    at ${ORIGIN}/assets/third-model-BBBBBBB2.js:7:8`,
    `    at fourth (${ORIGIN}/assets/fourth-model-CCCCCCC3.js:9:10)`,
    `    at fifth (${ORIGIN}/assets/fifth-model-DDDDDDD4.js:11:12)`,
    `    at ${ORIGIN}/src/not-an-asset.ts:1:1`,
  ].join("\n");
  return error;
}

describe("the event of a hostile error", () => {
  it("carries only the allowed keys, at most three bare positions, and none of the text", () => {
    const { report, send } = setup({ release: RELEASE.toUpperCase() });
    const error = Object.assign(hostileError(), {
      code: "CONFLICT",
      status: 409,
    });

    report(error, { boundary: "screen", kind: "boundary" });

    expect(send).toHaveBeenCalledTimes(1);
    const raw = String(send.mock.calls[0]?.[0]);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "boundary",
      "code",
      "errorName",
      "frames",
      "kind",
      "release",
      "routeId",
      "status",
      "v",
    ]);
    expect(body).toMatchObject({
      boundary: "screen",
      code: "CONFLICT",
      errorName: "TypeError",
      kind: "boundary",
      release: RELEASE,
      routeId: "sale",
      status: 409,
      v: 1,
    });
    expect(body.frames).toEqual([
      "sale-form-model-BX3k9a1Z.js:12:34",
      "second-model-AAAAAAA1.js:5:6",
      "third-model-BBBBBBB2.js:7:8",
    ]);
    for (const secret of [
      "maria",
      "example.com",
      "123.456",
      "token",
      "abc",
      "evil",
      "foreign",
      "renderSecretCustomer",
      "fourth",
      "fifth",
      "https",
      "app.example",
      "assets",
      "not-an-asset",
    ]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it("has only the four required keys when nothing else is known", () => {
    const { report, send } = setup();
    report(new RangeError("x"), { kind: "error" });
    expect(bodyOf(send)).toEqual({
      errorName: "RangeError",
      kind: "error",
      routeId: "sale",
      v: 1,
    });
  });

  it("takes no position from a stack line of another origin, nor from a line that is no generated file", () => {
    const error = new Error("x");
    error.stack = [
      "Error: x",
      "    at https://evil.example/assets/foreign-QQQQQQQQ.js:1:2",
      `    at ${ORIGIN}/assets/nohash.js:1:2`,
      `    at ${ORIGIN}.evil.example/assets/spoof-QQQQQQQQ.js:1:2`,
    ].join("\n");
    const { report, send } = setup();
    report(error, { kind: "error" });
    expect(bodyOf(send)).not.toHaveProperty("frames");
  });
});

describe("the code and the status of an oRPC error", () => {
  const data = { reason: "secret-reason-value" };
  const message = "secret message text";

  it("keeps a code of the list and a status, and nothing of data or message", () => {
    const { report, send } = setup();
    report({ code: "CONFLICT", data, message, status: 409 }, { kind: "error" });
    const raw = String(send.mock.calls[0]?.[0]);
    expect(JSON.parse(raw)).toMatchObject({
      code: "CONFLICT",
      errorName: "Other",
      status: 409,
    });
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("reason");
    expect(raw).not.toContain("data");
  });

  it("does the same for an Error that carries them", () => {
    const { report, send } = setup();
    report(
      Object.assign(new Error(message), {
        code: "NOT_FOUND",
        data,
        status: 404,
      }),
      {
        kind: "rejection",
      }
    );
    const raw = String(send.mock.calls[0]?.[0]);
    expect(JSON.parse(raw)).toMatchObject({
      code: "NOT_FOUND",
      errorName: "Error",
      status: 404,
    });
    expect(raw).not.toContain("secret");
  });

  it("turns a code outside the list into OTHER, and leaves out a status that is no 4xx or 5xx", () => {
    const { report, send } = setup();
    report({ code: "MY_OWN_CODE", status: 200 }, { kind: "error" });
    const body = bodyOf(send);
    expect(body.code).toBe("OTHER");
    expect(body).not.toHaveProperty("status");
    expect(JSON.stringify(body)).not.toContain("MY_OWN_CODE");
  });

  it("reads nothing when the code is no string or the status no number", () => {
    const { report, send } = setup();
    report({ code: 409, status: "409" }, { kind: "error" });
    const body = bodyOf(send);
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("status");
  });
});

describe("the class of the error", () => {
  it("is Other for a class that is not in the closed list, whatever its name says", () => {
    class MyError extends Error {
      override name = "MyError";
    }
    const { report, send } = setup();
    report(new MyError("x"), { kind: "error" });
    const raw = String(send.mock.calls[0]?.[0]);
    expect(JSON.parse(raw).errorName).toBe("Other");
    expect(raw).not.toContain("MyError");
  });

  it("is the name of a class of the list", () => {
    const { report, send } = setup();
    report(new ReferenceError("x"), { kind: "error" });
    expect(bodyOf(send).errorName).toBe("ReferenceError");
  });

  it("is ChunkLoadError for the kind chunk", () => {
    const { report, send } = setup();
    report(new TypeError("Failed to fetch dynamically imported module"), {
      kind: "chunk",
    });
    expect(bodyOf(send).errorName).toBe("ChunkLoadError");
  });

  it.each([
    ["a string", "maria@example.com"],
    [
      "an object",
      {
        reason: "maria@example.com",
        stack: `at (${ORIGIN}/assets/a-AAAAAAAA.js:1:2)`,
      },
    ],
    ["null", null],
  ])(
    "is Other, with the kind alone and no position, for %s that was thrown",
    (_label, value) => {
      const { report, send } = setup();
      report(value, { kind: "rejection" });
      const raw = String(send.mock.calls[0]?.[0]);
      expect(JSON.parse(raw)).toEqual({
        errorName: "Other",
        kind: "rejection",
        routeId: "sale",
        v: 1,
      });
      expect(raw).not.toContain("maria");
    }
  );
});

describe("the limits of one page load", () => {
  it("sends at most three reports", () => {
    const { report, send } = setup();
    for (const error of [
      new Error("a"),
      new RangeError("b"),
      new ReferenceError("c"),
      new SyntaxError("d"),
    ]) {
      report(error, { kind: "error" });
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls.map((call) => JSON.parse(String(call[0])).errorName)
    ).toEqual(["Error", "RangeError", "ReferenceError"]);
  });

  it("sends the same failure once, whatever its text", () => {
    const { report, send } = setup();
    report(new TypeError("first text"), { kind: "error" });
    report(new TypeError("another text"), { kind: "error" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("tells the same error on another screen or in another boundary apart", () => {
    let pathname = "/sales";
    const { report, send } = setup({
      address: () => ({ pathname, search: "" }),
    });
    report(new TypeError("x"), { boundary: "screen", kind: "boundary" });
    report(new TypeError("x"), { boundary: "app", kind: "boundary" });
    pathname = "/customers";
    report(new TypeError("x"), { boundary: "app", kind: "boundary" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not spend the cap on a signature it already sent", () => {
    const { report, send } = setup();
    for (let i = 0; i < 5; i += 1) {
      report(new TypeError("x"), { kind: "error" });
    }
    report(new RangeError("x"), { kind: "error" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when the build has the reports off", () => {
    const { report, send } = setup({ enabled: false });
    report(new TypeError("x"), { kind: "error" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing while offline, and does not count the dropped one", () => {
    let online = false;
    const { report, send } = setup({ online: () => online });
    report(new TypeError("x"), { kind: "error" });
    expect(send).not.toHaveBeenCalled();
    online = true;
    report(new TypeError("x"), { kind: "error" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["NoWorkerAnswerError", "AbortError", "TimeoutError"])(
    "sends nothing for %s, a call that got no answer",
    (name) => {
      const { report, send } = setup();
      const error = new Error("x");
      error.name = name;
      for (const kind of ["boundary", "error", "rejection"] as const) {
        report(error, { kind });
      }
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("sends nothing for an unhandled rejection that is a failed fetch (a TypeError with no code), even as a cause", () => {
    const { report, send } = setup();
    report(new TypeError("Failed to fetch"), { kind: "rejection" });
    report(new Error("wrapper", { cause: new TypeError("Failed to fetch") }), {
      kind: "rejection",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does send a TypeError that is a bug of the app, and a rejection that has a code", () => {
    const { report, send } = setup();
    report(new TypeError("x is not a function"), { kind: "error" });
    report(
      Object.assign(new TypeError("x"), { code: "BAD_REQUEST", status: 400 }),
      {
        kind: "rejection",
      }
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never lets a failure of the sender or of the address come out", () => {
    const failing = setup({
      send: () => {
        throw new Error("send failed");
      },
    });
    expect(() =>
      failing.report(new TypeError("x"), { kind: "error" })
    ).not.toThrow();
    const noAddress = setup({
      address: () => {
        throw new Error("no window");
      },
    });
    expect(() =>
      noAddress.report(new TypeError("x"), { kind: "error" })
    ).not.toThrow();
    expect(noAddress.send).not.toHaveBeenCalled();
  });
});

describe("with Sentry started", () => {
  const info = { componentStack: "\n    at Secret" } as ErrorInfo;

  it("hands a render error to Sentry with its info and sends nothing to the route", () => {
    const reportRender = vi.fn();
    const { report, send } = setup({
      sentry: { active: () => true, reportRender },
    });
    const error = new TypeError("x");
    report(error, { boundary: "screen", kind: "boundary", renderInfo: info });
    expect(send).not.toHaveBeenCalled();
    expect(reportRender).toHaveBeenCalledTimes(1);
    expect(reportRender).toHaveBeenCalledWith(error, info);
    expect(reportRender.mock.calls[0]?.[1]).toBe(info);
  });

  it("gives Sentry nothing for what is no render error, and still sends nothing to the route", () => {
    const reportRender = vi.fn();
    const { report, send } = setup({
      sentry: { active: () => true, reportRender },
    });
    report(new TypeError("x"), { kind: "error" });
    report("not an error", { kind: "boundary", renderInfo: info });
    expect(reportRender).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not call Sentry when it is not started", () => {
    const { report, reportRender } = setup();
    report(new TypeError("x"), {
      boundary: "screen",
      kind: "boundary",
      renderInfo: info,
    });
    expect(reportRender).not.toHaveBeenCalled();
  });
});

describe("the release", () => {
  const environment = (release: string | undefined) => ({
    address: () => ({ pathname: "/", search: "" }),
    origin: () => ORIGIN,
    release,
  });

  it("keeps a short SHA, in lowercase", () => {
    const event = clientErrorEvent(
      new Error("x"),
      { kind: "error" },
      environment("9B3D37E")
    );
    expect(event.release).toBe("9b3d37e");
  });

  it.each(["v1.0", "", "  ", "9b3d37", "9b3d37ed5c223", "main", "g".repeat(8)])(
    "leaves out %j, which is no short SHA",
    (release) => {
      const event = clientErrorEvent(
        new Error("x"),
        { kind: "error" },
        environment(release)
      );
      expect(event).not.toHaveProperty("release");
    }
  );

  it("leaves it out when the build has none", () => {
    const event = clientErrorEvent(
      new Error("x"),
      { kind: "error" },
      environment(undefined)
    );
    expect(event).not.toHaveProperty("release");
  });
});

describe("the screen of the event", () => {
  it.each([
    ["/entrar", "", "entrar"],
    ["/criar-conta", "", "entrar"],
    ["/aceite", "?voltar=/sales", "aceite"],
    ["/", "", "home"],
    ["/products", "?aba=categorias", "products:categorias"],
    ["/products", "?aba=xyz", "products:produtos"],
    ["/sales/detail", "?id=abc", "sale-detail"],
    ["/configuracoes", "?aba=senha", "settings:senha"],
    ["/vendas/123", "", "outra"],
    ["/termos", "", "outra"],
  ])("names %s%s as %s, never the address", (pathname, search, expected) => {
    expect(clientErrorRouteId(pathname, search)).toBe(expected);
  });

  it("never lets an id or a token of the address into the event", () => {
    const event = clientErrorEvent(
      new Error("x"),
      { kind: "error" },
      {
        address: () => ({
          pathname: "/sales/detail",
          search: "?id=abc-secret",
        }),
        origin: () => ORIGIN,
        release: undefined,
      }
    );
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event.routeId).toBe("sale-detail");
  });
});

describe("the listeners of the page", () => {
  function install() {
    const listeners = new Map<string, (event: unknown) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener as (event: unknown) => void);
      },
    };
    const report = vi.fn();
    installClientErrorListeners(target as unknown as Window, report);
    return { listeners, report };
  }

  it("listens to error and unhandledrejection, and nothing else", () => {
    expect([...install().listeners.keys()].sort()).toEqual([
      "error",
      "unhandledrejection",
    ]);
  });

  it("reports nothing for an error event with no error object (a script of another origin)", () => {
    const { listeners, report } = install();
    listeners.get("error")?.({ error: null, message: "Script error." });
    listeners.get("error")?.({ message: "Script error." });
    expect(report).not.toHaveBeenCalled();
  });

  it("reports an error event that has the error, as kind error", () => {
    const { listeners, report } = install();
    const error = new TypeError("x");
    listeners.get("error")?.({ error });
    expect(report).toHaveBeenCalledWith(error, { kind: "error" });
  });

  it("reports an unhandled rejection as kind rejection", () => {
    const { listeners, report } = install();
    const reason = new RangeError("x");
    listeners.get("unhandledrejection")?.({ reason });
    expect(report).toHaveBeenCalledWith(reason, { kind: "rejection" });
  });

  it("reports an unhandled rejection that is a chunk that did not download as kind chunk", () => {
    const { listeners, report } = install();
    const reason = new TypeError(
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/expenses-page-DzKt9t-U.js`
    );
    listeners.get("unhandledrejection")?.({ reason });
    expect(report).toHaveBeenCalledWith(reason, { kind: "chunk" });
  });
});

describe("the sender of the browser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWithFlag(flag: string | undefined) {
    if (flag === undefined) {
      vi.stubEnv("VITE_CLIENT_ERRORS_ENABLED", "");
    } else {
      vi.stubEnv("VITE_CLIENT_ERRORS_ENABLED", flag);
    }
    vi.stubEnv("VITE_RELEASE", RELEASE);
    vi.resetModules();
    const fetchStub = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("window", {
      location: { origin: ORIGIN, pathname: "/sales", search: "" },
    });
    vi.stubGlobal("navigator", { onLine: true });
    const module = await import("./client-errors");
    return { fetchStub, module };
  }

  it("posts the body to /api/client-errors with keepalive, no credentials and a JSON type", async () => {
    const { fetchStub, module } = await loadWithFlag("true");
    module.reportClientError(new TypeError("maria@example.com"), {
      boundary: "app",
      kind: "boundary",
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/client-errors");
    expect(init).toMatchObject({
      credentials: "omit",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      boundary: "app",
      errorName: "TypeError",
      kind: "boundary",
      release: RELEASE,
      routeId: "sale",
      v: 1,
    });
  });

  it.each([undefined, "false", "1", "TRUE"])(
    'does not call fetch when VITE_CLIENT_ERRORS_ENABLED is %s, only "true" turns it on',
    async (flag) => {
      const { fetchStub, module } = await loadWithFlag(flag);
      module.reportClientError(new TypeError("x"), { kind: "error" });
      expect(fetchStub).not.toHaveBeenCalled();
    }
  );

  it("does not let a failed post come out as an unhandled rejection", async () => {
    const { fetchStub, module } = await loadWithFlag("true");
    fetchStub.mockImplementation(() => Promise.reject(new Error("offline")));
    module.reportClientError(new TypeError("x"), { kind: "error" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:\\])\/\/.*$/gm;
const STACK_READ = /\.stack\b/;
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ["message", /\.message\b/],
  // any other spelling of the text of the error: `error["message"]`, `const { message } = error`
  ["message word", /\bmessage\b/],
  ["cause", /\.cause\b/],
  ["cause word", /\bcause\b/],
  ["String()", /\bString\(/],
  ["toString()", /\.toString\(/],
  ["error in a template", /\$\{\s*(?:error|reason)\b/],
  ["spread of an error", /\.\.\.\s*(?:error|reason)\b/],
  ["JSON.stringify of anything but the event", /JSON\.stringify\((?!event\))/],
  ["componentStack", /componentStack/],
  ["renderInfo member", /renderInfo\./],
  ["location.href", /location\.href/],
  ["document.referrer", /document\.referrer/],
  ["localStorage", /localStorage/],
  ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/],
];

function withoutComments(text: string): string {
  return text.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "$1");
}

describe("what the code reads of an error", () => {
  const sourcePath = fileURLToPath(
    new URL("./client-errors.ts", import.meta.url)
  );
  const source = readFileSync(sourcePath, "utf8");

  function forbiddenIn(text: string): string[] {
    return FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(
      ([name]) => name
    );
  }

  it("takes the comments off before it looks, and keeps the code", () => {
    const code = withoutComments(source);
    expect(code).not.toContain("/**");
    expect(code).not.toContain("never read into it");
    expect(code).toContain("function framesOf(");
    expect(code).toContain("ASSET_POSITION");
  });

  it("catches an access planted in a string, so the check cannot go quiet", () => {
    expect(forbiddenIn("send(error.message)")).toEqual([
      "message",
      "message word",
    ]);
    expect(forbiddenIn("const c = error.cause;")).toEqual([
      "cause",
      "cause word",
    ]);
    expect(forbiddenIn("info.componentStack")).toEqual(["componentStack"]);
    expect(forbiddenIn("report.renderInfo.digest")).toEqual([
      "renderInfo member",
    ]);
    expect(forbiddenIn('send(error["message"])')).toEqual(["message word"]);
    expect(forbiddenIn("const { message } = error;")).toEqual(["message word"]);
    expect(forbiddenIn("const { cause } = error;")).toEqual(["cause word"]);
    expect(forbiddenIn("send(String(error))")).toEqual(["String()"]);
    expect(forbiddenIn("send(error.toString())")).toEqual(["toString()"]);
    expect(forbiddenIn("send(`${error}`)")).toEqual(["error in a template"]);
    expect(forbiddenIn("send({ ...error })")).toEqual(["spread of an error"]);
    expect(forbiddenIn("send(JSON.stringify(error))")).toEqual([
      "JSON.stringify of anything but the event",
    ]);
    expect(forbiddenIn("send(JSON.stringify(event))")).toEqual([]);
    expect(
      forbiddenIn(withoutComments("// error.message\nconst a = 1;"))
    ).toEqual([]);
    expect(
      forbiddenIn(withoutComments("/* error.message */ const a = 1;"))
    ).toEqual([]);
  });

  it("never reads the text, the cause, the component stack or the address of the page", () => {
    expect(forbiddenIn(withoutComments(source))).toEqual([]);
  });

  it("reads the stack only inside framesOf", () => {
    const code = withoutComments(source);
    const start = code.indexOf("function framesOf(");
    const end = code.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const inside = code.slice(start, end);
    const outside = code.slice(0, start) + code.slice(end);
    expect(inside).toMatch(STACK_READ);
    expect(outside).not.toMatch(STACK_READ);
  });
});

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;

/** Every source file of `apps/web/src` but the tests, as a path relative to it. */
function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(SOURCE_ROOT, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !TEST_FILE.test(entry.name)
    ) {
      const path = join(entry.parentPath, entry.name);
      // the comments may name the route (a doc comment does): only the code counts
      files.set(
        relative(SOURCE_ROOT, path),
        withoutComments(readFileSync(path, "utf8"))
      );
    }
  }
  return files;
}

function filesWith(files: Map<string, string>, pattern: RegExp): string[] {
  return [...files]
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => path)
    .sort();
}

const ROUTE_NAME = /\/api\/client-errors/;
const REPORT_CALL = /\breportClientError\(/;

describe("who reaches the report, in the whole source tree", () => {
  const files = sourceFiles();

  it("names the route only in the client, the route itself and the timing that leaves it out (exact list)", () => {
    expect(filesWith(files, ROUTE_NAME)).toEqual([
      "lib/client-errors.ts",
      "server/middleware/route-timing.ts",
      "server/routes/client-errors.ts",
    ]);
  });

  it("calls reportClientError only from the error boundary and the client itself (exact list)", () => {
    expect(filesWith(files, REPORT_CALL)).toEqual([
      "app-shell/error-boundary.tsx",
      "lib/client-errors.ts",
    ]);
  });

  it("would see a file that posts to the route or reports on its own", () => {
    const planted = new Map(files);
    planted.set("sales/planted.ts", 'fetch("/api/client-errors")');
    planted.set("home/planted.tsx", "reportClientError(error, report)");
    expect(filesWith(planted, ROUTE_NAME)).toContain("sales/planted.ts");
    expect(filesWith(planted, REPORT_CALL)).toContain("home/planted.tsx");
  });
});
