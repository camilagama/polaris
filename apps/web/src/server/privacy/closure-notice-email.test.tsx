import type { ClosureNoticeDelivery } from "@polaris/db/privacy-maintenance";
import { CLOSURE_RECOVERY_WINDOW_DAYS } from "@polaris/domain/organization/closure";
import {
  CLOSURE_DELETABLE_AFTER_DAYS,
  CLOSURE_NOTICE_MILESTONES,
} from "@polaris/domain/organization/closure-deadlines";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closureNoticeContent,
  closureNoticeDeletionDate,
  closureNoticePanelUrl,
  createResendClosureNoticeSender,
  formatCalendarDate,
  renderClosureNoticeEmail,
} from "./closure-notice-email";

const STORE = "Loja de Teste";

// what invites the owner to ask for a copy
const COPY_INVITATION = /peça|cópia agora|guardar uma cópia|solicit/i;

const base: ClosureNoticeDelivery = {
  deletableFrom: new Date("2027-01-18T03:00:00.000Z"),
  deletionDate: "2027-01-18",
  dueAt: new Date("2027-01-11T03:00:00.000Z"),
  milestone: "d7",
  noticeId: "0199f0aa-2b3c-7d4e-8f90-123456789abc",
  organizationId: "org_closure_notice",
  organizationName: STORE,
  purgeFrom: null,
  recoverUntil: new Date("2026-11-19T12:00:00.000Z"),
  reissue: 0,
  requestedAt: new Date("2026-10-20T12:00:00.000Z"),
  timeZone: "America/Sao_Paulo",
  userId: "user_owner",
};

function notice(
  overrides: Partial<ClosureNoticeDelivery> = {}
): ClosureNoticeDelivery {
  return { ...base, ...overrides };
}

const milestones = [
  "closure",
  "d30",
  "d7",
  "deletion_day",
  "rescheduled",
] as const;

