import { readFileSync } from "node:fs";
import { expect, openJourney, test } from "../fixtures";
import { workerLogPath } from "../worker-log";

/**
 * An error forced on a screen of the real app reaches `POST /api/client-errors` and becomes one `client_error` line
 * of the Worker, with the fields of the closed list and nothing else: not the text of the error (an e-mail, a CPF and
 * a URL with a token), not the address, the IP or the user agent. The Worker logs a signature once per isolate, so a
 * retry opens another screen (another signature).
 */

const HOSTILE_MESSAGE =
  "maria@example.com 123.456.789-09 https://x.example/?token=abc";
const SCREENS = [
  { path: "/products", routeId: "products:produtos" },
  { path: "/customers", routeId: "customers" },
] as const;
const EVENT_KEYS = ["errorName", "kind", "release", "routeId", "v"];
const RELEASE = /^[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;
/** The keys the logger itself puts on every line (evlog). */
const LOGGER_KEYS = new Set([
  "commitHash",
  "environment",
  "event",
  "level",
  "region",
  "service",
  "timestamp",
  "version",
]);
/** One field of a logged object as the preview prints it (`  key: 'text',`, `  key: 1,`, `  key: [ 'a', 'b' ],`). */
const FIELD = /^ {2}(\w+): (.*?),?$/;
const QUOTED = /'([^']*)'/g;

function fieldValue(raw: string): unknown {
  if (raw === "undefined") {
    return undefined;
  }
  if (raw.startsWith("[")) {
    return [...raw.matchAll(QUOTED)].map((match) => match[1]);
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, -1);
  }
  return Number(raw);
}

/**
 * The objects the preview of the project logged so far, from its output (serve.ts keeps a copy): the logger writes
 * one object per event and the preview prints it over several lines, from a `{` to a `}` at the start of a line.
 */
function loggedEvents(project: string): {
  fields: Record<string, unknown>;
  text: string;
}[] {
  let output: string;
  try {
    output = readFileSync(workerLogPath(project), "utf8");
  } catch {
    return [];
  }
  const events: { fields: Record<string, unknown>; text: string }[] = [];
  let block: string[] | null = null;
  for (const line of output.split("\n")) {
    if (line === "{") {
      block = [];
    } else if (line === "}" && block !== null) {
      const fields: Record<string, unknown> = {};
      for (const field of block) {
        const match = FIELD.exec(field);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          fields[match[1]] = fieldValue(match[2]);
        }
      }
      events.push({ fields, text: block.join("\n") });
      block = null;
    } else if (block !== null) {
      block.push(line);
    }
  }
  return events;
}

function clientErrorLines(project: string) {
  return loggedEvents(project).filter(
    ({ fields }) => fields.event === "client_error"
  );
}

test("erro forçado numa tela: uma linha client_error com os campos da lista e nada mais", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "erro-de-tela");
  const { page } = journey;
  const screen = SCREENS[
    testInfo.retry % SCREENS.length
  ] as (typeof SCREENS)[number];
  const project = testInfo.project.name;
  const before = clientErrorLines(project).length;

  await page.goto(screen.path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const reported = page.waitForResponse((answer) =>
    answer.url().endsWith("/api/client-errors")
  );
  // a microtask, not a timer: the timers of the page are the fake clock's (`page.clock`), which catches what they throw
  await page.evaluate((message) => {
    queueMicrotask(() => {
      throw new TypeError(message);
    });
  }, HOSTILE_MESSAGE);
  const response = await reported;
  expect(response.status()).toBe(204);

  const request = response.request();
  const sent = request.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(sent).sort()).toEqual(EVENT_KEYS);
  expect(sent).toMatchObject({
    errorName: "TypeError",
    kind: "error",
    routeId: screen.routeId,
    v: 1,
  });
  expect(String(sent.release)).toMatch(RELEASE);
  expect(request.postData()).not.toContain("maria");
  expect(request.postData()).not.toContain("token");
  // `credentials: "omit"`: the report carries no cookie, though the page has a session
  expect(await request.headerValue("cookie")).toBeNull();

  await expect
    .poll(() => clientErrorLines(project).length, { timeout: 15_000 })
    .toBe(before + 1);
  const { fields: line, text } = clientErrorLines(project).at(-1) as {
    fields: Record<string, unknown>;
    text: string;
  };
  expect(
    Object.keys(line)
      .filter((key) => !LOGGER_KEYS.has(key))
      .sort()
  ).toEqual(["errorClass", "fingerprint", "kind", "release", "routeId", "v"]);
  expect(line).toMatchObject({
    errorClass: "TypeError",
    kind: "error",
    release: sent.release,
    routeId: screen.routeId,
    v: 1,
  });
  expect(String(line.fingerprint)).toMatch(FINGERPRINT);
  // nothing of the error, of the address or of the request in the line (the preview's own access log names paths)
  for (const forbidden of [
    "maria",
    "123.456.789-09",
    "token",
    screen.path,
    "127.0.0.1",
    "Chrome",
  ]) {
    expect(text).not.toContain(forbidden);
  }
  const output = readFileSync(workerLogPath(project), "utf8");
  for (const forbidden of ["maria@example.com", "token=abc"]) {
    expect(output).not.toContain(forbidden);
  }
});
