import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContactGroup } from "./customer-form";

const LEGEND_IN_FIELDSET =
  /<fieldset[^>]*>.*<legend[^>]*>Telefone ou e-mail \(um dos dois\)<\/legend>/s;
const noop = () => undefined;
const render = (contactError: string | null = null) =>
  renderToStaticMarkup(
    <ContactGroup
      contactError={contactError}
      email=""
      onEmail={noop}
      onPhone={noop}
      phone=""
    />
  );

describe("o grupo de contato do cadastro de cliente", () => {
  it("diz uma vez, na legenda do grupo, que um dos dois basta", () => {
    expect(render()).toMatch(LEGEND_IN_FIELDSET);
  });

  it("não marca nenhum dos dois campos como Opcional", () => {
    expect(render()).not.toContain("Opcional");
  });

  it("marca os dois campos quando falta contato, ligados à mensagem do formulário", () => {
    const html = render(
      "Informe ao menos um telefone ou email para o cliente."
    );
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
    expect(
      html.match(/aria-describedby="customer-contact-error"/g)
    ).toHaveLength(2);
  });
});
