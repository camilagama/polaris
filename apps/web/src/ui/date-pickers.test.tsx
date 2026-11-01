import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "@/ui/calendar";
import {
  CalendarFailure,
  calendarChunkPath,
  OnDemandCalendar,
  whenBackOnline,
} from "@/ui/calendar-on-demand";
import { DatePicker } from "@/ui/date-picker";
import { DateRangePicker } from "@/ui/date-range-picker";
import { parseIsoDate } from "@/ui/date-values";

/**
 * The markup of the date pickers: the accessible names and the error of the buttons, and the month grid of
 * the calendar (Portuguese caption and arrows, the chosen day, the disabled days with their reason, the sizes and
 * the focus in the classes). The browser checks (e2e-pwa/ui-date-pickers.e2e.ts) click, type and measure them in
 * the gallery.
 */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const noop = () => undefined;

const OCTOBER_24 = parseIsoDate("2026-10-24") as Date;

const BUTTON = /<button[^>]*data-slot="popover-trigger"[^>]*>/;
const TODAY_LABEL = /^Hoje, sábado, 24 de outubro de 2026/;
const DISABLED_ATTRIBUTE = /\sdisabled=""/;
const dayButton = (markup: string, iso: string) =>
  new RegExp(`<button[^>]*data-day="${iso}"[^>]*>`).exec(markup)?.[0] ?? "";
const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