function bodyOf(delivery: ClosureNoticeDelivery): string {
  const content = closureNoticeContent(delivery);
  return [content.heading, ...content.paragraphs].join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the content of a closure notice", () => {
  it("covers every milestone of the domain", () => {
    expect([...milestones].sort()).toEqual(
      [...CLOSURE_NOTICE_MILESTONES].sort()
    );
  });

  for (const milestone of milestones) {
    it(`has a subject, a heading and paragraphs for ${milestone}, names the store in the body only`, () => {
      const delivery = notice({
        milestone,
        purgeFrom: new Date("2027-02-03T03:00:00.000Z"),
      });
      const content = closureNoticeContent(delivery);

      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.heading.length).toBeGreaterThan(0);
      expect(content.paragraphs.length).toBeGreaterThan(0);
      expect(content.paragraphs.join(" ")).toContain(STORE);
      expect(content.subject).not.toContain(STORE);
    });

    it(`says "a partir de" wherever ${milestone} names a deletion date`, () => {
      const body = bodyOf(
        notice({ milestone, purgeFrom: new Date("2027-02-03T03:00:00.000Z") })
      );
      expect(body).toContain("a partir de");
    });
  }

  it("uses the days of the domain in the closure notice", () => {
    const body = bodyOf(notice({ milestone: "closure" }));
    expect(CLOSURE_DELETABLE_AFTER_DAYS).toBe(90);
    expect(CLOSURE_RECOVERY_WINDOW_DAYS).toBe(30);
    expect(body).toContain(`${CLOSURE_DELETABLE_AFTER_DAYS} dias`);
    expect(body).toContain(`${CLOSURE_RECOVERY_WINDOW_DAYS} dias`);
  });

  it("writes the dates in the organization's time zone, not in UTC", () => {
    const requestedAt = new Date("2026-10-21T02:30:00.000Z");
    const manaus = bodyOf(
      notice({ milestone: "closure", requestedAt, timeZone: "America/Manaus" })
    );
    expect(manaus).toContain("em 20 de outubro de 2026");
    expect(manaus).not.toContain("em 21 de outubro de 2026");

    // 16:00 UTC on the 20th is already the 21st in Tokyo
    const tokyo = bodyOf(
      notice({
        milestone: "closure",
        requestedAt: new Date("2026-10-20T16:00:00.000Z"),
        timeZone: "Asia/Tokyo",
      })
    );
    expect(tokyo).toContain("em 21 de outubro de 2026");
  });

  it("formats a calendar date in Portuguese", () => {
    expect(formatCalendarDate("2027-01-18")).toBe("18 de janeiro de 2027");
  });

  it("offers the copy until 00:00 of D, the limit the server applies, in the notices before D", () => {
    for (const [milestone, dueAt] of [
      ["closure", new Date("2026-10-20T12:00:00.000Z")],
      ["d30", new Date("2026-12-19T03:00:00.000Z")],
      ["d7", new Date("2027-01-11T03:00:00.000Z")],
    ] as const) {
      const body = bodyOf(notice({ dueAt, milestone }));
      expect(body).toContain(
        "Se quiser guardar uma cópia dos dados, peça pelo painel até 18 de janeiro de 2027, 00:00 (horário da sua organização)."
      );
      expect(body).not.toContain("terminou");
    }
  });

  it("offers the copy until D in a d7 sent again or a purge rescheduled before D: the server still takes the request", () => {
    for (const delivery of [
      notice({
        dueAt: new Date("2027-01-12T15:00:00.000Z"),
        milestone: "d7",
        reissue: 1,
      }),
      notice({
        dueAt: new Date("2027-01-17T14:59:59.000Z"),
        milestone: "rescheduled",
        purgeFrom: new Date("2027-02-01T12:00:00.000Z"),
      }),
    ]) {
      const body = bodyOf(delivery);
      expect(body).toContain(
        "Se quiser guardar uma cópia dos dados, peça pelo painel até 18 de janeiro de 2027, 00:00 (horário da sua organização)."
      );
      expect(body).not.toContain("terminou");
    }
  });

  it("writes the limit of the copy as the first instant of D in the organization's time zone", () => {
    const body = bodyOf(
      notice({
        deletableFrom: new Date("2027-01-18T04:00:00.000Z"),
        milestone: "d30",
        timeZone: "America/Manaus",
      })
    );
    expect(body).toContain("até 18 de janeiro de 2027, 00:00");
  });

  it("says the time for the copy is over, with D and its hour, in D, a d7 sent again and a rescheduled purge", () => {
    const over = [
      notice({
        dueAt: new Date("2027-01-18T03:00:00.000Z"),
        milestone: "deletion_day",
      }),
      notice({
        dueAt: new Date("2027-01-25T12:00:00.000Z"),
        milestone: "deletion_day",
      }),
      notice({
        dueAt: new Date("2027-01-20T15:00:00.000Z"),
        milestone: "d7",
        reissue: 1,
      }),
      notice({
        dueAt: new Date("2027-01-25T12:00:00.000Z"),
        milestone: "rescheduled",
        purgeFrom: new Date("2027-02-01T12:00:00.000Z"),
      }),
      // a late d7 of the job, due on D or later, does not promise a limit already gone
      notice({ dueAt: new Date("2027-01-18T05:00:00.000Z"), milestone: "d7" }),
    ];
    for (const delivery of over) {
      const body = bodyOf(delivery);
      expect(body).toContain(
        "O prazo para pedir uma cópia dos dados terminou em 18 de janeiro de 2027, 00:00 (horário da sua organização). Depois de apagados, os dados não podem ser recuperados."
      );
      expect(body).not.toContain("peça pelo painel até");
      expect(body.split("Depois de apagados").length).toBe(2);
    }
  });

  it("writes the original D in the time-over text, not the new date of a purge sent again or rescheduled", () => {
    const rescheduled = bodyOf(
      notice({
        dueAt: new Date("2027-02-10T12:00:00.000Z"),
        milestone: "rescheduled",
        purgeFrom: new Date("2027-02-17T12:00:00.000Z"),
      })
    );
    expect(rescheduled).toContain(
      "podem ser apagados a partir de 17 de fevereiro de 2027"
    );
    expect(rescheduled).toContain("terminou em 18 de janeiro de 2027, 00:00");
    const sentAgain = bodyOf(
      notice({
        dueAt: new Date("2027-01-20T15:00:00.000Z"),
        milestone: "d7",
        reissue: 1,
      })
    );
    expect(sentAgain).toContain(
      "podem ser apagados a partir de 27 de janeiro de 2027"
    );
    expect(sentAgain).toContain("terminou em 18 de janeiro de 2027, 00:00");
  });

  it("writes the hour of the end of the time in the organization's time zone", () => {
    const body = bodyOf(
      notice({
        deletableFrom: new Date("2027-01-18T04:00:00.000Z"),
        dueAt: new Date("2027-01-18T12:00:00.000Z"),
        milestone: "deletion_day",
        timeZone: "America/Manaus",
      })
    );
    expect(body).toContain("terminou em 18 de janeiro de 2027, 00:00");
  });

  it("invites no request for a copy in any notice due at D or later, and offers it in every one due before", () => {
    const deletableFrom = base.deletableFrom.getTime();
    const instants = [
      0,
      1000,
      60_000,
      3_600_000,
      86_400_000,
      7 * 86_400_000,
      40 * 86_400_000,
    ].map((offset) => new Date(deletableFrom + offset));
    for (const milestone of milestones) {
      for (const dueAt of instants) {
        for (const reissue of [0, 1]) {
          const body = bodyOf(
            notice({
              dueAt,
              milestone,
              purgeFrom: new Date(dueAt.getTime() + 7 * 86_400_000),
              reissue,
            })
          );
          expect(body).not.toMatch(COPY_INVITATION);
          expect(body).toContain(
            "O prazo para pedir uma cópia dos dados terminou em 18 de janeiro de 2027, 00:00"
          );
        }
      }
    }
    for (const milestone of milestones) {
      for (const reissue of [0, 1]) {
        const body = bodyOf(
          notice({
            dueAt: new Date(deletableFrom - 1000),
            milestone,
            purgeFrom: new Date(deletableFrom + 7 * 86_400_000),
            reissue,
          })
        );
        expect(body).toContain(
          "peça pelo painel até 18 de janeiro de 2027, 00:00"
        );
        expect(body).not.toContain("terminou");
      }
    }
  });

  it("says in the headings of D minus 30 and minus 7 days what is coming", () => {
    expect(closureNoticeContent(notice({ milestone: "d30" })).heading).toBe(
      "Faltam 30 dias para os dados da loja poderem ser apagados"
    );
    expect(closureNoticeContent(notice({ milestone: "d7" })).heading).toBe(
      "Faltam 7 dias para os dados da loja poderem ser apagados"
    );
  });
});

