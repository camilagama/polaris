import type { Dom } from "../dom";
import { hasControlCharacter } from "../dom";
import type { Choices } from "../privacy";

/** The server's limit for a privacy note, a decision's note and a resolution (`MAX_PRIVACY_NOTE_LENGTH`). */
export const MAX_NOTE_LENGTH = 500;
/** The server's limit and alphabet for the opaque reference to the subject (`MAX_PRIVACY_REFERENCE_LENGTH`). */
export const MAX_REFERENCE_LENGTH = 64;
const OPAQUE_REFERENCE = /^[A-Za-z0-9_-]+$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const NO_PERSONAL_DATA =
  "Não escreva nome, e-mail, documento nem valor de registro: o atendimento guarda só códigos e uma nota curta.";

export interface Field<T extends HTMLElement> {
  control: T;
  /** The label, the control, its error line and its hints, in that order. */
  element: HTMLElement;
  error: HTMLElement;
  /** Marks the field as refused, says why and puts the focus on it. */
  refuse: (text: string) => void;
  reset: () => void;
}

function wrap<T extends HTMLElement>(
  dom: Dom,
  id: string,
  label: string,
  control: T,
  hints: readonly HTMLElement[]
): Field<T> {
  const error = dom.el("p", {
    "aria-live": "polite",
    class: "field-error",
    id: `${id}-erro`,
  });
  control.setAttribute(
    "aria-describedby",
    [`${id}-erro`, ...hints.map((hint) => hint.getAttribute("id") ?? "")]
      .filter((value) => value !== "")
      .join(" ")
  );
  const reset = () => {
    error.textContent = "";
    control.removeAttribute("aria-invalid");
  };
  control.addEventListener("input", reset);
  control.addEventListener("change", reset);
  return {
    control,
    element: dom.el(
      "div",
      { class: "field" },
      dom.el("label", { for: id }, label),
      control,
      error,
      ...hints
    ),
    error,
    refuse: (text) => {
      error.textContent = text;
      control.setAttribute("aria-invalid", "true");
      control.focus();
    },
    reset,
  };
}

/**
 * A choice of a closed list with nothing chosen: the first option is "Escolha…" with no value, so the screen never
 * picks a code for the operator (AC-P11.3). The options are the codes of the list, in its order.
 */
export function choiceField(
  dom: Dom,
  id: string,
  label: string,
  list: Choices,
  hint?: string
): Field<HTMLSelectElement> {
  const select = dom.el(
    "select",
    { id, name: id },
    dom.el("option", { selected: "", value: "" }, "Escolha…"),
    ...list.map(([code, words]) => dom.el("option", { value: code }, words))
  );
  const hints =
    hint === undefined
      ? []
      : [dom.el("p", { class: "hint", id: `${id}-dica` }, hint)];
  return wrap(dom, id, label, select, hints);
}

export interface RadioChoice {
  /** The legend, the three or more radios and the error line of the group. */
  element: HTMLElement;
  /** The code of the radio that is checked, or null when none is. */
  chosen: () => string | null;
  /** Says why nothing was chosen and puts the focus on the first radio. */
  refuse: (text: string) => void;
  first: HTMLInputElement;
}

/**
 * A choice among facts that exclude each other, all in view: a group of radios with nothing checked, so the screen
 * never picks a code for the operator (AC-P11.3, AC-P12.2). The codes are those of the list, in its order.
 */
export function radioChoice(
  dom: Dom,
  id: string,
  legend: string,
  list: Choices
): RadioChoice {
  const error = dom.el("p", {
    "aria-live": "polite",
    class: "field-error",
    id: `${id}-erro`,
  });
  const radios = list.map(([code, words]) => {
    const input = dom.el("input", {
      id: `${id}-${code}`,
      name: id,
      type: "radio",
      value: code,
    });
    input.addEventListener("change", () => {
      error.textContent = "";
      for (const other of radios) {
        other.input.removeAttribute("aria-invalid");
      }
    });
    return {
      code,
      element: dom.el(
        "div",
        { class: "check" },
        input,
        dom.el("label", { for: `${id}-${code}` }, words)
      ),
      input,
    };
  });
  const first = radios[0]?.input ?? dom.el("input", { type: "radio" });
  return {
    chosen: () => radios.find((radio) => radio.input.checked)?.code ?? null,
    element: dom.el(
      "fieldset",
      { "aria-describedby": `${id}-erro`, class: "radio-field", id },
      dom.el("legend", {}, legend),
      ...radios.map((radio) => radio.element),
      error
    ),
    first,
    refuse: (text) => {
      error.textContent = text;
      for (const radio of radios) {
        radio.input.setAttribute("aria-invalid", "true");
      }
      first.focus();
    },
  };
}

/** A short text with its counter, cut by the browser at the server's limit. */
export function textField(
  dom: Dom,
  id: string,
  label: string,
  max: number,
  hint?: string
): Field<HTMLInputElement> {
  const input = dom.el("input", {
    autocomplete: "off",
    id,
    maxlength: String(max),
    name: id,
    spellcheck: "false",
    type: "text",
  });
  const counter = dom.el(
    "p",
    { class: "hint", id: `${id}-contador` },
    `0 de ${max} caracteres`
  );
  input.addEventListener("input", () => {
    counter.textContent = `${[...input.value].length} de ${max} caracteres`;
  });
  const hints = [counter];
  if (hint !== undefined) {
    hints.push(dom.el("p", { class: "hint", id: `${id}-dica` }, hint));
  }
  return wrap(dom, id, label, input, hints);
}

/** A field with no counter (a date, a UUID). */
export function plainField(
  dom: Dom,
  id: string,
  label: string,
  type: "date" | "text",
  hint: string
): Field<HTMLInputElement> {
  const input = dom.el("input", {
    autocomplete: "off",
    id,
    name: id,
    spellcheck: "false",
    type,
  });
  return wrap(dom, id, label, input, [
    dom.el("p", { class: "hint", id: `${id}-dica` }, hint),
  ]);
}

/** Why a short optional text would be refused by the server, or null when it would be taken. */
export function noteProblem(
  text: string,
  name: string,
  max = MAX_NOTE_LENGTH
): string | null {
  if ([...text].length > max) {
    return `${name} aceita até ${max} caracteres.`;
  }
  if (hasControlCharacter(text)) {
    return `${name} não aceita caracteres de controle nem quebra de linha.`;
  }
  return null;
}

export function referenceProblem(text: string): string | null {
  if (text === "") {
    return null;
  }
  if ([...text].length > MAX_REFERENCE_LENGTH || !OPAQUE_REFERENCE.test(text)) {
    return `A referência é um código: letras sem acento, números, - e _, até ${MAX_REFERENCE_LENGTH}. Nunca nome, e-mail ou documento.`;
  }
  return null;
}

export function isUuidText(text: string): boolean {
  return UUID.test(text);
}
