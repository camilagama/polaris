import {
  LEGAL_DRAFT_NOTICE,
  type LegalDocumentId,
  legalVersionLine,
} from "@polaris/domain/legal/legal-documents";
import { Fragment, type ReactNode } from "react";
import { currentLegalText } from "./legal-content";
import { LEGAL_PAGE_TITLES } from "./legal-routes";
import "./legal.css";
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

/** The public page of a legal document: header, version, summary with anchors and the text. */
export function LegalDocumentView({ document, text }: LegalDocumentViewProps) {
  const blocks = parseMarkdown(text);
  const sections = blocks.filter(
    (block): block is Extract<Block, { kind: "heading" }> =>
      block.kind === "heading" && block.level === 2
  );
  return (
    <div className="ui-root legal-root">
      <header className="legal-topbar">
        <a aria-label="Polaris, início" className="app-brand" href="/">
          <span aria-hidden="true" className="app-brand-mark">
            P
          </span>
          <span>Polaris</span>
        </a>
      </header>
      <main className="legal-main" id="conteudo">
        <article aria-labelledby="legal-title">
          <h1 id="legal-title">{LEGAL_PAGE_TITLES[document]}</h1>
          <p className="legal-version">
            {renderInline(parseInline(legalVersionLine(document)))}
          </p>
          {LEGAL_DRAFT_NOTICE ? (
            <p className="legal-draft" role="note">
              {LEGAL_DRAFT_NOTICE}
            </p>
          ) : null}
          <nav aria-labelledby="legal-summary-title" className="legal-summary">
            <h2 id="legal-summary-title">Sumário</h2>
            <ol>
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.text}</a>
                </li>
              ))}
            </ol>
          </nav>
          {blocks.map(renderBlock)}
        </article>
      </main>
    </div>
  );
}

/** The page of a document, with the text of the version in force. */
export function LegalPage({ document }: { document: LegalDocumentId }) {
  return (
    <LegalDocumentView document={document} text={currentLegalText(document)} />
  );
}
