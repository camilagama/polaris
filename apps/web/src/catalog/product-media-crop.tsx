import type { NormalizedMediaCropRect } from "@polaris/domain/catalog/media";
import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { describeCrop } from "./media-crop-model";

interface ProductMediaCropFieldProps {
  adjusting: boolean;
  announcement: string;
  crop: NormalizedMediaCropRect;
  dimensions: { height: number; width: number } | null;
  disabled: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onToggleAdjusting: () => void;
  onUseFullImage: () => void;
  previewUrl: string;
}

/** The picked image and the area to keep: drawn with the pointer, or moved with the arrow keys. */
export function ProductMediaCropField({
  adjusting,
  announcement,
  crop,
  dimensions,
  disabled,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onToggleAdjusting,
  onUseFullImage,
  previewUrl,
}: ProductMediaCropFieldProps) {
  const selectionStyle = {
    height: `${crop.height * 100}%`,
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
  };
  // touch scrolls the page unless "Ajustar com o dedo" turns the drawing on
  const frameTouch = adjusting ? "touch-none" : "touch-pan-y touch-pinch-zoom";

  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-3 min-[30rem]:flex-row min-[30rem]:items-start min-[30rem]:justify-between">
        <div className="grid gap-0.5">
          <p className="font-medium">Recorte</p>
          <p className="text-muted-foreground text-support">
            Arraste sobre a imagem para escolher uma área. Com o teclado, as
            setas aumentam ou diminuem o recorte a partir do canto inferior
            direito; com Alt, a partir do canto superior esquerdo; com Shift,
            movem a área. Um toque sem arraste mantém a imagem inteira.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            aria-pressed={adjusting}
            disabled={disabled}
            onClick={onToggleAdjusting}
            type="button"
            variant="outline"
          >
            {adjusting ? "Concluir ajuste" : "Ajustar com o dedo"}
          </Button>
          <Button
            disabled={disabled}
            onClick={onUseFullImage}
            type="button"
            variant="outline"
          >
            Imagem inteira
          </Button>
        </div>
      </div>
      <div className="flex max-h-[62vh] max-w-full items-center justify-center overflow-auto rounded-lg border border-border bg-muted p-2 min-[30rem]:p-3">
        <button
          aria-describedby="product-media-crop-help product-media-crop-state"
          aria-label="Área de recorte. Arraste ou use as setas para ajustar."
          className={cn(
            "focus-ring relative inline-block max-h-[54vh] max-w-full cursor-crosshair select-none rounded-sm p-0 text-left leading-none min-[30rem]:max-h-[60vh]",
            frameTouch
          )}
          onKeyDown={onKeyDown}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          type="button"
        >
          <img
            alt=""
            className="pointer-events-none block h-auto max-h-[54vh] w-auto max-w-full min-[30rem]:max-h-[60vh]"
            draggable={false}
            height={dimensions?.height}
            src={previewUrl}
            width={dimensions?.width}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute min-h-0.5 min-w-0.5 border-2 border-ring bg-ring/15 shadow-[0_0_0_1px_var(--background)]"
            style={selectionStyle}
          />
        </button>
      </div>
      <p
        aria-live="polite"
        className="text-muted-foreground text-support"
        id="product-media-crop-state"
        role="status"
      >
        {announcement || describeCrop(crop)}
      </p>
      <p
        className="text-muted-foreground text-support"
        id="product-media-crop-help"
      >
        A imagem é guardada com no máximo 1200 px, na mesma proporção, e nunca é
        ampliada.
      </p>
    </div>
  );
}
