import {
  LEGAL_DRAFT_NOTICE,
  type LegalDocumentId,
  legalVersionLine,
} from "@polaris/domain/legal/legal-documents";
import { Fragment, type ReactNode } from "react";
import { currentLegalText } from "./legal-content";
import { LegalFrame } from "./legal-frame";
import {
  type Block,
  type Inline,
  parseInline,
  parseMarkdown,
} from "./markdown";

function renderInline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;
    switch (node.kind) {
      case "bold":
        return <strong key={key}>{renderInline(node.children)}</strong>;
      case "link":
        return (
          <a href={node.href} key={key}>
            {node.text}
          </a>
        );
      case "marker":
        // Staging builds may carry these; a production build refuses them.
        return (
          <mark className="legal-marker" key={key}>
            {node.text}
          </mark>
        );
      default:
        return <Fragment key={key}>{node.text}</Fragment>;
    }
  });
}

function TableBlock({ block }: { block: Extract<Block, { kind: "table" }> }) {
  return (
    <div className="legal-table-wrap">
      <table className="legal-table">
        <thead>
          <tr>
            {block.header.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.map(cellKey).join("|")}>
              {row.map((cell, column) => (
                <td
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
        <h2 id={block.id} key={block.id}>
          {block.text}
        </h2>
      );
    case "list":
      return (
        <ul key={`list-${index}`}>
          {block.items.map((item) => (
            <li key={cellKey(item)}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "callout":
      return (
        <p className="legal-callout" key={`callout-${index}`} role="note">
          {renderInline(block.children)}
        </p>
      );
    case "table":
      return <TableBlock block={block} key={`table-${index}`} />;
    default:
      return <p key={`paragraph-${index}`}>{renderInline(block.children)}</p>;
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
      <aside aria-labelledby={heading.id} className="legal-essential">
        <h2 id={heading.id}>{heading.text}</h2>
        {blocks.map(renderBlock)}
      </aside>
    );
  }
  return (
    <section aria-labelledby={heading.id}>
      <h2 id={heading.id}>{heading.text}</h2>
      {blocks.map(renderBlock)}
      <a className="legal-back" href={`#${SUMMARY_ID}`}>
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
      <p className="legal-version">
        {renderInline(parseInline(legalVersionLine(document)))}
      </p>
      {LEGAL_DRAFT_NOTICE ? (
        <p className="legal-draft" role="note">
          {LEGAL_DRAFT_NOTICE}
        </p>
      ) : null}
      {intro ? <SectionView section={intro} /> : null}
      {essential ? <SectionView section={essential} /> : null}
      <nav
        aria-labelledby="legal-summary-title"
        className="legal-summary"
        id={SUMMARY_ID}
      >
        <h2 id="legal-summary-title">Sumário</h2>
        <ol>
          {numbered.map(({ heading }) =>
            heading ? (
              <li key={heading.id}>
                <a href={`#${heading.id}`}>{heading.text}</a>
              </li>
            ) : null
          )}
        </ol>
      </nav>
      {numbered.map((section) => (
        <SectionView key={section.heading?.id} section={section} />
      ))}
    </LegalFrame>
  );
}

/** The page of a document, with the text of the version in force. */
export function LegalPage({ document }: { document: LegalDocumentId }) {
  return (
    <LegalDocumentView document={document} text={currentLegalText(document)} />
  );
}
