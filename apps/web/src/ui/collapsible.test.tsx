import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";

/**
 * The first paint of the Collapsible: a panel that mounts open (or closed) does not carry the height animation, which
 * waits for a change of state (the browser proof of the change, with the height half way, is in
 * e2e-pwa/ui-guardrails.e2e.ts).
 */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const withState = (props: { defaultOpen?: boolean; open?: boolean }) =>
  html(
    <Collapsible {...props}>
      <CollapsibleTrigger>Ver</CollapsibleTrigger>
      <CollapsiblePanel className="pt-2">Conteúdo</CollapsiblePanel>
    </Collapsible>
  );

describe("Collapsible, primeira pintura", () => {
  it.each([
    ["defaultOpen", { defaultOpen: true }],
    ["open", { open: true }],
  ])("monta aberto por %s sem a animação de altura", (_name, props) => {
    const markup = withState(props);
    expect(markup).toContain("Conteúdo");
    expect(markup).toContain('data-open=""');
    expect(markup).not.toContain("animate-collapsible");
  });

  it("monta fechado sem a animação de altura", () => {
    expect(withState({})).not.toContain("animate-collapsible");
  });
});
