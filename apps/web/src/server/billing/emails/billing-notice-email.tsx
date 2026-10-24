import type { BillingNoticeKind } from "@polaris/domain/billing/notices";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  render,
  Section,
  Text,
} from "react-email";
import { emailColors } from "../../email-colors.generated";
import { type AccessEndedEmail, accessEndedContent } from "./access-ended";
import {
  type AnnualRenewalReminderEmail,
  annualRenewalReminderContent,
} from "./annual-renewal-reminder";
import {
  type ChargeReceiptEmail,
  chargeReceiptContent,
} from "./charge-receipt";
import type { BillingEmailLink, BillingNoticeContent } from "./content";
import {
  type FirstChargeFailedEmail,
  firstChargeFailedContent,
} from "./first-charge-failed";
import {
  type RefundConfirmedEmail,
  refundConfirmedContent,
} from "./refund-confirmed";
import {
  type RenewalCancelledEmail,
  renewalCancelledContent,
} from "./renewal-cancelled";
import {
  type RenewalFailedEmail,
  renewalFailedContent,
} from "./renewal-failed";
import {
  type TrialChargeEveEmail,
  trialChargeEveContent,
} from "./trial-charge-eve";
import { type TrialStartedEmail, trialStartedContent } from "./trial-started";
import { type WelcomeEmail, welcomeContent } from "./welcome";

/**
 * The e-mails of the billing cycle and the welcome (ADR 0104, decision 7; corte `emails-ciclo-cobranca`): one model per
 * kind, the same layout for all. React Email with no image, no pixel and no tracking parameter (AC-20); the colors of
 * `theme.css` (AC-17); the HTML and the plain text from the same element. Only the store's name, the plan, dates,
 * amounts, the kind of method and what to do (AC-10): nothing of the payer, of the card or of the provider.
 */

/** One e-mail to render: its kind and what its text reads. */
export type BillingNoticeEmail =
  | ({ kind: "access_ended" } & AccessEndedEmail)
  | ({ kind: "annual_renewal_reminder" } & AnnualRenewalReminderEmail)
  | ({ kind: "charge_receipt" } & ChargeReceiptEmail)
  | ({ kind: "first_charge_failed" } & FirstChargeFailedEmail)
  | ({ kind: "refund_confirmed" } & RefundConfirmedEmail)
  | ({ kind: "renewal_cancelled" } & RenewalCancelledEmail)
  | ({ kind: "renewal_failed" } & RenewalFailedEmail)
  | ({ kind: "trial_charge_eve" } & TrialChargeEveEmail)
  | ({ kind: "trial_started" } & TrialStartedEmail)
  | ({ kind: "welcome" } & WelcomeEmail);

export function billingNoticeContent(
  email: BillingNoticeEmail
): BillingNoticeContent {
  switch (email.kind) {
    case "access_ended":
      return accessEndedContent(email);
    case "annual_renewal_reminder":
      return annualRenewalReminderContent(email);
    case "charge_receipt":
      return chargeReceiptContent(email);
    case "first_charge_failed":
      return firstChargeFailedContent(email);
    case "refund_confirmed":
      return refundConfirmedContent(email);
    case "renewal_cancelled":
      return renewalCancelledContent(email);
    case "renewal_failed":
      return renewalFailedContent(email);
    case "trial_charge_eve":
      return trialChargeEveContent(email);
    case "trial_started":
      return trialStartedContent(email);
    case "welcome":
      return welcomeContent(email);
    default:
      throw new RangeError("billing_notice_kind_unknown");
  }
}

/** Every kind has a model (the test lists them against the domain's). */
export const BILLING_NOTICE_EMAIL_KINDS: readonly BillingNoticeKind[] = [
  "trial_started",
  "trial_charge_eve",
  "first_charge_failed",
  "renewal_failed",
  "access_ended",
  "charge_receipt",
  "renewal_cancelled",
  "refund_confirmed",
  "annual_renewal_reminder",
  "welcome",
];

/**
 * Who supplies the Polaris, as in the Terms (AC-19). The complete corporate name is P48: it changes here and in the
 * Terms together, before the switch goes on in production.
 */
export const BILLING_EMAIL_SUPPLIER =
  "Polaris, um produto de Agência Summit, CNPJ 35.584.467/0001-00.";

/** The footer of every e-mail (AC-17, AC-19); the welcome is not about a subscription. */
export function billingEmailFooter(
  footer: BillingNoticeContent["footer"],
  supportEmail: string
): string[] {
  return [
    footer === "subscription"
      ? "Este é um aviso automático sobre a sua assinatura. O Polaris nunca pede a sua senha por e-mail."
      : "Este é um e-mail automático do Polaris. O Polaris nunca pede a sua senha por e-mail.",
    `Dúvidas: responda este e-mail ou escreva para ${supportEmail}.`,
    BILLING_EMAIL_SUPPLIER,
  ];
}

const paragraphStyle = {
  fontSize: "16px",
  lineHeight: "24px",
  overflowWrap: "anywhere",
} as const;
const smallStyle = {
  fontSize: "14px",
  lineHeight: "21px",
  overflowWrap: "anywhere",
} as const;

function ActionButton({ link }: { link: BillingEmailLink }) {
  return (
    <>
      <Button
        href={link.url}
        style={{
          backgroundColor: emailColors.primary,
          borderRadius: "4px",
          boxSizing: "border-box",
          color: emailColors.primaryForeground,
          display: "inline-block",
          fontSize: "16px",
          lineHeight: "24px",
          maxWidth: "100%",
          padding: "12px 20px",
          textDecoration: "none",
        }}
      >
        {link.label}
      </Button>
      <Text style={{ ...smallStyle, color: emailColors.foreground }}>
        Se o botão não funcionar, abra este endereço: {link.url}
      </Text>
    </>
  );
}

function BillingNoticeLayout({
  content,
  supportEmail,
}: {
  content: BillingNoticeContent;
  supportEmail: string;
}) {
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
          <ActionButton link={content.action} />
          {content.extra ? (
            <Section>
              <Hr style={{ borderColor: emailColors.mutedForeground }} />
              {content.extra.paragraphs.map((paragraph) => (
                <Text key={paragraph} style={paragraphStyle}>
                  {paragraph}
                </Text>
              ))}
              <ActionButton link={content.extra.action} />
            </Section>
          ) : null}
          {billingEmailFooter(content.footer, supportEmail).map((line) => (
            <Text
              key={line}
              style={{ ...smallStyle, color: emailColors.mutedForeground }}
            >
              {line}
            </Text>
          ))}
        </Container>
      </Body>
    </Html>
  );
}

/** Renders one e-mail: the same notice always renders the same message (a retry repeats it under the same key). */
export async function renderBillingNoticeEmail(
  email: BillingNoticeEmail,
  supportEmail: string
): Promise<{ html: string; subject: string; text: string }> {
  const content = billingNoticeContent(email);
  const element = (
    <BillingNoticeLayout content={content} supportEmail={supportEmail} />
  );
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, subject: content.subject, text };
}
