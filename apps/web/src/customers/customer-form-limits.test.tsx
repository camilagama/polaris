// @vitest-environment happy-dom
import {
  MAX_CUSTOMER_EMAIL_LENGTH,
  MAX_CUSTOMER_NAME_LENGTH,
  MAX_CUSTOMER_NOTES_LENGTH,
  MAX_CUSTOMER_PHONE_LENGTH,
} from "@polaris/domain/customers/customer";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomerDraft } from "./customer-draft";
import { CustomerForm } from "./customer-form";

const noop = () => undefined;
const keepFocus = () => true;

function Harness() {
  const [draft, setDraft] = useState<CustomerDraft>({
    email: "",
    name: "",
    notes: "",
    phone: "",
  });
  const handleChange = useCallback(
    (field: keyof CustomerDraft, value: string) =>
      setDraft((current) => ({ ...current, [field]: value })),
    []
  );
  return (
    <CustomerForm
      contactError={null}
      draft={draft}
      duplicateMatches={[]}
      editingCustomer={null}
      error={null}
      feedbackRef={null}
      finalFocus={keepFocus}
      isPending={false}
      notice={null}
      onCancel={noop}
      onChange={handleChange}
      onClosed={noop}
      onCreateAnyway={noop}
      onDismiss={noop}
      onSubmit={noop}
      onUseExisting={noop}
      open
    />
  );
}

const FIELDS = [
  { filler: "a", label: "Nome", limit: MAX_CUSTOMER_NAME_LENGTH },
  { filler: "1", label: "Telefone", limit: MAX_CUSTOMER_PHONE_LENGTH },
  { filler: "a", label: "E-mail", limit: MAX_CUSTOMER_EMAIL_LENGTH },
  { filler: "a", label: "Observações", limit: MAX_CUSTOMER_NOTES_LENGTH },
] as const;

afterEach(cleanup);

describe("os limites do formulário de cliente são os que o servidor aceita", () => {
  for (const { label, limit } of FIELDS) {
    it(`${label}: o atributo maxlength é ${limit}, o do domínio`, async () => {
      render(<Harness />);
      const field = await screen.findByLabelText(new RegExp(`^${label}`));
      expect(field.getAttribute("maxlength")).toBe(String(limit));
    });
  }

  // o user-event só aplica maxlength a tipos que ele lista, e "tel" não está entre eles
  for (const { label, limit, filler } of FIELDS.filter(
    (field) => field.label !== "Telefone"
  )) {
    it(`${label}: ${limit} caracteres cabem e o seguinte não entra`, async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const field = await screen.findByLabelText(new RegExp(`^${label}`));
      await user.click(field);
      await user.paste(filler.repeat(limit));
      expect((field as HTMLInputElement).value).toHaveLength(limit);
      await user.paste(filler);
      expect((field as HTMLInputElement).value).toHaveLength(limit);
    });

    it(`${label}: colar ${limit + 500} caracteres deixa ${limit} no campo`, async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const field = await screen.findByLabelText(new RegExp(`^${label}`));
      await user.click(field);
      await user.paste(filler.repeat(limit + 500));
      expect((field as HTMLInputElement).value).toBe(filler.repeat(limit));
    });
  }
});