describe("DatePicker", () => {
  it("vazio: o botão diz o rótulo e Escolher data", () => {
    const markup = html(
      <DatePicker
        label="Data de competência"
        onValueChange={noop}
        today="2026-10-24"
        value={null}
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-label")).toBe(
      "Data de competência, Escolher data"
    );
    expect(markup).toContain("Escolher data");
    expect(attribute(button, "aria-invalid")).toBeUndefined();
  });

  it("com data: 24/10/2026 no texto e no nome", () => {
    const markup = html(
      <DatePicker
        label="Data de competência"
        onValueChange={noop}
        value="2026-10-24"
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-label")).toBe(
      "Data de competência, 24/10/2026"
    );
    expect(markup).toContain(">24/10/2026<");
  });

  it("erro: Escolha uma data, ligado ao botão", () => {
    const markup = html(
      <DatePicker error label="Vencimento" onValueChange={noop} value={null} />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-invalid")).toBe("true");
    const describedBy = attribute(button, "aria-describedby");
    expect(describedBy).toBeTruthy();
    const error = new RegExp(`<div[^>]*\\sid="${describedBy}"[^>]*>`).exec(
      markup
    )?.[0];
    expect(error && attribute(error, "role")).toBe("alert");
    expect(markup).toContain("Escolha uma data");
  });
});

describe("DatePicker, o erro e a ajuda da tela", () => {
  it("o erro vem antes da ajuda no aria-describedby; sem erro, só a ajuda", () => {
    const withError = BUTTON.exec(
      html(
        <DatePicker
          describedBy="ajuda-data"
          error
          label="Vencimento"
          onValueChange={noop}
          value={null}
        />
      )
    )?.[0];
    const [errorId, help] = (
      attribute(withError ?? "", "aria-describedby") ?? ""
    ).split(" ");
    expect(errorId).toBeTruthy();
    expect(help).toBe("ajuda-data");
    const withoutError = BUTTON.exec(
      html(
        <DatePicker
          describedBy="ajuda-data"
          label="Vencimento"
          onValueChange={noop}
          value={null}
        />
      )
    )?.[0];
    expect(attribute(withoutError ?? "", "aria-describedby")).toBe(
      "ajuda-data"
    );
    expect(attribute(withoutError ?? "", "aria-invalid")).toBeUndefined();
  });
});

describe("DateRangePicker", () => {
  it("vazio: Escolher período", () => {
    const markup = html(
      <DateRangePicker
        label="Período"
        onValueChange={noop}
        today="2026-10-24"
        value={null}
      />
    );
    expect(attribute(BUTTON.exec(markup)?.[0] ?? "", "aria-label")).toBe(
      "Período, Escolher período"
    );
  });

  it("erro: ligado ao botão pelo aria-invalid e pelo aria-describedby, antes da ajuda da tela", () => {
    const markup = html(
      <DateRangePicker
        describedBy="ajuda-periodo"
        error="Escolha o período"
        label="Período"
        onValueChange={noop}
        value={null}
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-invalid")).toBe("true");
    const [errorId, help] = (attribute(button, "aria-describedby") ?? "").split(
      " "
    );
    expect(help).toBe("ajuda-periodo");
    const error = new RegExp(`<div[^>]*\\sid="${errorId}"[^>]*>`).exec(
      markup
    )?.[0];
    expect(error && attribute(error, "role")).toBe("alert");
    expect(markup).toContain("Escolha o período");
  });

  it("sem erro: nem aria-invalid nem aria-describedby no botão", () => {
    const button =
      BUTTON.exec(
        html(
          <DateRangePicker label="Período" onValueChange={noop} value={null} />
        )
      )?.[0] ?? "";
    expect(attribute(button, "aria-invalid")).toBeUndefined();
    expect(attribute(button, "aria-describedby")).toBeUndefined();
  });

  it("um campo só: 01/10 a 24/10, e um dia só com o ano", () => {
    const range = html(
      <DateRangePicker
        label="Período"
        onValueChange={noop}
        today="2026-10-24"
        value={{ from: "2026-10-01", to: "2026-10-24" }}
      />
    );
    expect(attribute(BUTTON.exec(range)?.[0] ?? "", "aria-label")).toBe(
      "Período, 01/10 a 24/10"
    );
    const oneDay = html(
      <DateRangePicker
        label="Período"
        onValueChange={noop}
        today="2026-10-24"
        value={{ from: "2026-10-24", to: "2026-10-24" }}
      />
    );
    expect(oneDay).toContain(">24/10/2026<");
  });
});

describe("Calendar", () => {
  const markup = html(
    <Calendar
      defaultMonth={OCTOBER_24}
      disabled={{ after: OCTOBER_24 }}
      disabledReason="Só até hoje"
      mode="single"
      selected={parseIsoDate("2026-10-20")}
      today={OCTOBER_24}
    />
  );

  it("em português: o mês, as setas e o dia com o nome inteiro", () => {
    expect(markup).toContain("Outubro de 2026");
    expect(markup).toContain('aria-label="Mês anterior"');
    expect(markup).toContain('aria-label="Próximo mês"');
    expect(attribute(dayButton(markup, "2026-10-24"), "aria-label")).toMatch(
      TODAY_LABEL
    );
  });

  it("o dia escolhido é marcado", () => {
    expect(dayButton(markup, "2026-10-20")).toContain(
      'data-selected-single="true"'
    );
  });

  it("dia fora do permitido: aria-disabled com o motivo, nunca disabled", () => {
    const off = dayButton(markup, "2026-10-25");
    expect(attribute(off, "aria-disabled")).toBe("true");
    expect(off).not.toMatch(DISABLED_ATTRIBUTE);
    const reasonId = attribute(off, "aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(markup).toContain(
      `<span class="sr-only" id="${reasonId}">Só até hoje</span>`
    );
    const allowed = dayButton(markup, "2026-10-23");
    expect(attribute(allowed, "aria-disabled")).toBeUndefined();
    expect(attribute(allowed, "aria-describedby")).toBeUndefined();
  });

  it("36 px no mouse, 44 no toque e o foco de 3 px nas classes", () => {
    expect(markup).toContain("[--cell-size:2.25rem]");
    expect(markup).toContain("touch:[--cell-size:min(2.75rem,");
    expect(dayButton(markup, "2026-10-23")).toContain("size-(--cell-size)");
    expect(dayButton(markup, "2026-10-23")).toContain("focus-ring");
    expect(markup).toContain('data-slot="calendar"');
  });
});

describe("Calendar, o papel do dia no período", () => {
  const label = (
    selected: { from: Date | undefined; to?: Date },
    iso: string,
    mode: "range" | "single" = "range"
  ) => {
    const markup = html(
      mode === "range" ? (
        <Calendar
          defaultMonth={OCTOBER_24}
          mode="range"
          selected={selected}
          today={OCTOBER_24}
        />
      ) : (
        <Calendar
          defaultMonth={OCTOBER_24}
          mode="single"
          selected={selected.from}
          today={OCTOBER_24}
        />
      )
    );
    return attribute(dayButton(markup, iso), "aria-label");
  };
  const first = parseIsoDate("2026-10-01") as Date;
  const tenth = parseIsoDate("2026-10-10") as Date;

  it("as pontas dizem o papel antes de selecionado e o meio não diz nada", () => {
    const range = { from: first, to: OCTOBER_24 };
    expect(label(range, "2026-10-01")).toBe(
      "quinta-feira, 1 de outubro de 2026, início do período, selecionado"
    );
    expect(label(range, "2026-10-24")).toBe(
      "Hoje, sábado, 24 de outubro de 2026, fim do período, selecionado"
    );
    expect(label(range, "2026-10-10")).toBe(
      "sábado, 10 de outubro de 2026, selecionado"
    );
    expect(label(range, "2026-10-25")).toBe("domingo, 25 de outubro de 2026");
  });

  it("início igual ao fim: início e fim do período", () => {
    expect(label({ from: tenth, to: tenth }, "2026-10-10")).toBe(
      "sábado, 10 de outubro de 2026, início e fim do período, selecionado"
    );
    expect(label({ from: OCTOBER_24, to: OCTOBER_24 }, "2026-10-24")).toBe(
      "Hoje, sábado, 24 de outubro de 2026, início e fim do período, selecionado"
    );
  });

  it("só o início marcado: início do período, nunca fim", () => {
    expect(label({ from: tenth }, "2026-10-10")).toBe(
      "sábado, 10 de outubro de 2026, início do período, selecionado"
    );
  });

  it("o seletor de um dia não diz papel", () => {
    expect(label({ from: tenth }, "2026-10-10", "single")).toBe(
      "sábado, 10 de outubro de 2026, selecionado"
    );
  });
});

describe("OnDemandCalendar, a espera do chunk", () => {
  // the first render of a page that has not downloaded the chunk (and the server render) is the waiting box
  const markup = html(<OnDemandCalendar mode="single" />);

  it("a caixa de espera é um status que diz Abrindo o calendário… só para o leitor de tela", () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      '<span class="sr-only">Abrindo o calendário…</span>'
    );
    expect(markup).toContain("data-calendar-loading");
    expect(markup).not.toContain('role="alert"');
  });

  it("e tem o tamanho de um mês, o mesmo que o calendário ocupa", () => {
    expect(markup).toContain("h-[calc(var(--cell-size)*7+3.1875rem)]");
    expect(markup).toContain("w-[calc(var(--cell-size)*7)]");
  });
});

