import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORT_EMAIL } from "../lib/support-contact";
import {
  ConfirmEmailPage,
  ConfirmEmailPanel,
  VerifyLink,
} from "./confirm-email-page";
import { ForgotPasswordPage } from "./forgot-password-page";
import {
  ResetLinkMissing,
  ResetPasswordForm,
  ResetPasswordPage,
} from "./reset-password-page";
import { SignUpPage } from "./sign-up-page";

const HELP_LINE = "Precisa de ajuda? Escreva para";
const NAME = `aria-label="Escrever para o suporte: ${SUPPORT_EMAIL}"`;
const HREF = `href="mailto:${SUPPORT_EMAIL}"`;

function expectHelpLine(markup: string) {
  expect(markup).toContain(HELP_LINE);
  expect(markup).toContain(NAME);
  expect(markup).toContain(HREF);
  expect(markup.split(HELP_LINE)).toHaveLength(2);
}

beforeEach(() => {
  vi.stubGlobal("window", {
    history: { replaceState: () => undefined },
    location: { hash: "", pathname: "/", search: "" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a linha de ajuda nas telas de senha e de conta", () => {
  it("Criar conta, enquanto os métodos carregam", () => {
    expectHelpLine(renderToStaticMarkup(<SignUpPage />));
  });

  it("Esqueci a senha, enquanto os métodos carregam", () => {
    expectHelpLine(renderToStaticMarkup(<ForgotPasswordPage />));
  });

  it("Confirmar e-mail, enquanto os métodos carregam", () => {
    expectHelpLine(renderToStaticMarkup(<ConfirmEmailPage />));
  });

  it("Confirmar e-mail, com o link vencido e o reenvio", () => {
    expectHelpLine(
      renderToStaticMarkup(
        <ConfirmEmailPanel
          email={null}
          help
          intro="Este link venceu."
          siteKey={null}
        />
      )
    );
  });

  it("Confirmar e-mail, confirmando o link", () => {
    expectHelpLine(
      renderToStaticMarkup(<VerifyLink siteKey={null} token="tok" />)
    );
  });

  it("Redefinir senha, o formulário", () => {
    expectHelpLine(
      renderToStaticMarkup(<ResetPasswordForm siteKey={null} token="tok" />)
    );
  });

  it("Redefinir senha, o link que falta e o link inválido", () => {
    expectHelpLine(
      renderToStaticMarkup(<ResetLinkMissing neutral text="Abra o link." />)
    );
    expectHelpLine(renderToStaticMarkup(<ResetLinkMissing text="Inválido." />));
  });

  it("Redefinir senha, enquanto os métodos carregam", () => {
    expectHelpLine(renderToStaticMarkup(<ResetPasswordPage />));
  });

  it("o painel de 'Confirme seu e-mail' de /entrar segue sem a linha", () => {
    const markup = renderToStaticMarkup(
      <ConfirmEmailPanel email="a@b.co" intro="Confirme." siteKey={null} />
    );
    expect(markup).not.toContain(HELP_LINE);
  });
});
