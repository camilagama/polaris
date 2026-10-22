import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ActionFeedback,
  OFFLINE_NOTICE_ID,
  OfflineNotice,
} from "./products-page-parts";

/** The notice of the last action (drawn without a browser): "Desfazer" only where the screen hands an undo. */
const regionRef = createRef<HTMLDivElement>();
const noop = () => undefined;
const ANY_DISABLED_BUTTON = /<button[^>]*aria-disabled="true"/;
const DISABLED_UNDO = /<button[^>]*aria-disabled="true"[^>]*>Desfazer/;
const NATIVE_DISABLED = /<button[^>]*\sdisabled(?:=|\s|>)/;
const POINTS_AT_REASON =
  /<button[^>]*aria-describedby="products-offline-notice"/;

describe("ActionFeedback", () => {
  it("has no button on a notice without an undo (the restored one)", () => {
    const markup = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” restaurado."
        regionRef={regionRef}
      />
    );
    expect(markup).toContain("restaurado.");
    expect(markup).not.toContain("Desfazer");
    expect(markup).not.toContain("<button");
  });

  it("offers Desfazer on the archived notice, and switches it off when it cannot start", () => {
    const on = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” arquivado."
        onUndo={noop}
        regionRef={regionRef}
        undoDisabled={false}
      />
    );
    expect(on).toContain("Desfazer");
    expect(on).not.toMatch(ANY_DISABLED_BUTTON);
    const off = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” arquivado."
        onUndo={noop}
        regionRef={regionRef}
        undoDisabled
        undoReasonId={OFFLINE_NOTICE_ID}
      />
    );
    expect(off).toMatch(DISABLED_UNDO);
    // not `disabled`: the button stays reachable by keyboard and reads the reason (the offline notice)
    expect(off).not.toMatch(NATIVE_DISABLED);
    expect(off).toMatch(POINTS_AT_REASON);
    expect(renderToStaticMarkup(<OfflineNotice />)).toContain(
      `id="${OFFLINE_NOTICE_ID}"`
    );
  });

  it("does not point at the offline notice while only an action is running", () => {
    const busy = renderToStaticMarkup(
      <ActionFeedback
        error={null}
        notice="Produto “Camiseta” arquivado."
        onUndo={noop}
        regionRef={regionRef}
        undoDisabled
      />
    );
    expect(busy).toMatch(DISABLED_UNDO);
    expect(busy).not.toContain("aria-describedby");
  });
});