describe("calendarChunkPath, o chunk que falhou", () => {
  const origin = "https://app.polaris.example";
  const path = "/assets/calendar-Ab12_x-9.js";
  const url = `${origin}${path}`;

  it("lê o caminho na mensagem do Chrome e do Firefox, sem a query de uma tentativa anterior", () => {
    expect(
      calendarChunkPath(
        new TypeError(`Failed to fetch dynamically imported module: ${url}`),
        origin
      )
    ).toBe(path);
    expect(
      calendarChunkPath(
        new TypeError(
          `error loading dynamically imported module: ${url}?retry=1`
        ),
        origin
      )
    ).toBe(path);
  });

  it("nada na mensagem do Safari, no chunk de outra coisa, em outra origem e no que não é erro", () => {
    expect(
      calendarChunkPath(
        new TypeError("Importing a module script failed."),
        origin
      )
    ).toBeNull();
    expect(
      calendarChunkPath(
        new TypeError(
          `Failed to fetch dynamically imported module: ${origin}/assets/charts-Dk3jf9.js`
        ),
        origin
      )
    ).toBeNull();
    expect(
      calendarChunkPath(
        new TypeError(
          `Failed to fetch dynamically imported module: https://evil.example${path}`
        ),
        origin
      )
    ).toBeNull();
    expect(calendarChunkPath(url, origin)).toBeNull();
    expect(calendarChunkPath(undefined, origin)).toBeNull();
  });
});

