/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import type {
  BrowserContext,
  CDPSession,
  Page,
  TestInfo,
} from "@playwright/test";

/**
 * What a tab did, in the order it happened, kept so a red run says who broke a file of the page: the browser (the
 * request that was cancelled or failed, with the reason it reports), the service worker (the requests it made and its
 * console) or a `route` of the test. Nothing is read unless a check fails, so a green run only pays for the listeners.
 * `E2E_CPU_THROTTLE=4` slows the page's CPU 4 times, the slow runner where the rare red shows up.
 */
export interface Trace {
  lines: string[];
  note: (what: string) => void;
  routed: string[];
}

export function createTrace(): Trace {
  const started = performance.now();
  const lines: string[] = [];
  return {
    lines,
    note: (what) =>
      lines.push(`+${Math.round(performance.now() - started)}ms ${what}`),
    routed: [],
  };
}

/** The files the page needs to start: its documents and scripts, and the worker and the retry script. */
const WATCHED_TYPES = new Set(["Document", "Script"]);
const WATCHED_PATHS = /^\/(assets\/|boot-retry\.js|sw\.js)/;

const BAD_LINE = /net FAILED|script error|worker request FAILED/;
const LEAVING_DOCUMENT = /net FAILED Document .*canceled=true/;

interface Pending {
  fromDiskCache: boolean;
  fromServiceWorker: boolean;
  received: number;
  status: number | null;
  type: string;
  url: string;
}

function pathOf(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function describe(pending: Pending) {
  return `${pending.type} ${pathOf(pending.url)} status=${pending.status ?? "-"} sw=${pending.fromServiceWorker} diskCache=${pending.fromDiskCache} received=${pending.received}B`;
}

/**
 * `Network.*` of the page by CDP: one line per watched request when it finishes or fails, with the fields of the
 * protocol that tell a cancelled load (`canceled`) from a blocked one (`blockedReason`) from a lost connection
 * (`errorText`); and the requests, responses and console of the service worker, which the page events do not carry.
 */
export async function traceNetwork(
  context: BrowserContext,
  page: Page,
  trace: Trace
) {
  const pending = new Map<string, Pending>();
  const session: CDPSession = await context.newCDPSession(page);
  const watched = (type: string | undefined, url: string) =>
    WATCHED_TYPES.has(type ?? "") || WATCHED_PATHS.test(pathOf(url));
  session.on("Network.requestWillBeSent", (event) => {
    if (watched(event.type, event.request.url)) {
      pending.set(event.requestId, {
        fromDiskCache: false,
        fromServiceWorker: false,
        received: 0,
        status: null,
        type: event.type ?? "Other",
        url: event.request.url,
      });
    }
  });
  session.on("Network.responseReceived", (event) => {
    const entry = pending.get(event.requestId);
    if (entry) {
      entry.status = event.response.status;
      entry.fromDiskCache = event.response.fromDiskCache ?? false;
      entry.fromServiceWorker = event.response.fromServiceWorker ?? false;
    }
  });
  session.on("Network.dataReceived", (event) => {
    const entry = pending.get(event.requestId);
    if (entry) {
      entry.received += event.encodedDataLength;
    }
  });
  session.on("Network.loadingFinished", (event) => {
    const entry = pending.get(event.requestId);
    if (entry) {
      entry.received = Math.max(entry.received, event.encodedDataLength);
      trace.note(`net ok ${describe(entry)}`);
      pending.delete(event.requestId);
    }
  });
  session.on("Network.loadingFailed", (event) => {
    const entry = pending.get(event.requestId);
    if (entry) {
      trace.note(
        `net FAILED ${describe(entry)} errorText=${event.errorText} canceled=${event.canceled ?? false} blockedReason=${event.blockedReason ?? "-"} corsError=${event.corsErrorStatus?.corsError ?? "-"}`
      );
      pending.delete(event.requestId);
    }
  });
  await session.send("Network.enable");
  const slowdown = Number(process.env.E2E_CPU_THROTTLE ?? "1");
  if (slowdown > 1) {
    await session.send("Emulation.setCPUThrottlingRate", { rate: slowdown });
  }
  context.on("request", (request) => {
    if (request.serviceWorker()) {
      trace.note(
        `worker request ${request.resourceType()} ${pathOf(request.url())}`
      );
    }
  });
  context.on("requestfailed", (request) => {
    if (request.serviceWorker()) {
      trace.note(
        `worker request FAILED ${request.resourceType()} ${pathOf(request.url())} (${request.failure()?.errorText})`
      );
    }
  });
  context.on("response", (response) => {
    if (response.request().serviceWorker()) {
      trace.note(
        `worker response ${response.status()} ${pathOf(response.url())}`
      );
    }
  });
  context.on("console", (message) => {
    const fromPage = message.page() !== null;
    if (
      !fromPage ||
      message.type() === "error" ||
      message.type() === "warning"
    ) {
      trace.note(
        `console ${fromPage ? "page" : "worker"} ${message.type()}: ${message.text()}`
      );
    }
  });
}

/** Routes of the context that note which request each one answered: what the test itself did to the page's requests. */
export async function tracedRoute(
  context: BrowserContext,
  trace: Trace,
  pattern: string | RegExp,
  handler: Parameters<BrowserContext["route"]>[1]
) {
  await context.route(pattern, (route, request) => {
    const what = `${request.method()} ${pathOf(request.url())}`;
    trace.routed.push(what);
    trace.note(`route ${pattern} answered ${what}`);
    return handler(route, request);
  });
}

/** What the tab did from `from` (an index of `trace.lines`) on, with the lines just before it, capped to the last `count`. */
export function since(trace: Trace, from: number, count: number) {
  return trace.lines
    .slice(Math.max(0, from - 10))
    .slice(-count)
    .join("; ");
}

/**
 * The lines of the trace that did not end well from `from` on, for the text of a failure. A document the browser
 * cancelled because the page was leaving is how a reload looks, so it is counted and not listed.
 */
export function failedFiles(trace: Trace, from = 0) {
  const lines = trace.lines.slice(from).filter((line) => BAD_LINE.test(line));
  const leaving = lines.filter((line) => LEAVING_DOCUMENT.test(line)).length;
  const others = lines.filter((line) => !LEAVING_DOCUMENT.test(line));
  return `${others.length === 0 ? "none" : others.slice(-10).join("; ")} (${leaving} documents cancelled while leaving)`;
}

/** Written to the test's output directory and attached by path, so the whole trace is kept and not cut by the reporter. */
export async function attachTraces(
  testInfo: TestInfo,
  traces: Map<string, Trace>
) {
  for (const [name, trace] of traces) {
    const path = testInfo.outputPath(`rastro-${name}.txt`);
    // biome-ignore lint/performance/noAwaitInLoops: a few files, in order
    await writeFile(
      path,
      [
        `routes that answered a request: ${trace.routed.length}`,
        `files that did not load: ${failedFiles(trace)}`,
        ...trace.lines,
      ].join("\n")
    );
    await testInfo.attach(`rastro-${name}.txt`, {
      contentType: "text/plain",
      path,
    });
  }
}
