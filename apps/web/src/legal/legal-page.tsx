import {
  LEGAL_DRAFT_NOTICE,
  type LegalDocumentId,
  legalVersionLine,
} from "@polaris/domain/legal/legal-documents";
import InfoIcon from "lucide-react/dist/esm/icons/info";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { Fragment, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { currentLegalText } from "./legal-content";
import { LegalFrame } from "./legal-frame";
import {
  type Block,
  type Inline,
  parseInline,
  parseMarkdown,
} from "./markdown";

/*
 * The text of a legal page on the scale of the reading column (v5.1): h1 24/32 (the frame), h2 17/24 at 600, body
 * 14/20 (16/24 with touch), tables that become one card per row below 640 px, a summary of links with a 48 px
 * touch area, "O essencial" and the warnings in an `Alert`.
 */
const INLINE_LINK =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
const SECTION_TITLE =
  "scroll-mt-4 font-semibold text-[1.0625rem]/6 tracking-tight";

function renderInline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;
    switch (node.kind) {
      case "bold":
        return <strong key={key}>{renderInline(node.children)}</strong>;
      case "link":
        return (
          <a className={INLINE_LINK} href={node.href} key={key}>
            {node.text}
          </a>
        );
      case "marker":
        // Staging builds may carry these; a production build refuses them.
        return (
          <mark
            className="rounded-sm bg-destructive/10 px-1 font-semibold text-destructive"
            data-slot="legal-marker"
            key={key}
          >
            {node.text}
          </mark>
        );
      default:
        return <Fragment key={key}>{node.text}</Fragment>;
    }
  });
}

