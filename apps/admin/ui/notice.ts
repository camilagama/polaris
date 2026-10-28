import type { Dom } from "./dom";

/**
 * The two lines of each area: one announced politely (loading, how many were found) and one alert that takes the
 * focus, so a keyboard or screen reader user lands on the problem (AC-14, AC-15).
 */
export interface Notice {
  /** Something went wrong: the sentence is shown, announced and focused. */
  alert: (text: string) => void;
  clear: () => void;
  element: HTMLElement;
  /** Progress or a result, announced without moving the focus. */
  status: (text: string) => void;
}

export function createNotice(dom: Dom): Notice {
  const status = dom.el("p", { class: "status", role: "status" });
  const alert = dom.el("p", {
    class: "alert",
    hidden: "",
    role: "alert",
    tabindex: "-1",
  });
  const clear = () => {
    status.textContent = "";
    alert.textContent = "";
    alert.setAttribute("hidden", "");
  };
  return {
    alert: (text) => {
      clear();
      alert.textContent = text;
      alert.removeAttribute("hidden");
      alert.focus();
    },
    clear,
    element: dom.el("div", { class: "notice" }, status, alert),
    status: (text) => {
      clear();
      status.textContent = text;
    },
  };
}
