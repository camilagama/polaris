import type { ClosureNoticeDelivery } from "@polaris/db/privacy-maintenance";
import { CLOSURE_RECOVERY_WINDOW_DAYS } from "@polaris/domain/organization/closure";
import {
  CLOSURE_DELETABLE_AFTER_DAYS,
  CLOSURE_PURGE_MIN_NOTICE_DAYS,
  localDate,
} from "@polaris/domain/organization/closure-deadlines";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  render,
  Text,
} from "react-email";

/**
 * The e-mail of a closure notice (ADR 0102 amended, design t107 §5), one per milestone: the request, D minus 30 and
 * minus 7 days, D, and a purge rescheduled after a legal hold. Only what the condition of the security review allows:
 * the store's name, the dates in the organization's calendar and a link to the panel, which asks the owner to sign in
 * (no token in the URL). Nothing of the owner (name, address) is in the text; the address only goes to the provider.
 * The days of the text come from the domain, as in the terms and the panel ("a partir de", 30 and 90 days).
 */

const DAY_MS = 86_400_000;

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

/** A calendar date (YYYY-MM-DD) as "18 de janeiro de 2027". */
export function formatCalendarDate(date: string): string {
  return dateFormatter.format(new Date(`${date}T12:00:00.000Z`));
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).format(instant);
}

/** The panel of the store: the app's own origin, with no path parameter, query or token. */
export function closureNoticePanelUrl(appOrigin: string): string {
  return `${new URL(appOrigin).origin}/`;
}

export interface ClosureNoticeContent {
  actionLabel: string;
  heading: string;
  paragraphs: string[];
  preview: string;
  subject: string;
}

/**
 * The first day the data may be deleted, as the owner reads it: D, or for a `d7` sent again by the support the day 7
 * days after it was sent again (the purge never runs sooner than 7 days after the delivery), or the new date of a
 * rescheduled purge. Deterministic for a notice, so a retry sends the same message under the same idempotency key.
 */
export function closureNoticeDeletionDate(
  delivery: ClosureNoticeDelivery
): string {
  if (delivery.milestone === "rescheduled" && delivery.purgeFrom) {
    return localDate(delivery.purgeFrom, delivery.timeZone);
  }
  if (delivery.milestone === "d7") {
    const afterNotice = localDate(
      new Date(
        delivery.dueAt.getTime() + CLOSURE_PURGE_MIN_NOTICE_DAYS * DAY_MS
      ),
      delivery.timeZone
    );
    return afterNotice > delivery.deletionDate
      ? afterNotice
      : delivery.deletionDate;
  }
  return delivery.deletionDate;
}

export function closureNoticeContent(
  delivery: ClosureNoticeDelivery
): ClosureNoticeContent {
  const store = delivery.organizationName;
  const requested = formatCalendarDate(
    localDate(delivery.requestedAt, delivery.timeZone)
  );
  const deletionDay = formatCalendarDate(delivery.deletionDate);
  const firstDay = formatCalendarDate(closureNoticeDeletionDate(delivery));
  // the copy can be asked for until D (`exportOpenUntil`): a notice due on D or later says the time is over
  const copyLine =
    delivery.dueAt.getTime() < delivery.deletableFrom.getTime()
      ? `Se quiser guardar uma cópia dos dados, peça pelo painel antes de ${deletionDay}.`
      : "O prazo para pedir uma cópia dos dados já terminou.";
  const signIn =
    "Para abrir o painel, entre no Polaris com a sua conta de dono da loja.";
  switch (delivery.milestone) {
    case "closure":
      return {
        actionLabel: "Abrir o painel",
        heading: "Recebemos o pedido de encerramento da loja",
        paragraphs: [
          `Recebemos em ${requested} o pedido para encerrar a loja ${store}.`,
          `Você pode desfazer o encerramento nos primeiros ${CLOSURE_RECOVERY_WINDOW_DAYS} dias, até ${formatCalendarDate(localDate(delivery.recoverUntil, delivery.timeZone))}, às ${formatTime(delivery.recoverUntil, delivery.timeZone)}.`,
          `Os dados da loja ficam guardados por ${CLOSURE_DELETABLE_AFTER_DAYS} dias depois do pedido e podem ser apagados a partir de ${deletionDay}. ${copyLine}`,
          `${signIn} Se você não reconhece este pedido, entre e desfaça o encerramento.`,
        ],
        preview: `O pedido de encerramento da loja ${store} foi recebido.`,
        subject: "Recebemos o pedido de encerramento da sua loja no Polaris",
      };
    case "d30":
      return {
        actionLabel: "Abrir o painel",
        heading: "Faltam 30 dias",
        paragraphs: [
          `Os dados da loja ${store}, encerrada em ${requested}, podem ser apagados a partir de ${deletionDay}.`,
          copyLine,
          signIn,
        ],
        preview: `Os dados da loja ${store} podem ser apagados a partir de ${deletionDay}.`,
        subject: `Os dados da sua loja no Polaris podem ser apagados a partir de ${deletionDay}`,
      };
    case "d7":
      return {
        actionLabel: "Abrir o painel",
        heading: "Os dados da loja serão apagados",
        paragraphs: [
          `Os dados da loja ${store}, encerrada em ${requested}, podem ser apagados a partir de ${firstDay}. Depois de apagados, não podem ser recuperados.`,
          copyLine,
          signIn,
        ],
        preview: `Os dados da loja ${store} podem ser apagados a partir de ${firstDay}.`,
        subject: `Os dados da sua loja no Polaris podem ser apagados a partir de ${firstDay}`,
      };
    case "deletion_day":
      return {
        actionLabel: "Abrir o painel",
        heading: "Os dados da loja podem ser apagados a partir de hoje",
        paragraphs: [
          `Os dados da loja ${store}, encerrada em ${requested}, podem ser apagados a qualquer momento a partir de hoje, ${deletionDay}. Depois de apagados, não podem ser recuperados.`,
          copyLine,
          signIn,
        ],
        preview: `Os dados da loja ${store} podem ser apagados a partir de hoje.`,
        subject:
          "Os dados da sua loja no Polaris podem ser apagados a partir de hoje",
      };
    case "rescheduled":
      return {
        actionLabel: "Abrir o painel",
        heading: "Nova data para o apagamento dos dados",
        paragraphs: [
          `O apagamento dos dados da loja ${store}, encerrada em ${requested}, foi adiado. Agora eles podem ser apagados a partir de ${firstDay}. Depois de apagados, não podem ser recuperados.`,
          copyLine,
          signIn,
        ],
        preview: `Os dados da loja ${store} podem ser apagados a partir de ${firstDay}.`,
        subject: "Nova data para o apagamento dos dados da sua loja no Polaris",
      };
    default:
      throw new RangeError("closure_notice_milestone_unknown");
  }
}

