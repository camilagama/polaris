import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  render,
  Text,
} from "react-email";
import {
  ActionButton,
  BILLING_EMAIL_SUPPLIER,
  paragraphStyle,
  smallStyle,
} from "../../billing/emails/billing-notice-email";
import type { BillingEmailLink } from "../../billing/emails/content";
import { subjectStore } from "../../billing/emails/format";
import { emailColors } from "../../email-colors.generated";
import type { UnsubscribeHeaders } from "../../privacy/closure-notice-email";
import { unsubscribeLink } from "../../tips-stop/unsubscribe-token";

/**
 * The "Dicas para começar" e-mails (ADR 0106): A1, A2 for a store with no product (S0) or with one (S1), and A3 with
 * one fixed sentence per state. The layout and the corporate name are the billing ones, with no image, pixel, tracking
 * parameter or redirect: every link is absolute, on the app's own origin, with no store and no token, except the stop
 * link, which carries the token of the person. The store's name, cut at 24 and only in the body, is the one fact of
 * the store or the person in the message; the subject never has it.
 */

export type ActivationNoticeVariant =
  | "a1"
  | "a2_s0"
  | "a2_s1"
  | "a3_s0"
  | "a3_s1";

/**
 * The model of a step for the state read at the send: S0 is a store with no product, S1 one with a product. A1 only
 * speaks to a store with no product, so A1 with a product has no model (null) and is not sent.
 */
export function activationNoticeVariant(
  step: "a1" | "a2" | "a3",
  hasProduct: boolean
): ActivationNoticeVariant | null {
  switch (step) {
    case "a1":
      return hasProduct ? null : "a1";
    case "a2":
      return hasProduct ? "a2_s1" : "a2_s0";
    case "a3":
      return hasProduct ? "a3_s1" : "a3_s0";
    default:
      throw new RangeError("activation_notice_step_unknown");
  }
}

export interface ActivationNoticeEmail {
  /** The app's base (`BETTER_AUTH_BASE_URL`): only its origin is kept, for every link and for `List-Unsubscribe`. */
  appBaseUrl: string;
  store: string;
  supportEmail: string;
  unsubscribeToken: string;
  variant: ActivationNoticeVariant;
}

export interface ActivationNoticeContent {
  action: BillingEmailLink | null;
  heading: string;
  paragraphs: string[];
  preview: string;
  /** At most 40 characters and never the store's name. */
  subject: string;
  textLink: BillingEmailLink | null;
}

export const ACTIVATION_SUBJECT_MAX = 40;

// the bidirectional controls would let a name turn the text around it; nothing a store's name needs
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// what reads as nothing: a name of only these would leave a blank where the store goes
const INVISIBLE = /[\p{Cf}\p{Z}\u3164\u115f\u1160\u2800]/gu;

/** The store's name as the body reads it: one line, no bidirectional control, at most 24 characters and "…". */
export function activationStoreName(name: string): string {
  const cut = subjectStore(name.replaceAll(BIDI_CONTROLS, ""));
  if (cut.replaceAll(INVISIBLE, "").length === 0) {
    throw new RangeError("activation_notice_store_missing");
  }
  return cut;
}

function appUrl(appBaseUrl: string, path: string): string {
  return new URL(path, new URL(appBaseUrl).origin).toString();
}

const ADD_FIRST_PRODUCT = "Cadastrar o primeiro produto";

export function activationNoticeContent(
  email: Pick<ActivationNoticeEmail, "appBaseUrl" | "store" | "variant">
): ActivationNoticeContent {
  const store = activationStoreName(email.store);
  const products: BillingEmailLink = {
    label: ADD_FIRST_PRODUCT,
    url: appUrl(email.appBaseUrl, "/products"),
  };
  switch (email.variant) {
    case "a1": {
      const first = `A loja ${store} já está criada.`;
      return {
        action: products,
        heading: "Falta só o primeiro produto na sua loja",
        paragraphs: [
          `${first} Para fazer a primeira venda, falta cadastrar um produto.`,
          "Cadastre um agora, ou importe uma planilha se a lista já está pronta.",
        ],
        preview: first,
        subject: "Falta só o primeiro produto na sua loja",
        textLink: null,
      };
    }
    case "a2_s1": {
      const first = "Loja criada e primeiro produto: feitos.";
      return {
        action: {
          label: "Fazer a primeira venda",
          url: appUrl(email.appBaseUrl, "/sales"),
        },
        heading: "Falta só a primeira venda",
        paragraphs: [
          `${first} Agora é fazer a primeira venda: escolha o produto, a quantidade e como foi pago.`,
          "Leva menos de um minuto.",
        ],
        preview: first,
        subject: "Falta só a primeira venda",
        textLink: null,
      };
    }
    case "a2_s0": {
      const first = "Criar a loja foi o começo.";
      return {
        action: products,
        heading: "Sua loja ainda está sem produtos",
        paragraphs: [
          `${first} O próximo passo é cadastrar o primeiro produto.`,
          "Se a lista já está numa planilha, dá para importar tudo de uma vez.",
        ],
        preview: first,
        subject: "Sua loja ainda está sem produtos",
        textLink: null,
      };
    }
    case "a3_s0":
    case "a3_s1": {
      const missing =
        email.variant === "a3_s0"
          ? "cadastrar o primeiro produto"
          : "fazer a primeira venda";
      const first = `Faz alguns dias que a loja ${store} foi criada e ainda falta ${missing}.`;
      return {
        action: null,
        heading: "Algo está travando na sua loja?",
        paragraphs: [
          first,
          "Se algo não ficou claro, ou não funcionou no seu celular, responda este e-mail com uma frase: uma pessoa lê. Não envie senha, dados de clientes nem documentos.",
          "Este é o último e-mail destas dicas.",
        ],
        preview: first,
        subject: "Algo está travando na sua loja?",
        textLink: { label: "Abrir a loja", url: appUrl(email.appBaseUrl, "/") },
      };
    }
    default:
      throw new RangeError("activation_notice_variant_unknown");
  }
}

