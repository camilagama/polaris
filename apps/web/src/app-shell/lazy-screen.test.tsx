import { Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { lazyScreen } from "./lazy-screen";

function Hello({ name }: { name: string }) {
  return <p>Olá, {name}</p>;
}

describe("a lazy screen that can be asked again", () => {
  it("calls import() again after reset, where React.lazy would keep the rejected promise", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("Failed to fetch dynamically imported module")
      )
      .mockResolvedValue({ default: Hello });
    const Screen = lazyScreen<{ name: string }>(load);
    const render = () =>
      renderToStaticMarkup(
        <Suspense fallback="carregando">
          <Screen name="Ana" />
        </Suspense>
      );

    expect(render()).toBe("carregando");
    expect(load).toHaveBeenCalledTimes(1);
    await load.mock.results[0]?.value.catch(() => undefined);
    // without a reset the same rejected promise answers: no new import
    try {
      render();
    } catch {
      // the rejection is thrown to the boundary
    }
    expect(load).toHaveBeenCalledTimes(1);

    Screen.reset();
    expect(render()).toBe("carregando");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
