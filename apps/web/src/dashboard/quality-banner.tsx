import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import {
  type PeriodQuality,
  qualitySummary,
  qualityView,
} from "./dashboard-model";

/**
 * How complete the estimate is. Complete is a quiet line, partial is a warning in one line that counts what was left
 * out, with the list of what is missing behind "Ver o que falta". It sits under the cards so the screen opens with the
 * number; it is never hidden. The tone is always in the text, never only in the color. (No data is not shown here: the
 * screen says it with the empty state.)
 */
export function QualityBanner({ quality }: { quality: PeriodQuality }) {
  const view = qualityView(quality);
  return (
    <section aria-label="Qualidade dos dados">
      {view.tone === "partial" ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>
            <Collapsible>
              <p>
                {qualitySummary(quality) ?? view.title}{" "}
                <CollapsibleTrigger
                  className="group/missing -my-1 touch:-my-1.5 inline-flex w-fit align-baseline"
                  render={<Button size="sm" variant="ghost" />}
                >
                  Ver o que falta
                  <ChevronDownIcon
                    aria-hidden="true"
                    className="motion-full:transition-transform group-data-[panel-open]/missing:rotate-180"
                    data-icon="inline-end"
                  />
                </CollapsibleTrigger>
              </p>
              <CollapsiblePanel className="grid gap-2 pt-2" keepMounted>
                <ul className="list-disc pl-4">
                  {view.messages.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
                <p>
                  O que não é conhecido fica de fora das contas, nunca entra
                  como zero.
                </p>
              </CollapsiblePanel>
            </Collapsible>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground text-support" role="status">
          {view.title}.{" "}
          {view.messages.map((message) => (
            <span key={message}>{message}</span>
          ))}
        </p>
      )}
    </section>
  );
}