function activationUnsubscribeUrl(
  email: Pick<ActivationNoticeEmail, "appBaseUrl" | "unsubscribeToken">
): string {
  return unsubscribeLink(email.appBaseUrl, email.unsubscribeToken);
}

/** The one-click stop of RFC 8058: the mail reader posts `List-Unsubscribe=One-Click` to the same link. */
export function activationNoticeHeaders(
  unsubscribeUrl: string
): UnsubscribeHeaders {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

const textLinkStyle = {
  ...paragraphStyle,
  color: emailColors.foreground,
  textDecoration: "underline",
  textDecorationLine: "underline",
} as const;

function ActivationNoticeLayout({
  content,
  privacyUrl,
  store,
  supportEmail,
  unsubscribeUrl,
}: {
  content: ActivationNoticeContent;
  privacyUrl: string;
  store: string;
  supportEmail: string;
  unsubscribeUrl: string;
}) {
  const muted = { ...smallStyle, color: emailColors.mutedForeground };
  return (
    <Html dir="ltr" lang="pt-BR">
      <Head />
      <Preview>{content.preview}</Preview>
      <Body
        style={{
          backgroundColor: emailColors.background,
          color: emailColors.foreground,
          fontFamily: "Arial, sans-serif",
          margin: 0,
          padding: "24px 12px",
        }}
      >
        <Container style={{ margin: "0 auto", maxWidth: "560px" }}>
          <Heading as="h1" style={{ fontSize: "22px", fontWeight: 600 }}>
            Polaris
          </Heading>
          <Heading
            as="h2"
            style={{
              fontSize: "18px",
              fontWeight: 600,
              lineHeight: "26px",
              overflowWrap: "anywhere",
            }}
          >
            {content.heading}
          </Heading>
          {content.paragraphs.map((paragraph) => (
            <Text key={paragraph} style={paragraphStyle}>
              {paragraph}
            </Text>
          ))}
          {content.textLink ? (
            <Text style={paragraphStyle}>
              <Link href={content.textLink.url} style={textLinkStyle}>
                {content.textLink.label}
              </Link>
            </Text>
          ) : null}
          {content.action ? <ActionButton link={content.action} /> : null}
          <Text style={{ ...muted, marginTop: "32px" }}>
            Você recebe este e-mail porque criou a loja {store} no Polaris e
            ainda não fez a primeira venda. São no máximo 3 e-mails nos
            primeiros 14 dias, só para ajudar você a começar.
          </Text>
          <Text style={paragraphStyle}>
            <Link href={unsubscribeUrl} style={textLinkStyle}>
              Parar de receber estas dicas
            </Link>
          </Text>
          <Text style={muted}>
            Os avisos da sua conta e da cobrança continuam, porque fazem parte
            do serviço.
          </Text>
          <Text style={muted}>{BILLING_EMAIL_SUPPLIER}</Text>
          <Text style={muted}>
            {supportEmail} ·{" "}
            <Link
              href={privacyUrl}
              style={{
                color: emailColors.mutedForeground,
                textDecoration: "underline",
                textDecorationLine: "underline",
              }}
            >
              Política de Privacidade
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * Renders one tips e-mail and its stop headers: the same notice always renders the same message (a retry repeats it
 * under the same key).
 */
export async function renderActivationNoticeEmail(
  email: ActivationNoticeEmail
): Promise<{
  headers: UnsubscribeHeaders;
  html: string;
  subject: string;
  text: string;
}> {
  const content = activationNoticeContent(email);
  const unsubscribeUrl = activationUnsubscribeUrl(email);
  const element = (
    <ActivationNoticeLayout
      content={content}
      privacyUrl={appUrl(email.appBaseUrl, LEGAL_PATHS.privacy)}
      store={activationStoreName(email.store)}
      supportEmail={email.supportEmail}
      unsubscribeUrl={unsubscribeUrl}
    />
  );
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return {
    headers: activationNoticeHeaders(unsubscribeUrl),
    html,
    subject: content.subject,
    text,
  };
}
