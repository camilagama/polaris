import type { ScreenContext } from "../app";
import { type Dom, hasControlCharacter } from "../dom";
import { entitlementText } from "../format";
import { MAX_HOURS, MAX_REASON_LENGTH } from "../grant-limits";

const WHOLE_NUMBER = /^\d{1,9}$/;

export const GRANT_RAISES =
  "A concessão só eleva o plano da loja; nunca reduz um limite nem desliga um recurso.";
export const GRANT_EXPIRES = "Expira sozinha no prazo.";

export interface GrantFields {
  hours: number;
  key: string;
  reason: string;
  value: boolean | number;
}

interface Typed {
  hours: string;
  key: string;
  reason: string;
  value: string;
}

interface Problem {
  field: "chave" | "horas" | "motivo" | "valor";
  text: string;
}

export function fingerprintOf(fields: GrantFields): string {
  return JSON.stringify([
    fields.key,
    fields.value,
    fields.hours,
    fields.reason,
  ]);
}

/** Only the shape and the length of what was typed: what a grant may be is the server's to say. */
function problemOf(context: ScreenContext, typed: Typed): Problem | null {
  const known = [...context.limitKeys, ...context.flagKeys];
  if (!known.includes(typed.key)) {
    return { field: "chave", text: "Escolha o recurso ou limite da lista." };
  }
  if (
    context.limitKeys.includes(typed.key) &&
    !WHOLE_NUMBER.test(typed.value)
  ) {
    return {
      field: "valor",
      text: "Escreva o valor como um número inteiro, só com algarismos.",
    };
  }
  const hours = Number(typed.hours);
  if (!WHOLE_NUMBER.test(typed.hours) || hours < 1 || hours > MAX_HOURS) {
    return {
      field: "horas",
      text: `Escreva o prazo em horas inteiras, de 1 a ${MAX_HOURS} (366 dias).`,
    };
  }
  if (typed.reason === "") {
    return { field: "motivo", text: "Escreva o motivo da concessão." };
  }
  if ([...typed.reason].length > MAX_REASON_LENGTH) {
    return {
      field: "motivo",
      text: `O motivo aceita até ${MAX_REASON_LENGTH} caracteres.`,
    };
  }
  if (hasControlCharacter(typed.reason)) {
    return {
      field: "motivo",
      text: "O motivo não aceita caracteres de controle nem quebra de linha.",
    };
  }
  return null;
}

function fieldsOf(context: ScreenContext, typed: Typed): GrantFields {
  return {
    hours: Number(typed.hours),
    key: typed.key,
    reason: typed.reason,
    value: context.flagKeys.includes(typed.key)
      ? typed.value === "true"
      : Number(typed.value),
  };
}

export interface GrantFormOptions {
  onCancel: () => void;
  onReview: (fields: GrantFields) => void;
  prefill: GrantFields | null;
  /** What the server refused the last time, said in words above the form. */
  refusal: string;
}

/**
 * The form of a grant: the key (only those the Worker named), the value (a whole number for a limit, yes or no for a
 * capability), the length in hours and the reason, with a counter. It checks the shape of what was typed and hands the
 * fields to the review; a mistake is said next to the field, with the focus on it.
 */
export function grantForm(
  dom: Dom,
  context: ScreenContext,
  options: GrantFormOptions
): { element: HTMLElement; focus: () => void } {
  const keys = [...context.limitKeys, ...context.flagKeys];
  const key = dom.el(
    "select",
    { id: "concessao-chave", name: "chave" },
    dom.el("option", { value: "" }, "Escolha…"),
    ...keys.map((name) =>
      dom.el("option", { value: name }, entitlementText(name))
    )
  );
  const hours = dom.el("input", {
    autocomplete: "off",
    id: "concessao-horas",
    name: "horas",
    type: "text",
  });
  const reason = dom.el("input", {
    autocomplete: "off",
    id: "concessao-motivo",
    maxlength: String(MAX_REASON_LENGTH),
    name: "motivo",
    type: "text",
  });
  const counter = dom.el("p", { class: "hint", id: "concessao-contador" });
  const error = dom.el("p", {
    "aria-live": "polite",
    class: "field-error",
    id: "concessao-erro",
    tabindex: "-1",
  });
  const valueBox = dom.el("div", { class: "grant-value" });
  let value: HTMLInputElement | HTMLSelectElement = dom.el("input", {
    id: "concessao-valor",
    type: "text",
  });

  const renderValue = () => {
    const flag = context.flagKeys.includes(key.value);
    value = flag
      ? dom.el(
          "select",
          { id: "concessao-valor", name: "valor" },
          dom.el("option", { value: "true" }, "Sim (ligado)"),
          dom.el("option", { value: "false" }, "Não (desligado)")
        )
      : dom.el("input", {
          autocomplete: "off",
          id: "concessao-valor",
          name: "valor",
          type: "text",
        });
    dom.fill(
      valueBox,
      dom.el(
        "label",
        { for: "concessao-valor" },
        flag ? "Valor (sim ou não)" : "Valor (número inteiro)"
      ),
      value
    );
  };
  const count = () => {
    counter.textContent = `${[...reason.value].length} de ${MAX_REASON_LENGTH} caracteres`;
  };
  key.addEventListener("change", renderValue);
  reason.addEventListener("input", count);
  renderValue();
  const { prefill } = options;
  if (prefill !== null) {
    key.value = prefill.key;
    renderValue();
    value.value = String(prefill.value);
    hours.value = String(prefill.hours);
    reason.value = prefill.reason;
  }
  count();

  const next = dom.el("button", { type: "submit" }, "Revisar a concessão");
  const cancel = dom.el(
    "button",
    { class: "secondary", type: "button" },
    "Cancelar"
  );
  cancel.addEventListener("click", options.onCancel);
  const form = dom.el(
    "form",
    { class: "search", novalidate: "" },
    dom.el("label", { for: "concessao-chave" }, "Recurso ou limite"),
    key,
    valueBox,
    dom.el("label", { for: "concessao-horas" }, "Prazo em horas"),
    hours,
    dom.el(
      "p",
      { class: "hint" },
      `Número inteiro, de 1 a ${MAX_HOURS} horas (366 dias).`
    ),
    dom.el("label", { for: "concessao-motivo" }, "Motivo"),
    reason,
    counter,
    error,
    dom.el("p", {}, GRANT_RAISES),
    dom.el("p", {}, GRANT_EXPIRES),
    dom.el("div", { class: "button-row" }, next, cancel)
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";
    for (const field of [key, value, hours, reason]) {
      field.removeAttribute("aria-invalid");
    }
    const typed: Typed = {
      hours: hours.value.trim(),
      key: key.value,
      reason: reason.value.trim(),
      value: value.value.trim(),
    };
    const problem = problemOf(context, typed);
    if (problem === null) {
      options.onReview(fieldsOf(context, typed));
      return;
    }
    error.textContent = problem.text;
    const field = { chave: key, horas: hours, motivo: reason, valor: value }[
      problem.field
    ];
    field.setAttribute("aria-invalid", "true");
    field.focus();
  });
  const heading = dom.el(
    "h4",
    { id: "concessao-formulario", tabindex: "-1" },
    "Dar uma concessão"
  );
  if (options.refusal !== "") {
    error.textContent = options.refusal;
  }
  return {
    element: dom.el("div", {}, heading, form),
    focus: () => (options.refusal === "" ? key : error).focus(),
  };
}
