import type { DeviceReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ListSection } from "./devices-page";

vi.mock("../../lib/orpc", () => ({ orpcClient: {} }));

const DEVICE_ROW = {
  id: "0199c2d0-0000-7000-8000-000000000002",
  isCurrent: false,
  kind: "unknown" as const,
  labelText: "Celular da Ana",
  lastSeenText: "13/10/2026, 07:00",
  registeredText: "01/10/2026, 09:00",
};

const render = (rows = [DEVICE_ROW]) =>
  renderToStaticMarkup(
    <ListSection
      actionError={null}
      busy={false}
      confirming={null}
      devices={[] as DeviceReadModel[]}
      endOtherSessions={false}
      loadFailed={null}
      loading={false}
      notice={null}
      offline={false}
      onAsk={vi.fn()}
      onCancel={vi.fn()}
      onChoose={vi.fn()}
      onDismiss={vi.fn()}
      online={true}
      onRetry={vi.fn()}
      onRevoke={vi.fn()}
      panel={null}
      recognition={null}
      rows={rows}
    />
  );

describe("the list of devices", () => {
  it("frames the rows with the title and draws no count paragraph nor its reserved width", () => {
    const html = render();
    expect(html).toContain('data-list-block=""');
    expect(html).toContain(">Aparelhos desta conta</h2>");
    expect(html).not.toContain("data-list-count");
    expect(html).not.toContain("min-w-28");
  });
});
