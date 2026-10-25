import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./error-boundary";

const CHUNK_ERROR = new TypeError(
  "Failed to fetch dynamically imported module: https://app.example/assets/expenses-page-DzKt9t-U.js"
);

function memoryStorage() {
  const values: Record<string, string> = {};
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

function boundaryFailedWith(error: unknown, onRetry?: () => void) {
  const boundary = new ErrorBoundary(
    onRetry ? { children: null, onRetry } : { children: null }
  );
  boundary.state = ErrorBoundary.getDerivedStateFromError(error);
  const setState = vi.fn();
  boundary.setState = setState;
  return { boundary, setState };
}

function stubBrowser() {
  const reload = vi.fn();
  vi.stubGlobal("window", {
    location: { reload },
    sessionStorage: memoryStorage(),
  });
  return reload;
}

describe("Tentar novamente", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads the page when the screen's chunk did not download, because React.lazy keeps the failed import", () => {
    const reload = stubBrowser();
    const onRetry = vi.fn();
    const { boundary, setState } = boundaryFailedWith(CHUNK_ERROR, onRetry);
    boundary.handleRetry();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(setState).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not reload twice in a row: the second try resets the lazy screen and renders again", () => {
    const reload = stubBrowser();
    const onRetry = vi.fn();
    const { boundary, setState } = boundaryFailedWith(CHUNK_ERROR, onRetry);
    boundary.handleRetry();
    boundary.handleRetry();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith({
      chunkFailed: false,
      failed: false,
    });
  });

  it("resets the lazy screen and renders again, with no reload, for any other error", () => {
    const reload = stubBrowser();
    const onRetry = vi.fn();
    const { boundary, setState } = boundaryFailedWith(
      new TypeError("x is not a function"),
      onRetry
    );
    boundary.handleRetry();
    expect(reload).not.toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith({
      chunkFailed: false,
      failed: false,
    });
  });
});