describe("the first day of deletion of a notice", () => {
  it("is D for a d7 sent on time", () => {
    expect(closureNoticeDeletionDate(notice({ milestone: "d7" }))).toBe(
      "2027-01-18"
    );
  });

  it("is 7 days after the local date it was sent again for a d7 reissued after D", () => {
    expect(
      closureNoticeDeletionDate(
        notice({
          dueAt: new Date("2027-01-20T15:00:00.000Z"),
          milestone: "d7",
          reissue: 1,
        })
      )
    ).toBe("2027-01-27");
  });

  it("is the local date of the release of the hold for a rescheduled purge", () => {
    expect(
      closureNoticeDeletionDate(
        notice({
          milestone: "rescheduled",
          purgeFrom: new Date("2027-02-03T01:00:00.000Z"),
        })
      )
    ).toBe("2027-02-02");
  });

  it("is D for the other milestones", () => {
    for (const milestone of ["closure", "d30", "deletion_day"] as const) {
      expect(closureNoticeDeletionDate(notice({ milestone }))).toBe(
        "2027-01-18"
      );
    }
  });
});

describe("the panel link", () => {
  it("is the origin only, with no path, query or token", () => {
    expect(
      closureNoticePanelUrl("https://app.example.invalid/some/path?token=x")
    ).toBe("https://app.example.invalid/");
  });
});