function ClosureNoticeEmail({
  content,
  panelUrl,
}: {
  content: ClosureNoticeContent;
  panelUrl: string;
}) {
  return (
    <Html dir="ltr" lang="pt-BR">
      <Head />
      <Preview>{content.preview}</Preview>
      <Body
        style={{
          backgroundColor: "#ffffff",
          color: "#111827",
          fontFamily: "Arial, sans-serif",
          margin: 0,
          padding: "24px 12px",
        }}
      >
        <Container style={{ margin: "0 auto", maxWidth: "560px" }}>
          <Heading as="h1" style={{ fontSize: "22px", fontWeight: 600 }}>
            Polaris
          </Heading>
          <Heading as="h2" style={{ fontSize: "18px", fontWeight: 600 }}>
            {content.heading}
          </Heading>
          {content.paragraphs.map((paragraph) => (
            <Text
              key={paragraph}
              style={{ fontSize: "16px", lineHeight: "24px" }}
            >
              {paragraph}
            </Text>
          ))}
          <Button
            href={panelUrl}
            style={{
              backgroundColor: "#111827",
              borderRadius: "4px",
              boxSizing: "border-box",
              color: "#ffffff",
              display: "inline-block",
              padding: "12px 20px",
              textDecoration: "none",
            }}
          >
            {content.actionLabel}
          </Button>
          <Text
            style={{ color: "#374151", fontSize: "14px", lineHeight: "21px" }}
          >
            Se o botão não funcionar, abra este endereço: {panelUrl}
          </Text>
          <Text
            style={{ color: "#4b5563", fontSize: "14px", lineHeight: "21px" }}
          >
            Este é um aviso automático sobre o encerramento da loja. O Polaris
            nunca pede a sua senha por e-mail.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

/** The provider's configuration (staging and production secrets): never logged. */
export interface ClosureNoticeEmailConfig {
  apiKey: string;
  /** The origin of the app: the link of the e-mail is its panel. */
  appOrigin: string;
  from: string;
  replyTo?: string;
}

/**
 * What the provider did with one message: `sent` (taken, or already taken under the same key), `rejected` (it will not
 * take this message: an address or a message it refuses, for good) or `retry` (the provider or the network failed, or
 * the key is in use by a request still running). `status` is the HTTP status, when there was one.
 */
export type ClosureNoticeSendResult =
  | { outcome: "sent" }
  | { outcome: "rejected"; status: number }
  | { outcome: "retry"; status: number | null };

export type ClosureNoticeSender = (message: {
  html: string;
  /** The notice's ID: the provider takes one message per notice (24 hours of memory at Resend). */
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}) => Promise<ClosureNoticeSendResult>;

/** Renders the notice: the same notice always renders the same message (a retry repeats it under the same key). */
export async function renderClosureNoticeEmail(
  delivery: ClosureNoticeDelivery,
  appOrigin: string
): Promise<{ html: string; subject: string; text: string }> {
  const content = closureNoticeContent(delivery);
  const panelUrl = closureNoticePanelUrl(appOrigin);
  const element = <ClosureNoticeEmail content={content} panelUrl={panelUrl} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, subject: content.subject, text };
}

// a 409 at Resend is the same key still in flight; 401 and 403 are a key of ours that is wrong (configuration,
// not the address); 429 and 5xx are the provider. All of them are tried again later.
function retriable(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

export function createResendClosureNoticeSender(
  config: Pick<ClosureNoticeEmailConfig, "apiKey" | "from" | "replyTo">
): ClosureNoticeSender {
  return async (message) => {
    let response: Response;
    try {
      response = await fetch(RESEND_EMAILS_ENDPOINT, {
        body: JSON.stringify({
          from: config.from,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
          html: message.html,
          subject: message.subject,
          text: message.text,
          to: [message.to],
        }),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
          "User-Agent": "Polaris/1.0",
        },
        method: "POST",
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch {
      // the network or the timeout: nothing of the request (the address is in it) goes on
      return { outcome: "retry", status: null };
    }
    // the body may echo the address: it is never read
    await response.body?.cancel();
    if (response.ok) {
      return { outcome: "sent" };
    }
    if (retriable(response.status)) {
      return { outcome: "retry", status: response.status };
    }
    return { outcome: "rejected", status: response.status };
  };
}
