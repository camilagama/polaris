import type { ProductMediaAssetReadModel } from "@polaris/contracts";
import { useCallback } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { InlineConfirm } from "@/ui/inline-confirm";
import { InsetBlock } from "@/ui/inset-block";
import { formatFileSize } from "../lib/format";
import { productMediaAssetUrl } from "../lib/media-upload";
import { useMediaThumbsEnabled } from "../lib/media-thumbs-flag";
import {
  COVER_NOTICE,
  type ImageActionAvailability,
  imageActionAvailability,
  imageActionLabel,
  type MoveDirection,
  removeConfirmationText,
  replaceConfirmationText,
} from "./media-commands-model";

export function CoverNotice() {
  if (!useMediaThumbsEnabled()) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-support" data-cover-notice="">
      {COVER_NOTICE}
    </p>
  );
}

export type ConfirmKind = "remove" | "replace";

type CommandKind = "move" | ConfirmKind;

export interface RunningCommand {
  assetId: string;
  kind: CommandKind;
}

export interface ConfirmRequest {
  assetId: string;
  kind: ConfirmKind;
}

function confirmButtonLabel(kind: ConfirmKind, running: boolean): string {
  if (kind === "remove") {
    return running ? "Removendo…" : "Remover imagem";
  }
  return running ? "Substituindo…" : "Remover e escolher outra";
}

interface ProductMediaItemProps {
  asset: ProductMediaAssetReadModel;
  availability: ImageActionAvailability;
  confirming: ConfirmKind | null;
  count: number;
  index: number;
  onAsk: (assetId: string, kind: ConfirmKind) => void;
  onConfirm: (assetId: string, kind: ConfirmKind) => void;
  onKeep: () => void;
  onMove: (assetId: string, direction: MoveDirection) => void;
  organizationId: string;
  productName: string;
  running: CommandKind | null;
}

function ProductMediaItem({
  asset,
  availability,
  confirming,
  count,
  index,
  onAsk,
  onConfirm,
  onKeep,
  onMove,
  organizationId,
  productName,
  running,
}: ProductMediaItemProps) {
  const { assetId } = asset;
  const position = index + 1;
  const handleMoveEarlier = useCallback(
    () => onMove(assetId, "earlier"),
    [assetId, onMove]
  );
  const handleMoveLater = useCallback(
    () => onMove(assetId, "later"),
    [assetId, onMove]
  );
  const handleAskRemove = useCallback(
    () => onAsk(assetId, "remove"),
    [assetId, onAsk]
  );
  const handleAskReplace = useCallback(
    () => onAsk(assetId, "replace"),
    [assetId, onAsk]
  );
  const handleConfirm = useCallback(() => {
    if (confirming) {
      onConfirm(assetId, confirming);
    }
  }, [assetId, confirming, onConfirm]);
  const opener = useCallback(
    () =>
      document.querySelector<HTMLElement>(
        `[data-asset-id="${assetId}"] [data-media-action="${confirming}"]`
      ),
    [assetId, confirming]
  );
  const variantCount = asset.variantIds.length;
  const showCover = useMediaThumbsEnabled() && position === 1;
  const confirmRunning = confirming !== null && running === confirming;

  return (
    <li aria-busy={running !== null} data-asset-id={assetId}>
      <InsetBlock className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3 p-3">
        <img
          alt={`${productName}, imagem ${position}`}
          className="size-18 rounded-md bg-muted object-cover"
          height={asset.height}
          loading="lazy"
          src={productMediaAssetUrl(asset, organizationId, undefined, 320)}
          width={asset.width}
        />
        <div className="grid min-w-0 gap-0.5 [overflow-wrap:anywhere]">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span>
              Imagem {position} de {count}
            </span>
            {showCover ? <Badge data-cover="">Capa</Badge> : null}
          </p>
          <span className="text-muted-foreground text-support">
            {asset.width} × {asset.height} · {formatFileSize(asset.byteSize)}
          </span>
          {variantCount > 0 ? (
            <span className="text-muted-foreground text-support">
              Associada a {variantCount}{" "}
              {variantCount === 1 ? "variante" : "variantes"}
            </span>
          ) : null}
        </div>
        {confirming ? (
          <InlineConfirm
            action={confirming === "remove" ? "remoção" : "substituição"}
            busy={running !== null}
            className="col-span-full"
            confirmLabel={confirmButtonLabel(confirming, confirmRunning)}
            keepLabel="Manter imagem"
            object={`imagem ${position}`}
            onConfirm={handleConfirm}
            onKeep={onKeep}
            opener={opener}
          >
            {confirming === "remove"
              ? removeConfirmationText({ position, variantCount })
              : replaceConfirmationText({ position, variantCount })}
          </InlineConfirm>
        ) : (
          <fieldset className="col-span-full flex min-w-0 flex-wrap gap-3">
            <legend className="sr-only">Ações da imagem {position}</legend>
            <Button
              aria-label={imageActionLabel("moveEarlier", index)}
              data-media-action="moveEarlier"
              disabled={!availability.moveEarlier}
              onClick={handleMoveEarlier}
              type="button"
              variant="outline"
            >
              Para antes
            </Button>
            <Button
              aria-label={imageActionLabel("moveLater", index)}
              data-media-action="moveLater"
              disabled={!availability.moveLater}
              onClick={handleMoveLater}
              type="button"
              variant="outline"
            >
              Para depois
            </Button>
            <Button
              aria-label={imageActionLabel("replace", index)}
              data-media-action="replace"
              disabled={!availability.replace}
              onClick={handleAskReplace}
              type="button"
              variant="outline"
            >
              Substituir
            </Button>
            <Button
              aria-label={imageActionLabel("remove", index)}
              data-media-action="remove"
              disabled={!availability.remove}
              onClick={handleAskRemove}
              type="button"
              variant="destructive"
            >
              Remover
            </Button>
          </fieldset>
        )}
      </InsetBlock>
    </li>
  );
}

interface ProductMediaListProps {
  assets: ProductMediaAssetReadModel[];
  busy: boolean;
  confirm: ConfirmRequest | null;
  onAsk: (assetId: string, kind: ConfirmKind) => void;
  onConfirm: (assetId: string, kind: ConfirmKind) => void;
  onKeep: () => void;
  onMove: (assetId: string, direction: MoveDirection) => void;
  organizationId: string;
  productName: string;
  running: RunningCommand | null;
}

export function ProductMediaList({
  assets,
  busy,
  confirm,
  onAsk,
  onConfirm,
  onKeep,
  onMove,
  organizationId,
  productName,
  running,
}: ProductMediaListProps) {
  if (assets.length === 0) {
    return (
      <p className="py-4 text-center text-muted-foreground text-support">
        Ainda não há imagens neste produto. Escolha uma acima para enviar.
      </p>
    );
  }

  return (
    <ul aria-busy={busy} className="grid gap-2">
      {assets.map((asset, index) => (
        <ProductMediaItem
          asset={asset}
          availability={imageActionAvailability({
            busy,
            count: assets.length,
            index,
          })}
          confirming={confirm?.assetId === asset.assetId ? confirm.kind : null}
          count={assets.length}
          index={index}
          key={asset.assetId}
          onAsk={onAsk}
          onConfirm={onConfirm}
          onKeep={onKeep}
          onMove={onMove}
          organizationId={organizationId}
          productName={productName}
          running={running?.assetId === asset.assetId ? running.kind : null}
        />
      ))}
    </ul>
  );
}