describe("the rendered e-mail", () => {
  it("has the panel URL in the HTML and in the plain text", async () => {
    const message = await renderClosureNoticeEmail(
      notice(),
      "https://app.example.invalid/some/path?token=x"
    );
    expect(message.html).toContain("https://app.example.invalid/");
    expect(message.text).toContain("https://app.example.invalid/");
    expect(message.html).not.toContain("token=x");
    expect(message.text).not.toContain("token=x");
    expect(message.subject).not.toContain(STORE);
  });

  it("escapes the store's name in the HTML", async () => {
    const message = await renderClosureNoticeEmail(
      notice({ organizationName: "Loja <b>&" }),
      "https://app.example.invalid"
    );
    expect(message.html).not.toContain("<b>");
    expect(message.html).toContain("Loja &lt;b&gt;&amp;");
    expect(message.text).toContain("Loja <b>&");
  });

  it("renders the same message twice for the same notice", async () => {
    const first = await renderClosureNoticeEmail(
      notice(),
      "https://app.example.invalid"
    );
    const second = await renderClosureNoticeEmail(
      notice(),
      "https://app.example.invalid"
    );
    expect(second).toEqual(first);
  });
});

describe("the sender of the provider", () => {
  const message = {
    html: "<p>oi</p>",
    idempotencyKey: "0199f0aa-2b3c-7d4e-8f90-123456789abc",
    subject: "assunto",
    text: "oi",
    to: "dono@example.invalid",
  };
  const sender = createResendClosureNoticeSender({
    apiKey: "re_test_key_not_real",
    from: "Polaris <avisos@example.invalid>",
  });

  function stubFetch(status: number, body = "echo dono@example.invalid") {
    const response = new Response(body, { status });
    const cancel = vi.spyOn(response.body as ReadableStream, "cancel");
    const text = vi.spyOn(response, "text");
    const json = vi.spyOn(response, "json");
    const fetchMock = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal("fetch", fetchMock);
    return { cancel, fetchMock, json, text };
  }

  const providerError = (
    name: string,
    detail = "Invalid `to` field: dono@example.invalid"
  ) => JSON.stringify({ message: detail, name, statusCode: 422 });

  it("posts to the provider with the idempotency key and the bearer key, and never reads the body", async () => {
    const { cancel, fetchMock, json, text } = stubFetch(200);

    const result = await sender(message);

    expect(result).toEqual({ outcome: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(message.idempotencyKey);
    expect(headers.Authorization).toBe("Bearer re_test_key_not_real");
    expect(JSON.parse(init.body as string).to).toEqual([message.to]);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  for (const status of [400, 422]) {
    it(`fails for good on ${status} with validation_error, keeping only the error's name`, async () => {
      stubFetch(status, providerError("validation_error"));
      const result = await sender(message);
      expect(result).toEqual({
        code: "validation_error",
        outcome: "rejected",
        status,
      });
      // nothing of the provider's message (which echoes the address) is kept
      expect(JSON.stringify(result)).not.toContain("dono@example.invalid");
    });
  }

  it("asks for a retry on a validation_error about another field (the reply-to is ours to fix)", async () => {
    stubFetch(
      422,
      providerError("validation_error", "Invalid `reply_to` field.")
    );
    expect(await sender(message)).toEqual({
      code: "validation_error",
      outcome: "retry",
      status: 422,
    });
  });

  it("asks for a retry on a 422 that is a mistake of ours (the sender), not the message's", async () => {
    stubFetch(422, providerError("invalid_from_address"));
    expect(await sender(message)).toEqual({
      code: "invalid_from_address",
      outcome: "retry",
      status: 422,
    });
  });

  it("keeps no error name that is not a short code", async () => {
    stubFetch(422, providerError("Invalid to: dono@example.invalid"));
    expect(await sender(message)).toEqual({
      code: null,
      outcome: "retry",
      status: 422,
    });
  });

  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    it(`asks for a retry on ${status} with a body that is not the provider's error`, async () => {
      stubFetch(status);
      expect(await sender(message)).toEqual({
        code: null,
        outcome: "retry",
        status,
      });
    });
  }

  it("asks for a retry, with no status, when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("boom dono@example.invalid")))
    );
    expect(await sender(message)).toEqual({
      code: null,
      outcome: "retry",
      status: null,
    });
  });
});
