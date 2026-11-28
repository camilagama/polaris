import type { DeviceReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { deviceRows } from "./devices-model";
import { ListSection } from "./devices-page";

vi.mock("../../lib/orpc", () => ({ orpcClient: {} }));

const DEVICE: DeviceReadModel = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000002",
  label: "Celular da Ana",
  lastSeenAt: "2026-10-13T10:00:00.000Z",
  revokedAt: null,
};

const render = (devices = [DEVICE]) =>
  renderToStaticMarkup(
    <ListSection
      actionError={null}
      busy={false}
      confirming={null}
      devices={devices}
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
      rows={deviceRows(devices, null)}
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

  it("draws Revogar on the row as an outline button, with the red kept for the confirmation", () => {
    const html = render();
    const end = html.indexOf(">Revogar<");
    const tag = html.slice(html.lastIndexOf("<button", end), end);
    expect(tag).toContain('aria-label="Revogar o aparelho Celular da Ana"');
    expect(tag).toContain("bg-card");
    expect(tag).not.toContain("bg-destructive");
    expect(tag).not.toContain("text-destructive");
  });
});
