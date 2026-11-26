/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import {
  axeFaults,
  focusFaults,
  KNOWN_REPEATED_NAMES,
  overflowFaults,
  repeatedNameFaults,
  touchFaults,
} from "./measures";
import { configureMatrix, openScreen } from "./matrix";
import { SCREENS } from "../ui-screens";

configureMatrix();

test.describe("controle: cada verificação pega a falha", () => {
  test.use({
    colorScheme: "light",
    hasTouch: true,
    isMobile: true,
    viewport: { height: 740, width: 360 },
  });
  const gallery = SCREENS.find((screen) => screen.name === "galeria");
  if (!gallery) {
    throw new Error(
      "ui-screens.ts must list the gallery: the control cases run on it"
    );
  }

  test("1. um elemento largo, um link de 100% com padding, uma palavra longa e um elemento além da tela são pegos", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    expect(await overflowFaults(page)).toEqual([]);
    await page.evaluate(() => {
      // each fault in a box of its own, so one does not widen the box of the next
      const box = (name: string) => {
        const element = document.createElement("section");
        element.setAttribute("aria-label", name);
        element.style.width = "200px";
        document.querySelector("main")?.append(element);
        return element;
      };
      const wide = document.createElement("div");
      wide.textContent = "Elemento largo demais";
      wide.style.width = "300px";
      box("elemento").append(wide);
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = "Link de largura cheia";
      link.style.display = "block";
      link.style.boxSizing = "content-box";
      link.style.width = "100%";
      link.style.padding = "0 24px";
      box("link").append(link);
      const word = document.createElement("p");
      word.textContent = "Supercalifragilisticexpialidocious";
      box("palavra").append(word);
    });
    const inBox = (await overflowFaults(page)).join("\n");
    expect(inBox).toContain('div "Elemento largo demais" sai de section');
    expect(inBox).toContain('a "Link de largura cheia" sai de section');
    expect(inBox).toContain('o texto de p "Supercalifragilisticexpialidoc"');

    await page.evaluate(() => {
      const beyond = document.createElement("div");
      beyond.textContent = "Mais larga que a tela";
      beyond.style.width = "900px";
      document.querySelector("main")?.append(beyond);
    });
    const beyondScreen = (await overflowFaults(page)).join("\n");
    expect(beyondScreen).toContain('div "Mais larga que a tela" sai da tela');
    expect(beyondScreen).toContain("a página rola de lado");
  });

  test("2. um botão pequeno e dois botões com áreas que se encontram", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    const check = { exemptInlineLinks: true, minimum: 44 };
    expect(await touchFaults(page, check)).toEqual([]);
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const small = document.createElement("button");
      small.textContent = "Pequeno";
      small.style.height = "20px";
      const first = document.createElement("button");
      first.textContent = "Vizinho um";
      const second = document.createElement("button");
      second.textContent = "Vizinho dois";
      for (const button of [first, second]) {
        button.style.display = "block";
        button.style.height = "60px";
        button.style.width = "120px";
      }
      second.style.marginTop = "-20px";
      // a link in a line of text is exempt from the size; links in a row, with only blanks between them, are not
      const line = document.createElement("p");
      line.append("Leia os ");
      const inLine = document.createElement("a");
      inLine.href = "#";
      inLine.textContent = "termos de uso";
      line.append(inLine, " antes de seguir.");
      const row = document.createElement("nav");
      for (const name of ["Entrar", "Ajuda"]) {
        const link = document.createElement("a");
        link.href = "#";
        link.textContent = name;
        row.append(link, " ");
      }
      // the field has the area of the group; a button at its end has only its own: one of 20 px without
      // `touch-hit` fails, and one with it passes
      const field = document.createElement("div");
      field.dataset.slot = "input-group";
      field.style.display = "flex";
      field.style.height = "48px";
      field.style.marginTop = "40px";
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Campo do controle");
      const end = document.createElement("button");
      end.textContent = "Dentro do campo";
      end.style.height = "20px";
      const kept = document.createElement("button");
      kept.textContent = "Com área própria";
      kept.className = "touch-hit";
      kept.style.height = "20px";
      kept.style.position = "relative";
      field.append(input, end, kept);
      // the controls of a group: from 24 px with no area of their own, but 8 px apart; closer than that, or smaller, fail
      const group = (name: string, gap: number, size: number) => {
        const box = document.createElement("div");
        box.dataset.targetGroup = "";
        box.style.display = "flex";
        box.style.gap = `${gap}px`;
        box.style.marginTop = "40px";
        for (const part of ["um", "dois"]) {
          const button = document.createElement("button");
          button.textContent = `${name} ${part}`;
          button.style.height = `${size}px`;
          button.style.width = `${size}px`;
          box.append(button);
        }
        return box;
      };
      main?.append(
        small,
        first,
        second,
        line,
        row,
        field,
        group("Afastado", 8, 24),
        group("Junto", 2, 24),
        group("Miúdo", 8, 20)
      );
    });
    const faults = (await touchFaults(page, check)).join("\n");
    expect(faults).toContain('button "Dentro do campo" tem área de toque');
    expect(faults).not.toContain('input "Campo do controle"');
    expect(faults).not.toContain('button "Com área própria"');
    expect(faults).toContain('button "Pequeno" tem área de toque');
    expect(faults).not.toContain('a "termos de uso" tem área de toque');
    expect(faults).toContain('a "Entrar" tem área de toque');
    expect(faults).toContain('a "Ajuda" tem área de toque');
    expect(faults).toContain(
      'a área de toque de button "Vizinho um" se sobrepõe à de button "Vizinho dois"'
    );
    expect(faults).not.toContain("Afastado");
    expect(faults).toContain(
      'a área de toque de button "Junto um" se sobrepõe à de button "Junto dois"'
    );
    expect(faults).toContain(
      'button "Miúdo um" tem área de toque de 20 × 20 px (mínimo 24)'
    );
  });

  test("3. o axe acusa texto sem contraste", async ({ page }) => {
    await openScreen(gallery, page);
    expect(await axeFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const text = document.createElement("p");
      text.textContent = "Texto quase invisível";
      text.style.color = "rgb(200, 200, 200)";
      text.style.backgroundColor = "rgb(210, 210, 210)";
      document.querySelector("main")?.append(text);
    });
    expect(
      (await axeFaults(page)).map((fault) => fault.split(":")[0])
    ).toContain("color-contrast");
  });

  test("6. botão sem contorno de foco, ou só com sombra suave, é pego; o halo de 3 px passa", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.dataset.focusProbe = "";
      const bare = document.createElement("button");
      bare.textContent = "Sem foco visível";
      bare.style.outline = "none";
      const soft = document.createElement("button");
      soft.textContent = "Só sombra suave";
      soft.style.outline = "none";
      soft.style.boxShadow = "0 1px 3px 0 rgb(0 0 0 / 0.1)";
      const ring = document.createElement("button");
      ring.textContent = "Com halo de 3 px";
      ring.style.outline = "none";
      ring.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      probe.append(bare, soft, ring);
      document.querySelector("main")?.append(probe);
    });
    // the clean walk of the whole gallery is the gallery's own check (`screen-checks.ts`): here only the three buttons
    expect((await focusFaults(page, "[data-focus-probe]")).sort()).toEqual(
      [
        'button "Só sombra suave" não mostra o contorno de foco de 3 px',
        'button "Sem foco visível" não mostra o contorno de foco de 3 px',
      ].sort()
    );
  });

  test("6. um campo de várias partes (data e hora) não encerra a volta de Tab antes dos controles que vêm depois", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.type = "datetime-local";
      field.setAttribute("aria-label", "Data e hora do controle");
      field.style.outline = "none";
      field.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      const after = document.createElement("button");
      after.textContent = "Depois do campo";
      after.style.outline = "none";
      after.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      const probe = document.createElement("div");
      probe.dataset.focusProbe = "";
      probe.append(field, after);
      document.querySelector("main")?.append(probe);
    });
    // each part of the field is a stop of Tab on the same element: the button after it is still reached
    expect(await focusFaults(page, "[data-focus-probe]")).toEqual([]);
  });

  test("6. a volta de Tab começa no alto da página, mesmo depois de um clique no meio dela", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const first = document.createElement("button");
      first.textContent = "Primeiro da página";
      first.style.boxShadow = "0 0 0 3px rgb(0 100 200)";
      main?.prepend(first);
    });
    // a click in the middle of the page moves the starting point of Tab there
    await page.getByRole("button", { name: "Limpar" }).first().click();
    expect(await focusFaults(page)).toEqual([]);
  });

  test("6. com um diálogo aberto a volta de Tab gira dentro dele, sem contar as sentinelas do Base UI; o que perde o contorno é pego", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.getByRole("dialog").waitFor();
    expect(await focusFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const bare = document.createElement("button");
      bare.textContent = "Sem foco visível";
      bare.style.outline = "none";
      document.querySelector("[role=dialog]")?.append(bare);
    });
    expect(await focusFaults(page)).toEqual([
      'button "Sem foco visível" não mostra o contorno de foco de 3 px',
    ]);
  });

  test("6. um controle que o teclado não alcança é pego", async ({ page }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const thief = document.createElement("button");
      thief.textContent = "Rouba o foco";
      thief.addEventListener("focus", () => thief.blur());
      const probe = document.createElement("div");
      probe.dataset.focusProbe = "";
      probe.append(thief);
      document.querySelector("main")?.append(probe);
    });
    expect(await focusFaults(page, "[data-focus-probe]")).toEqual([
      'button "Rouba o foco" está na ordem de Tab e o teclado não chega nele',
    ]);
  });

  test("10. aria-label e title iguais, aria-description e aria-describedby que repetem o nome e texto sr-only igual ao nome (ao lado ou dentro) são pegos; limite: é a marcação, não o que um leitor fala", async ({
    page,
  }) => {
    // The limit: the check compares what the markup says (name, title, descriptions, `sr-only` text), not what a
    // real reader speaks. Whether TalkBack or VoiceOver announces a control twice depends on the reader, the browser and
    // the verbosity setting, and only a device test shows it.
    await openScreen(gallery, page);
    expect(await repeatedNameFaults(page)).toEqual([]);
    await page.evaluate(() => {
      // `sr-only` is the class of the build: the CSP of the page refuses a `style` attribute in markup
      const host = document.createElement("section");
      host.setAttribute("aria-label", "Controles de nome repetido");
      host.innerHTML = `
        <button aria-label="Salvar rótulo" title="Salvar rótulo">+</button>
        <button title="Salvar texto">Salvar texto</button>
        <button aria-description="Salvar descrição">Salvar descrição</button>
        <button aria-describedby="dica-igual">Salvar dica</button>
        <p id="dica-igual" class="sr-only">Salvar dica</p>
        <span>Despesas vizinho</span><span class="sr-only">Despesas vizinho</span>
        <button>Despesas dentro<span class="sr-only">Despesas dentro</span></button>`;
      document.querySelector("main")?.append(host);
    });
    const faults = (await repeatedNameFaults(page, [])).join("\n");
    expect(faults).toContain(
      'button "Salvar rótulo" diz o nome duas vezes: o title repete "salvar rótulo"'
    );
    expect(faults).toContain(
      'button "Salvar texto" diz o nome duas vezes: o title repete "salvar texto"'
    );
    expect(faults).toContain(
      'button "Salvar descrição" diz o nome duas vezes: o aria-description repete "salvar descrição"'
    );
    expect(faults).toContain(
      'button "Salvar dica" diz o nome duas vezes: o aria-describedby repete "salvar dica"'
    );
    expect(faults).toContain(
      'span "Despesas vizinho" diz o nome duas vezes: o vizinho em sr-only repete "despesas vizinho"'
    );
    expect(faults).toContain(
      'button "Despesas dentroDespesas dentro" diz o nome duas vezes: o texto visível e o sr-only de dentro repetem "despesas dentro"'
    );
  });

  test("10. o que não repete passa: title que é o único nome, texto diferente, rótulo de campo e alvo de labelledby em sr-only, texto aria-hidden, região viva e controle escondido", async ({
    page,
  }) => {
    await openScreen(gallery, page);
    await page.evaluate(() => {
      const host = document.createElement("section");
      host.setAttribute("aria-label", "Controles de nome único");
      host.innerHTML = `
        <button title="Só pelo title">+</button>
        <button aria-label="Despesas" title="Abrir as despesas do mês">+</button>
        <button aria-description="Marcada como nova">Despesas</button>
        <span>Despesas distinto</span><span class="sr-only">, 3 novas</span>
        <label for="campo-rotulo" class="sr-only">Campo com rótulo</label>
        <input id="campo-rotulo" />
        <span id="alvo-nome" class="sr-only">Alvo do nome</span>
        <button aria-labelledby="alvo-nome">+</button>
        <button aria-label="Despesas inteira"><span aria-hidden="true">Desp</span><span aria-hidden="true">esas</span></button>
        <span>Salvando</span><span role="status" class="sr-only">Salvando</span>
        <button hidden title="Escondido">Escondido</button>
        <button aria-hidden="true" title="Fora da árvore">Fora da árvore</button>`;
      document.querySelector("main")?.append(host);
    });
    expect(await repeatedNameFaults(page)).toEqual([]);
  });

  test("10. cada exceção da lista conhecida ainda acontece na galeria, e só ela é perdoada", async ({
    page,
  }) => {
    expect(
      KNOWN_REPEATED_NAMES.map(({ selector, via }) => [selector, via])
    ).toEqual([["[data-slot=select-value]", "title"]]);
    for (const entry of KNOWN_REPEATED_NAMES) {
      expect(entry.reason, "a exceção diz a causa").not.toBe("");
    }
    await openScreen(gallery, page);
    for (const entry of KNOWN_REPEATED_NAMES) {
      const others = KNOWN_REPEATED_NAMES.filter((known) => known !== entry);
      // biome-ignore lint/performance/noAwaitInLoops: one entry at a time, on the same page
      const left = await repeatedNameFaults(page, others);
      expect(
        left.length,
        `${entry.selector} (${entry.via}) não acontece mais na galeria (a única tela aberta aqui): confira as outras telas do mapa antes de tirar a entrada de KNOWN_REPEATED_NAMES; se a causa saiu da main, tire-a`
      ).toBeGreaterThan(0);
    }
    expect(await repeatedNameFaults(page)).toEqual([]);
    await page.evaluate(() => {
      const bare = document.createElement("button");
      bare.textContent = "Fora da lista";
      bare.title = "Fora da lista";
      document.querySelector("main")?.append(bare);
    });
    expect(await repeatedNameFaults(page)).toEqual([
      'button "Fora da lista" diz o nome duas vezes: o title repete "fora da lista"',
    ]);
    await page.evaluate(() => {
      const value = document.querySelector("[data-slot=select-value]");
      const text = value?.textContent ?? "";
      const other = document.createElement("span");
      other.setAttribute("data-slot", "select-value");
      other.setAttribute("aria-description", text);
      other.textContent = text;
      value?.after(other);
    });
    expect(
      (await repeatedNameFaults(page)).join("\n"),
      "o mesmo seletor com outro atributo continua reprovando"
    ).toContain("o aria-description repete");
  });
});
