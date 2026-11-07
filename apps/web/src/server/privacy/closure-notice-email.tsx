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
import { closedStorePath } from "../../lib/closed-store-path";
import { emailColors } from "../email-colors.generated";

/**
 * The e-mail of a closure notice (ADR 0102 amended), one per milestone: the request, D minus 30 and
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

const FIRST_OF_MONTH = /^1 de /;

/** A calendar date (YYYY-MM-DD) as "18 de janeiro de 2027"; the first of the month is ordinal in pt-BR, "1º de fevereiro de 2027". */
export function formatCalendarDate(date: string): string {
  return dateFormatter
    .format(new Date(`${date}T12:00:00.000Z`))
    .replace(FIRST_OF_MONTH, "1º de ");
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).format(instant);
}

function calendarDaysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) /
      DAY_MS
  );
}

/** The panel of the closed store on the app's own origin: a fixed path, with no store, query or token. */
export function closureNoticePanelUrl(appOrigin: string): string {
  return new URL(closedStorePath(), new URL(appOrigin).origin).toString();
}

export interface ClosureNoticeContent {
  /** The button to the panel; null when there is nothing to open (from the deletion day on). */
  actionLabel: string | null;
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
  // a subject is one line: a name with a line break must not break the header
  const subjectStore = store.replaceAll(/\s+/g, " ").trim();
  const requested = formatCalendarDate(
    localDate(delivery.requestedAt, delivery.timeZone)
  );
  const deletionDay = formatCalendarDate(delivery.deletionDate);
  const firstDay = formatCalendarDate(closureNoticeDeletionDate(delivery));
  // The copy can be asked for until the first instant of D (`exportOpenUntil`, as `request_closed_data_export` refuses
  // from it), whatever the milestone: a notice due before D (the request, D minus 30, the `d7` of the job, or one sent
  // again or rescheduled before D) writes that limit, 00:00 of D in the organization's calendar. A notice due on D or
  // later (D, a `d7` sent again or a rescheduled purge after D) says the time is over, on the same D and the same
  // format, and invites no request: the server refuses it, so the text does too.
  const beforeDeletionDay =
    delivery.dueAt.getTime() < delivery.deletableFrom.getTime();
  const copyLimit = `${deletionDay}, ${formatTime(delivery.deletableFrom, delivery.timeZone)} (horário da sua loja)`;
  // From D on a copy can no longer be asked for, so the e-mail invites nothing: no button, and no link to the panel.
  const panelLabel = beforeDeletionDay ? "Abrir o painel" : null;
  const copyLine = beforeDeletionDay
    ? `Se quiser guardar uma cópia dos dados, peça pelo painel até ${copyLimit}.`
    : `O prazo para pedir uma cópia dos dados terminou em ${copyLimit}. Depois de apagados, os dados não podem ser recuperados.`;
  const signIn =
    "Para abrir o painel, entre no Polaris com a sua conta de dono da loja.";
  // from D on there is no panel to open, so the sentence that sends the owner to it goes with the button
  const signInParagraph = beforeDeletionDay ? [signIn] : [];
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
        subject: `Recebemos o pedido de encerramento da sua loja ${subjectStore} no Polaris`,
      };
    case "d30":
      return {
        actionLabel: "Abrir o painel",
        heading: "Faltam 30 dias para os dados da loja poderem ser apagados",
        paragraphs: [
          `Os dados da loja ${store}, encerrada em ${requested}, podem ser apagados a partir de ${deletionDay}.`,
          copyLine,
          ...signInParagraph,
        ],
        preview: `Faltam 30 dias: os dados da loja ${store} podem ser apagados a partir de ${deletionDay}.`,
        subject: `Faltam 30 dias: os dados da sua loja ${subjectStore} no Polaris podem ser apagados a partir de ${deletionDay}`,
      };
    case "d7": {
      // a d7 sent again counts from the day it is sent, so the number is the real one, not always 7
      const daysLeft = `Faltam ${calendarDaysBetween(localDate(delivery.dueAt, delivery.timeZone), closureNoticeDeletionDate(delivery))} dias`;
      return {
        actionLabel: panelLabel,
        heading: `${daysLeft} para os dados da loja poderem ser apagados`,
        paragraphs: [
          `Os dados da loja ${store}, encerrada em ${requested}, podem ser apagados a partir de ${firstDay}.${beforeDeletionDay ? " Depois de apagados, não podem ser recuperados." : ""}`,
          copyLine,
          ...signInParagraph,
        ],
        preview: `${daysLeft}: os dados da loja ${store} podem ser apagados a partir de ${firstDay}.`,
        subject: `${daysLeft}: os dados da sua loja ${subjectStore} no Polaris podem ser apagados a partir de ${firstDay}`,
      };
    }
    case "deletion_day":
      return {
        actionLabel: panelLabel,
        heading: "Os dados da loja podem ser apagados a partir de hoje",
        paragraphs: [
          `Os dados da loja ${store}, encerrada em ${requested}, podem ser apagados a qualquer momento a partir de hoje, ${deletionDay}.`,
          copyLine,
          ...signInParagraph,
        ],
        preview: `Os dados da loja ${store} podem ser apagados a partir de hoje.`,
        subject: `Os dados da sua loja ${subjectStore} no Polaris podem ser apagados a partir de hoje`,
      };
    case "rescheduled":
      return {
        actionLabel: panelLabel,
        heading: "Nova data para o apagamento dos dados",
        paragraphs: [
          `O apagamento dos dados da loja ${store}, encerrada em ${requested}, foi adiado. Agora eles podem ser apagados a partir de ${firstDay}.`,
          copyLine,
          ...signInParagraph,
        ],
        preview: `Os dados da loja ${store} podem ser apagados a partir de ${firstDay}.`,
        subject: `Nova data para o apagamento dos dados da sua loja ${subjectStore} no Polaris`,
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
          {content.actionLabel === null ? null : (
            <>
              <Button
                href={panelUrl}
                style={{
                  backgroundColor: emailColors.primary,
                  borderRadius: "4px",
                  boxSizing: "border-box",
                  color: emailColors.primaryForeground,
                  display: "inline-block",
                  padding: "12px 20px",
                  textDecoration: "none",
                }}
              >
                {content.actionLabel}
              </Button>
              <Text
                style={{
                  color: emailColors.foreground,
                  fontSize: "14px",
                  lineHeight: "21px",
                }}
              >
                Se o botão não funcionar, abra este endereço: {panelUrl}
              </Text>
            </>
          )}
          <Text
            style={{
              color: emailColors.mutedForeground,
              fontSize: "14px",
              lineHeight: "21px",
            }}
          >
            Este é um aviso automático sobre o encerramento da loja. O Polaris
            nunca pede senha, código ou pagamento por e-mail.
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
 * What the provider did with one message: `sent` (taken, or already taken under the same key), `rejected` (it refuses
 * this message for good: a field of the request it does not accept, in practice the address) or `retry` (anything else:
 * the provider or the network failed, our key or sender is wrong, a quota, or the key is in use by a request still
 * running). `status` is the HTTP status, when there was one; `code` is the provider's error name (`validation_error`,
 * `invalid_from_address`...), a short code checked before it is kept, never its message.
 */
