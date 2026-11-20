// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineRuntimeProvider } from "./runtime-provider";

const fakes = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      getSnapshot: () => ({ phase: "ready", sessionRefused: false }),
      pageReturned: vi.fn(() => {
        calls.push("pageReturned");
      }),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      subscribe: () => () => undefined,
      workSource: () => ({}),
    },
    scheduler: {
      refresh: vi.fn(() => {
        calls.push("refresh");
        return Promise.resolve();
      }),
      stop: vi.fn(),
      syncNow: vi.fn(() => Promise.resolve()),
    },
  };
});

vi.mock("./enabled", () => ({ OFFLINE_RUNTIME_ENABLED: true }));
vi.mock("./offline-runtime", () => ({
  OfflineRuntime: vi.fn(function FakeRuntime() {
    return fakes.runtime;
  }),
}));
vi.mock("./sync-scheduler", () => ({
  startSyncScheduler: vi.fn(
    (dependencies: { onVisible: (listener: () => void) => () => void }) => {
      const stopVisible = dependencies.onVisible(() => {
        fakes.scheduler.refresh();
      });
      return {
        ...fakes.scheduler,
        stop: () => {
          stopVisible();
          fakes.scheduler.stop();
        },
      };
    }
  ),
}));
vi.mock("./sync-leader", () => ({
  holdSyncLeadership: () => ({ isLeader: () => true, stop: () => undefined }),
}));
vi.mock("./runtime-api", () => ({ createRpcRuntimeApi: () => ({}) }));
vi.mock("./data-channel", () => ({ openBrowserDataChannel: () => ({}) }));
vi.mock("./runtime-stores", () => ({ openRuntimeStores: () => ({}) }));
vi.mock("./session-ended", () => ({ isSessionOver: () => false }));
vi.mock("../logout-purge", () => ({
  purgeNamespace: () => undefined,
  wipeNamespaceCollections: () => undefined,
}));
vi.mock("../outbox/outbox-on-disk", () => ({ anyOutboxOnDisk: () => false }));
vi.mock("../namespace", () => ({ localNamespace: () => "ns" }));
vi.mock("../../lib/orpc", () => ({ orpcClient: {} }));
vi.mock("../../lib/connection", () => ({
  timerSchedule: () => () => undefined,
}));
vi.mock("../../pwa/runtime", () => ({ getUpdateStore: () => null }));
vi.mock("../../lib/legal-acceptance", () => ({
  isLegalAcceptanceRequired: () => false,
  subscribeLegalAcceptance: () => () => undefined,
}));
vi.mock("../../lib/browser-connection", () => ({
  addConnectionTry: () => () => undefined,
  browserConnection: { attach: () => () => undefined, isOnline: () => true },
  browserSessionLookup: () => null,
  lockInBrowser: () => undefined,
  markInBrowser: () => undefined,
}));
vi.mock("../../lib/current-organization", () => ({
  useOrganizationLoad: () => ({
    load: { current: { id: "org-a" }, status: "ready" },
    reload: () => undefined,
  }),
}));

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function mountProvider() {
  const view = render(
    <OfflineRuntimeProvider>
      <span>filho</span>
    </OfflineRuntimeProvider>
  );
  await waitFor(() => expect(fakes.scheduler.refresh).toHaveBeenCalled());
  return view;
}

describe("OfflineRuntimeProvider: volta da aba", () => {
  beforeEach(() => {
    fakes.calls.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("começa pelo refresh da partida, antes de qualquer volta", async () => {
    await mountProvider();
    expect(fakes.runtime.start).toHaveBeenCalledWith("org-a");
    expect(fakes.runtime.pageReturned).not.toHaveBeenCalled();
    expect(fakes.scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("ao ficar visível chama pageReturned uma vez e o refresh em seguida", async () => {
    await mountProvider();
    fakes.calls.length = 0;
    act(() => setVisibility("visible"));
    expect(fakes.runtime.pageReturned).toHaveBeenCalledTimes(1);
    expect(fakes.calls).toEqual(["pageReturned", "refresh"]);
  });

  it("com a aba escondida não chama nada", async () => {
    await mountProvider();
    fakes.calls.length = 0;
    act(() => setVisibility("hidden"));
    expect(fakes.runtime.pageReturned).not.toHaveBeenCalled();
    expect(fakes.calls).toEqual([]);
  });

  it("ao desmontar o ouvinte sai: novo evento não chama nada", async () => {
    const view = await mountProvider();
    view.unmount();
    expect(fakes.scheduler.stop).toHaveBeenCalledTimes(1);
    fakes.calls.length = 0;
    act(() => setVisibility("visible"));
    expect(fakes.runtime.pageReturned).not.toHaveBeenCalled();
    expect(fakes.calls).toEqual([]);
  });
});
