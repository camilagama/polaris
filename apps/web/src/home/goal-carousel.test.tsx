// @vitest-environment happy-dom
import type { GoalReadModel } from "@polaris/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { GoalSlides, GoalStepper, useGoalPosition } from "./goal-carousel";

const goalNamed = (n: number, name: string): GoalReadModel => ({
  achievedValue: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  endsOn: "2026-11-30",
  id: `0199c2d0-0000-7000-8000-00000000040${n}`,
  kind: "net_sales",
  name,
  organizationId: "org",
  paused: false,
  progress: null,
  settledAt: null,
  startsOn: "2026-11-01",
  status: "active",
  target: "5000.00",
  updatedAt: "2026-11-01T12:00:00.000Z",
  version: 1,
});

const A = goalNamed(1, "Alfa");
const B = goalNamed(2, "Beta");
const C = goalNamed(3, "Gama");

function Harness({ goals }: { goals: readonly GoalReadModel[] }) {
  const position = useGoalPosition(goals);
  return (
    <section>
      <GoalStepper {...position} />
      <GoalSlides
        position={position}
        slides={goals.map((goal) => ({
          id: goal.id,
          node: <p data-name="">{goal.name}</p>,
        }))}
      />
    </section>
  );
}

const unmounts: (() => void)[] = [];

function mount(goals: readonly GoalReadModel[]) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: readonly GoalReadModel[]) =>
    act(() => {
      root.render(<Harness goals={next} />);
    });
  render(goals);
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (name: string) => {
    const found = host.querySelector(`button[aria-label="${name}"]`);
    if (!(found instanceof HTMLButtonElement)) {
      throw new Error(`no button ${name}`);
    }
    return found;
  };
  return {
    announcement: () =>
      host.querySelector("[data-goal-announcement]")?.textContent ?? "",
    click: (name: string) =>
      act(() => {
        button(name).click();
      }),
    open: () =>
      host.querySelector('[data-goal-slide="open"]')?.textContent ?? "",
    render,
    position: () => host.querySelector("[data-goal-stepper]")?.textContent,
  };
}

afterEach(() => {
  while (unmounts.length > 0) {
    unmounts.pop()?.();
  }
});

describe("useGoalPosition", () => {
  it("opens the first goal and announces nothing until a step", () => {
    const view = mount([A, B, C]);
    expect(view.open()).toBe("Alfa");
    expect(view.announcement()).toBe("");
    expect(view.position()).toContain("1 de 3");
  });

  it("steps by one, says where it is, and stops at both ends", () => {
    const view = mount([A, B, C]);
    view.click("Próxima meta");
    expect(view.open()).toBe("Beta");
    expect(view.announcement()).toBe("Meta 2 de 3: Beta");
    view.click("Próxima meta");
    view.click("Próxima meta");
    expect(view.open()).toBe("Gama");
    expect(view.announcement()).toBe("Meta 3 de 3: Gama");
    view.click("Meta anterior");
    view.click("Meta anterior");
    view.click("Meta anterior");
    expect(view.open()).toBe("Alfa");
    expect(view.announcement()).toBe("Meta 1 de 3: Alfa");
  });

  it("keeps the goal in view when a new read reorders the list", () => {
    const view = mount([A, B, C]);
    view.click("Próxima meta");
    expect(view.open()).toBe("Beta");
    view.render([C, B, A]);
    expect(view.open()).toBe("Beta");
    expect(view.position()).toContain("2 de 3");
  });

  it("goes back to the first goal of the new order when the one in view is gone", () => {
    const view = mount([A, B, C]);
    view.click("Próxima meta");
    view.render([C, A]);
    expect(view.open()).toBe("Gama");
    expect(view.position()).toContain("1 de 2");
  });

  it("marks the arrow with nowhere to go and leaves the other one alone", () => {
    const view = mount([A, B]);
    expect(view.position()).toContain("1 de 2");
    const previous = document.querySelector(
      'button[aria-label="Meta anterior"]'
    );
    const next = document.querySelector('button[aria-label="Próxima meta"]');
    expect(previous?.getAttribute("aria-disabled")).toBe("true");
    expect(next?.getAttribute("aria-disabled")).toBeNull();
    view.click("Próxima meta");
    expect(previous?.getAttribute("aria-disabled")).toBeNull();
    expect(next?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps every goal in the DOM, the ones out of view inert", () => {
    mount([A, B, C]);
    const slides = [...document.querySelectorAll("[data-goal-slide]")];
    expect(
      slides.map((slide) => slide.getAttribute("data-goal-slide"))
    ).toEqual(["open", "closed", "closed"]);
    expect(slides.map((slide) => slide.hasAttribute("inert"))).toEqual([
      false,
      true,
      true,
    ]);
  });
});
