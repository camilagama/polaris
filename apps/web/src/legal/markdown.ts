import { findPendingMarkers } from "@polaris/domain/legal/legal-documents";

/**
 * The restricted Markdown of the legal texts: headings (`#`, `##`), paragraphs, `-` lists, tables,
 * `**bold**`, a `> ` line (a highlighted notice) and links to a page of the app. Anything else is an error, so a text can never bring
 * HTML, an image or an outside link in without someone changing this file on purpose. The result is
 * plain data; the page turns it into React elements (no `dangerouslySetInnerHTML`).
 */
export type Inline =
  | { kind: "bold"; children: Inline[] }
  | { kind: "link"; href: string; text: string }
  | { kind: "marker"; text: string }
  | { kind: "text"; text: string };

export type Block =
  | { kind: "callout"; children: Inline[] }
  | { kind: "heading"; id: string; level: 1 | 2; text: string }
  | { kind: "list"; items: Inline[][] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "table"; header: string[]; rows: Inline[][][] };

const BOLD = /\*\*(.+?)\*\*/;
const LINK = /\[([^\]]+)\]\(([^)]*)\)/;
const internalHref = /^\/(?![\\/])[^\s\\]*$/;
const heading = /^(#{1,3}) (.+)$/;
const tableSeparatorCell = /^:?-{3,}:?$/;
const diacritics = /\p{Diacritic}/gu;
const notAlphanumeric = /[^a-z0-9]+/g;
const edgeDashes = /^-+|-+$/g;
const unsupportedSource = /<|!\[|`/;
const unsupportedLine = /^>(?! )|^\d+\. |^\* |^_{3,}$|^-{3,}$/;
const startsBlock = /^(?:#|- |\||> )/;
const leadingPipe = /^\|/;
const trailingPipe = /\|$/;

/** The anchor of a heading: lowercase, without accents, words joined by `-`. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(diacritics, "")
    .toLowerCase()
    .replace(notAlphanumeric, "-")
    .replace(edgeDashes, "");
}

/** A page of the app: starts with one `/`, no `//` or `/\\` (which a browser reads as another host), no spaces. */
function isInternalHref(href: string): boolean {
  return href === "/" || internalHref.test(href);
}

function plain(text: string): Inline[] {
  const markers = findPendingMarkers(text);
  const parts: Inline[] = [];
  let rest = text;
  for (const marker of markers) {
    const at = rest.indexOf(marker);
    if (at > 0) {
      parts.push({ kind: "text", text: rest.slice(0, at) });
    }
    parts.push({ kind: "marker", text: marker });
    rest = rest.slice(at + marker.length);
  }
  if (rest) {
    parts.push({ kind: "text", text: rest });
  }
  return parts;
}

/** Bold, links and the pending markers of a line of text. */
export function parseInline(text: string): Inline[] {
  const bold = BOLD.exec(text);
  const link = LINK.exec(text);
  const [first] = [bold, link]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => a.index - b.index);
  if (!first) {
    return plain(text);
  }
  const before = text.slice(0, first.index);
  const after = text.slice(first.index + first[0].length);
  const node: Inline =
    first === bold
      ? { children: parseInline(first[1] ?? ""), kind: "bold" }
      : linkNode(first[1] ?? "", first[2] ?? "");
  return [...plain(before), node, ...parseInline(after)];
}

function linkNode(text: string, href: string): Inline {
  if (!isInternalHref(href)) {
    throw new Error(`Link que não é uma página do app: ${href}`);
  }
  return { href, kind: "link", text };
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(leadingPipe, "")
    .replace(trailingPipe, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseTable(lines: string[]): Block {
  const [headerLine = "", separatorLine = "", ...bodyLines] = lines;
  const header = tableCells(headerLine);
  const separator = tableCells(separatorLine);
  if (
    separator.length !== header.length ||
    !separator.every((cell) => tableSeparatorCell.test(cell))
  ) {
    throw new Error(`Tabela sem linha de separação: ${headerLine}`);
  }
  const rows = bodyLines.map((line) => {
    const cells = tableCells(line);
    if (cells.length !== header.length) {
      throw new Error(`Linha de tabela com ${cells.length} colunas: ${line}`);
    }
    return cells.map(parseInline);
  });
  return { header, kind: "table", rows };
}

interface Read {
  block: Block;
  /** How many lines the block took. */
  lines: number;
}

/** The lines from the first one while `test` holds. */
function takeWhile(lines: string[], test: (line: string) => boolean): string[] {
  const end = lines.findIndex((line) => !test(line));
  return lines.slice(0, end === -1 ? lines.length : end);
}

function readHeading(line: string): Read | null {
  const match = heading.exec(line);
  if (!match) {
    return null;
  }
  const level = (match[1] ?? "").length;
  if (level > 2) {
    throw new Error(`Título de nível ${level} não é aceito: ${line}`);
  }
  const text = match[2] ?? "";
  return {
    block: {
      id: slugify(text),
      kind: "heading",
      level: level === 1 ? 1 : 2,
      text,
    },
    lines: 1,
  };
}

function readBlock(lines: string[]): Read {
  const [line = ""] = lines;
  const headingRead = readHeading(line);
  if (headingRead) {
    return headingRead;
  }
  if (line.startsWith("- ")) {
    const items = takeWhile(lines, (candidate) => candidate.startsWith("- "));
    return {
      block: {
        items: items.map((item) => parseInline(item.slice(2))),
        kind: "list",
      },
      lines: items.length,
    };
  }
  if (line.startsWith("> ")) {
    const quoted = takeWhile(lines, (candidate) => candidate.startsWith("> "));
    return {
      block: {
        children: parseInline(quoted.map((item) => item.slice(2)).join(" ")),
        kind: "callout",
      },
      lines: quoted.length,
    };
  }
  if (line.startsWith("|")) {
    const table = takeWhile(lines, (candidate) => candidate.startsWith("|"));
    return { block: parseTable(table), lines: table.length };
  }
  if (unsupportedLine.test(line)) {
    throw new Error(`Sintaxe que o texto legal não aceita: ${line}`);
  }
  const paragraph = takeWhile(lines, (candidate) => candidate.trim() !== "");
  const swallowed = paragraph
    .slice(1)
    .find((candidate) => startsBlock.test(candidate));
  if (swallowed) {
    throw new Error(`Falta uma linha em branco antes de: ${swallowed}`);
  }
  return {
    block: { children: parseInline(paragraph.join(" ")), kind: "paragraph" },
    lines: paragraph.length,
  };
}

/** The blocks of a text, in order. Throws on any syntax outside the restricted set. */
export function parseMarkdown(source: string): Block[] {
  if (unsupportedSource.test(source)) {
    throw new Error(
      "O texto legal tem HTML, imagem ou código, que não são aceitos."
    );
  }
  const blocks: Block[] = [];
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length) {
    if ((lines[index] ?? "").trim() === "") {
      index += 1;
      continue;
    }
    const read = readBlock(lines.slice(index));
    blocks.push(read.block);
    index += read.lines;
  }
  return blocks;
}