/** A table is one block that scrolls on its own if it must; on a phone each row is a card with the name of its columns. */
function TableBlock({ block }: { block: Extract<Block, { kind: "table" }> }) {
  return (
    <div className="overflow-x-auto rounded-lg border max-sm:border-0">
      <table className="w-full border-collapse text-left max-sm:block">
        <thead className="max-sm:sr-only">
          <tr className="bg-muted/60">
            {block.header.map((cell) => (
              <th
                className="px-3 py-2 align-top font-medium text-muted-foreground text-xs"
                key={cell}
                scope="col"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-sm:grid max-sm:gap-3">
          {block.rows.map((row) => (
            <tr
              className="border-t max-sm:block max-sm:overflow-hidden max-sm:rounded-lg max-sm:border"
              key={row.map(cellKey).join("|")}
            >
              {row.map((cell, column) => (
                <td
                  className="px-3 py-2 align-top max-sm:block max-sm:first:bg-muted/60 max-sm:first:font-medium max-sm:not-first:before:block max-sm:not-first:before:text-muted-foreground max-sm:not-first:before:text-xs max-sm:not-first:before:content-[attr(data-label)]"
                  data-label={block.header[column]}
                  key={block.header[column]}
                >
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellKey(cell: readonly Inline[]): string {
  return cell
    .map((node) => (node.kind === "bold" ? cellKey(node.children) : node.text))
    .join("");
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading":
      // The title (h1) is rendered by the page header.
      return block.level === 1 ? null : (
        <h2 className={SECTION_TITLE} id={block.id} key={block.id}>
          {block.text}
        </h2>
      );
    case "list":
      return (
        <ul className="m-0 grid list-disc gap-1.5 pl-5" key={`list-${index}`}>
          {block.items.map((item) => (
            <li key={cellKey(item)}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "callout":
      // a warning inside the text, such as the queue that may be lost when a shop closes
      return (
        <Alert key={`callout-${index}`} role="note" variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription className="text-sm/5 touch:text-base/6">
            {renderInline(block.children)}
          </AlertDescription>
        </Alert>
      );
    case "table":
      return <TableBlock block={block} key={`table-${index}`} />;
    default:
      return (
        <p className="text-pretty" key={`paragraph-${index}`}>
          {renderInline(block.children)}
        </p>
      );
  }
}

interface LegalDocumentViewProps {
  document: LegalDocumentId;
  text: string;
}

const SUMMARY_ID = "sumario";

/** The section that sums the text up in a few sentences, shown in a box before the summary. */
const ESSENTIAL_SECTION_ID = "o-essencial";

interface Section {
  blocks: Block[];
  heading: Extract<Block, { kind: "heading" }> | null;
}

/** The blocks before the first `##` form a section with no heading; each `##` opens another. */
function splitSections(blocks: readonly Block[]): Section[] {
  const sections: Section[] = [{ blocks: [], heading: null }];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 2) {
      sections.push({ blocks: [], heading: block });
    } else if (!(block.kind === "heading" && block.level === 1)) {
      sections.at(-1)?.blocks.push(block);
    }
  }
  return sections;
}

function SectionView({ section }: { section: Section }) {
  const { blocks, heading } = section;
  if (!heading) {
    return <>{blocks.map(renderBlock)}</>;
  }
  if (heading.id === ESSENTIAL_SECTION_ID) {
    return (
      <Alert
        aria-labelledby={heading.id}
        className="bg-muted/60 text-foreground"
        role="note"
      >
        <InfoIcon aria-hidden="true" className="text-muted-foreground" />
        <h2 className={SECTION_TITLE} id={heading.id}>
          {heading.text}
        </h2>
        <AlertDescription className="grid gap-3 text-foreground text-sm/5 touch:text-base/6">
          {blocks.map(renderBlock)}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <section
      aria-labelledby={heading.id}
      className="flex flex-col gap-4 pt-2"
      data-slot="legal-section"
    >
      <h2 className={SECTION_TITLE} id={heading.id}>
        {heading.text}
      </h2>
      {blocks.map(renderBlock)}
      <a
        className={`${INLINE_LINK} touch-hit w-fit text-muted-foreground text-support`}
        href={`#${SUMMARY_ID}`}
      >
        Voltar ao sumário
      </a>
    </section>
  );
}

/** The public page of a legal document: header, version, the essentials, summary with anchors and the text. */
export function LegalDocumentView({ document, text }: LegalDocumentViewProps) {
  const [intro, ...sections] = splitSections(parseMarkdown(text));
  const essential = sections.find(
    (section) => section.heading?.id === ESSENTIAL_SECTION_ID
  );
  const numbered = sections.filter((section) => section !== essential);
  return (
    <LegalFrame document={document}>
      <div className="flex flex-col gap-4 text-sm/5 touch:text-base/6 [overflow-wrap:anywhere]">
        <p className="text-muted-foreground">
          {renderInline(parseInline(legalVersionLine(document)))}
        </p>
        {LEGAL_DRAFT_NOTICE ? (
          <Alert role="note" variant="warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription className="font-medium text-sm/5 touch:text-base/6">
              {LEGAL_DRAFT_NOTICE}
            </AlertDescription>
          </Alert>
        ) : null}
        {intro ? <SectionView section={intro} /> : null}
        {essential ? <SectionView section={essential} /> : null}
        <nav
          aria-labelledby="legal-summary-title"
          className="rounded-lg border px-3 py-2.5"
          id={SUMMARY_ID}
        >
          <h2 className="font-semibold text-section" id="legal-summary-title">
            Sumário
          </h2>
          <ol className="m-0 mt-1 grid list-none p-0">
            {numbered.map(({ heading }) =>
              heading ? (
                <li key={heading.id}>
                  <a
                    className={`${INLINE_LINK} touch-hit flex min-h-8 touch:min-h-12 items-center`}
                    href={`#${heading.id}`}
                  >
                    {heading.text}
                  </a>
                </li>
              ) : null
            )}
          </ol>
        </nav>
        {numbered.map((section) => (
          <SectionView key={section.heading?.id} section={section} />
        ))}
      </div>
    </LegalFrame>
  );
}

/** The page of a document, with the text of the version in force. */
export function LegalPage({ document }: { document: LegalDocumentId }) {
  return (
    <LegalDocumentView document={document} text={currentLegalText(document)} />
  );
}