describe("OnDemandCalendar, a falha onde o navegador não diz o chunk (Safari: só uma nova carga de página)", () => {
  const failure = (
    props: { inPlace?: boolean; offline?: boolean; unsent?: boolean } = {}
  ) =>
    html(
      <CalendarFailure
        inPlace={props.inPlace ?? false}
        offline={props.offline ?? false}
        onReload={noop}
        onRetry={noop}
        unsent={props.unsent ?? false}
      />
    );

  it("com rede e sem trabalho a perder: diz que não abriu e o botão se chama Recarregar a página", () => {
    const markup = failure();
    expect(markup).toContain("O calendário não abriu.");
    expect(markup).toContain("Recarregar a página");
    expect(markup).not.toContain("Tentar novamente");
    expect(markup).not.toContain("apaga");
  });

  it("com rede e trabalho a perder: avisa antes do botão que recarregar apaga o que foi preenchido", () => {
    const markup = failure({ unsent: true });
    expect(markup).toContain(
      "O calendário não abriu. Recarregar a página apaga o que você preencheu nesta tela."
    );
    expect(markup.indexOf("apaga")).toBeLessThan(markup.indexOf("<button"));
    expect(markup).toContain("Recarregar a página</button>");
  });

  it("sem rede: manda conectar e recarregar, não promete abrir sozinho e não tem botão", () => {
    for (const unsent of [false, true]) {
      const markup = failure({ offline: true, unsent });
      expect(markup).toContain(
        "Sem internet. Conecte-se e recarregue a página para abrir o calendário."
      );
      expect(markup).not.toContain("conexão voltar");
      expect(markup).not.toContain("<button");
    }
  });

  it("o caminho com o chunk conhecido não muda: Tentar novamente, e sem rede abre sozinho", () => {
    expect(failure({ inPlace: true, unsent: true })).toContain(
      "O calendário não abriu.</p><button"
    );
    expect(failure({ inPlace: true, unsent: true })).toContain(
      "Tentar novamente"
    );
    const offline = failure({ inPlace: true, offline: true });
    expect(offline).toContain(
      "Sem internet. O calendário abre quando a conexão voltar."
    );
    expect(offline).not.toContain("<button");
  });
});

describe("whenBackOnline, a volta da conexão no caminho sem o chunk conhecido", () => {
  const fakeWindow = new EventTarget();
  const reload = vi.fn();
  afterEach(() => {
    vi.unstubAllGlobals();
    reload.mockReset();
  });

  const stubDevice = (onLine: boolean) => {
    vi.stubGlobal(
      "window",
      Object.assign(fakeWindow, { location: { reload } })
    );
    vi.stubGlobal("navigator", { onLine });
  };

  it("sem rede: espera o evento online, troca o texto pelo do botão e nunca recarrega sozinho", () => {
    stubDevice(false);
    let offline = true;
    const stop = whenBackOnline(() => {
      offline = false;
    });
    const show = () => failureMarkup({ offline });
    expect(show()).not.toContain("<button");
    expect(offline).toBe(true);
    fakeWindow.dispatchEvent(new Event("online"));
    expect(offline).toBe(false);
    expect(show()).toContain("Recarregar a página</button>");
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it("com trabalho a perder, o estado com rede traz o aviso junto do botão", () => {
    expect(failureMarkup({ offline: false, unsent: true })).toContain(
      "Recarregar a página apaga o que você preencheu nesta tela."
    );
  });

  it("para de escutar ao desmontar", () => {
    stubDevice(false);
    const back = vi.fn();
    const stop = whenBackOnline(back);
    stop();
    fakeWindow.dispatchEvent(new Event("online"));
    expect(back).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("se a conexão já voltou, avisa na hora (nenhum evento viria) e não escuta", () => {
    stubDevice(true);
    const back = vi.fn();
    whenBackOnline(back);
    expect(back).toHaveBeenCalledTimes(1);
    fakeWindow.dispatchEvent(new Event("online"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});

function failureMarkup(props: { offline: boolean; unsent?: boolean }) {
  return html(
    <CalendarFailure
      inPlace={false}
      offline={props.offline}
      onReload={noop}
      onRetry={noop}
      unsent={props.unsent ?? false}
    />
  );
}