export type ClosureNoticeSendResult =
  | { outcome: "sent" }
  | { code: string | null; outcome: "rejected"; status: number }
  | { code: string | null; outcome: "retry"; status: number | null };

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

const PROVIDER_CODE = /^[a-z][a-z0-9_]{0,63}$/;

// how Resend names the field of the recipient in the message of a `validation_error` ("Invalid `to` field...")
const RECIPIENT_FIELD = /`to`/;

/**
 * The provider's error name, and whether its message is about the recipient field: nothing else of its answer is kept
 * (the message may echo the address, so it is only tested, never returned or logged).
 */
async function providerError(
  response: Response
): Promise<{ aboutRecipient: boolean; code: string | null }> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return { aboutRecipient: false, code: null };
    }
    const name = "name" in body ? body.name : null;
    const message = "message" in body ? body.message : null;
    return {
      aboutRecipient:
        typeof message === "string" && RECIPIENT_FIELD.test(message),
      code: typeof name === "string" && PROVIDER_CODE.test(name) ? name : null,
    };
  } catch {
    return { aboutRecipient: false, code: null };
  }
}

/**
 * Only an address the provider refuses is the message's fault (400 or 422 with `validation_error` about the `to`
 * field): the notice then fails for good. Everything else is tried again, so a mistake of ours (a wrong sender or
 * reply-to, a key, a quota, a field of the body) never fails a notice that a fix would send: 401 and 403 (the key, or
 * the sender's domain), 409 (the same key in flight, or another message under it: Resend keeps a key 24 hours), a
 * `validation_error` about another field, 422 with another name (`invalid_from_address`), 429 and 5xx.
 */
function refusedForGood(
  status: number,
  error: { aboutRecipient: boolean; code: string | null }
): boolean {
  return (
    (status === 400 || status === 422) &&
    error.code === "validation_error" &&
    error.aboutRecipient
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
      return { code: null, outcome: "retry", status: null };
    }
    if (response.ok) {
      // the answer of a message taken is never read
      await response.body?.cancel();
      return { outcome: "sent" };
    }
    const error = await providerError(response);
    if (refusedForGood(response.status, error)) {
      return { code: error.code, outcome: "rejected", status: response.status };
    }
    return { code: error.code, outcome: "retry", status: response.status };
  };
}
