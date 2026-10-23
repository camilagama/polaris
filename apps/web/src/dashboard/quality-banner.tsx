import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { type PeriodQuality, qualityView } from "./dashboard-model";

/**
 * How complete the estimate is. Complete is a quiet line, partial is a warning that names what was left out. The
 * tone is always in the text, never only in the color. (No data is not shown here: the screen says it with the
 * empty state.)
 */
export function QualityBanner({ quality }: { quality: PeriodQuality }) {
  const view = qualityView(quality);
  return (
    <section aria-label="Qualidade dos dados">
      {view.tone === "partial" ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>{view.title}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {view.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <p>
              O que não é conhecido fica de fora das contas, nunca entra como
              zero.
            </p>
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
