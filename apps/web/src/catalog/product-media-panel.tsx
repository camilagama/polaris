import type {
  ProductMediaAssetReadModel,
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import {
  InvalidMediaCropError,
  MediaImageTooLargeError,
  type NormalizedMediaCropRect,
  UnsupportedMediaImageError,
} from "@polaris/domain/catalog/media";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  listProductMedia,
  prepareMediaUploadFile,
  productMediaAssetUrl,
  removeProductMedia,
  reorderProductMedia,
  uploadProductMedia,
} from "../lib/media-upload";
import { orpcClient } from "../lib/orpc";
import {
  describeMediaFailure,
  type ImageActionAvailability,
  imageActionAvailability,
  imageActionLabel,
  type MediaFailure,
  type MediaFailureContext,
  type MoveDirection,
  movedAssetOrder,
  movedNotice,
  removeConfirmationText,
  removedNotice,
  replaceConfirmationText,
  replacementAbandonedText,
  replacementDoneText,
  replacementPendingText,
} from "./media-commands-model";
import {
  adjustCropWithKey,
  cropArrowKeys,
  describeCrop,
} from "./media-crop-model";
import "./product-media-panel.css";

interface ProductMediaPanelProps {
  onClose: () => void;
  organizationId: string;
  product: ProductReadModel;
}

interface CropPoint {
  clientX: number;
  clientY: number;
  x: number;
  y: number;
}

interface ImageDimensions {
  height: number;
  width: number;
}

const fullImageCrop: NormalizedMediaCropRect = {
  height: 1,
  width: 1,
  x: 0,
  y: 0,
};

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

async function readImageDimensions(url: string): Promise<ImageDimensions> {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new UnsupportedMediaImageError();
  }
  return { height: image.naturalHeight, width: image.naturalWidth };
}

function cropFromDrag(
  start: CropPoint,
  end: CropPoint
): NormalizedMediaCropRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    height: Math.abs(end.y - start.y),
    width: Math.abs(end.x - start.x),
    x,
    y,
  };
}

function mediaFailure(
  context: MediaFailureContext,
  error: unknown
): MediaFailure {
  if (error instanceof MediaImageTooLargeError) {
    return {
      message: "A imagem original ultrapassa 20 MB. Escolha um arquivo menor.",
      reloadList: false,
    };
  }
  if (error instanceof UnsupportedMediaImageError) {
    return {
      message:
        "Não foi possível ler este arquivo. Use JPEG, PNG, WebP ou HEIC.",
      reloadList: false,
    };
  }
  if (error instanceof InvalidMediaCropError) {
    return {
      message: "A área de recorte não é válida. Selecione uma área maior.",
      reloadList: false,
    };
  }
  return describeMediaFailure(context, error);
}

function variantLabel(variant: {
  isDefault: boolean;
  values: Array<{ optionValueName: string }>;
}): string {
  const values = variant.values.map((value) => value.optionValueName);
  return values.length > 0 ? values.join(" / ") : "Variante padrão";
}

function formatBytes(value: number): string {
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

type ConfirmKind = "remove" | "replace";

type CommandKind = "move" | ConfirmKind;

interface RunningCommand {
  assetId: string;
  kind: CommandKind;
}

interface ConfirmRequest {
  assetId: string;
  kind: ConfirmKind;
}

type FocusRequest =
  | { assetId: string; fallbacks: readonly string[]; type: "item" }
  | { assetId: string; type: "keep" }
  | { type: "file" }
  | { type: "heading" };

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
  onKeep: (assetId: string, kind: ConfirmKind) => void;
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
  const handleKeep = useCallback(() => {
    if (confirming) {
      onKeep(assetId, confirming);
    }
  }, [assetId, confirming, onKeep]);
  const variantCount = asset.variantIds.length;
  const confirmRunning = confirming !== null && running === confirming;

  return (
    <li
      aria-busy={running !== null}
      className="product-media-item"
      data-asset-id={assetId}
    >
      <img
        alt={`${productName}, imagem ${position}`}
        height={asset.height}
        loading="lazy"
        src={productMediaAssetUrl(asset, organizationId, undefined, 320)}
        width={asset.width}
      />
      <div className="product-media-item-copy">
        <p>
          Imagem {position} de {count}
        </p>
        <span>
          {asset.width} × {asset.height} · {formatBytes(asset.byteSize)}
        </span>
        {variantCount > 0 ? (
          <span>
            Associada a {variantCount}{" "}
            {variantCount === 1 ? "variante" : "variantes"}
          </span>
        ) : null}
      </div>
      {confirming ? (
        <div
          aria-label={`Confirmar ${confirming === "remove" ? "remoção" : "substituição"} da imagem ${position}`}
          className="product-media-confirm"
          role="alertdialog"
        >
          <p>
            {confirming === "remove"
              ? removeConfirmationText({ position, variantCount })
              : replaceConfirmationText({ position, variantCount })}
          </p>
          <div className="product-media-item-actions">
            <button
              className="danger-button"
              disabled={running !== null}
              onClick={handleConfirm}
              type="button"
            >
              {confirmButtonLabel(confirming, confirmRunning)}
            </button>
            <button
              className="quiet-button"
              data-media-action="keep"
              disabled={running !== null}
              onClick={handleKeep}
              type="button"
            >
              Manter imagem
            </button>
          </div>
        </div>
      ) : (
        <fieldset className="product-media-item-actions is-group">
          <legend className="visually-hidden">
            Ações da imagem {position}
          </legend>
          <button
            aria-label={imageActionLabel("moveEarlier", index)}
            className="quiet-button"
            data-media-action="moveEarlier"
            disabled={!availability.moveEarlier}
            onClick={handleMoveEarlier}
            type="button"
          >
            Para antes
          </button>
          <button
            aria-label={imageActionLabel("moveLater", index)}
            className="quiet-button"
            data-media-action="moveLater"
            disabled={!availability.moveLater}
            onClick={handleMoveLater}
            type="button"
          >
            Para depois
          </button>
          <button
            aria-label={imageActionLabel("replace", index)}
            className="quiet-button"
            data-media-action="replace"
            disabled={!availability.replace}
            onClick={handleAskReplace}
            type="button"
          >
            Substituir
          </button>
          <button
            aria-label={imageActionLabel("remove", index)}
            className="danger-text-button"
            data-media-action="remove"
            disabled={!availability.remove}
            onClick={handleAskRemove}
            type="button"
          >
            Remover
          </button>
        </fieldset>
      )}
    </li>
  );
}

function ProductMediaList({
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
}: {
  assets: ProductMediaAssetReadModel[];
  busy: boolean;
  confirm: ConfirmRequest | null;
  onAsk: (assetId: string, kind: ConfirmKind) => void;
  onConfirm: (assetId: string, kind: ConfirmKind) => void;
  onKeep: (assetId: string, kind: ConfirmKind) => void;
  onMove: (assetId: string, direction: MoveDirection) => void;
  organizationId: string;
  productName: string;
  running: RunningCommand | null;
}) {
  if (assets.length === 0) {
    return (
      <p className="product-empty-state">Ainda não há imagens neste produto.</p>
    );
  }

  return (
    <ul aria-busy={busy} className="product-media-list">
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

export function ProductMediaPanel({
  onClose,
  organizationId,
  product,
}: ProductMediaPanelProps) {
  const [assets, setAssets] = useState<ProductMediaAssetReadModel[]>([]);
  const [variants, setVariants] =
    useState<ProductVariantConfigurationReadModel | null>(null);
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([]);
  const [preparedFile, setPreparedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDimensions, setPreviewDimensions] =
    useState<ImageDimensions | null>(null);
  const [crop, setCrop] = useState<NormalizedMediaCropRect>(fullImageCrop);
  const [dragStart, setDragStart] = useState<CropPoint | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [cropAnnouncement, setCropAnnouncement] = useState("");
  const [uploadCommandId, setUploadCommandId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [running, setRunning] = useState<RunningCommand | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [replacementPending, setReplacementPending] = useState(false);
  const fileSelectionGeneration = useRef(0);
  const assetsVersion = useRef(0);
  const commandLock = useRef<boolean>(false);
  const focusRequest = useRef<FocusRequest | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const imagesBusy = running !== null || isUploading;

  const availableVariants =
    variants?.variants.filter((variant) => !variant.isDefault) ?? [];

  const loadAssets = useCallback(
    async (quiet = false) => {
      assetsVersion.current += 1;
      const version = assetsVersion.current;
      if (!quiet) {
        setIsLoading(true);
      }
      try {
        const result = await listProductMedia({
          organizationId,
          productId: product.id,
        });
        // A newer list, or the answer of a command, already replaced this one.
        if (version === assetsVersion.current) {
          setAssets(result.media);
          if (!quiet) {
            setError(null);
          }
        }
      } catch (cause: unknown) {
        if (version === assetsVersion.current) {
          setError(mediaFailure("list", cause).message);
        }
      } finally {
        if (!quiet) {
          setIsLoading(false);
        }
      }
    },
    [organizationId, product.id]
  );

  useEffect(() => {
    loadAssets();
  }, [loadAssets, reloadVersion]);

  // Moves focus after a command or a confirmation step, once the buttons it
  // targets are enabled again (a disabled button cannot take focus).
  useEffect(() => {
    const request = focusRequest.current;
    if (!request || running !== null) {
      return;
    }
    focusRequest.current = null;
    if (request.type === "file") {
      fileInputRef.current?.focus();
      fileInputRef.current?.scrollIntoView?.({ block: "center" });
    } else if (request.type === "heading") {
      listHeadingRef.current?.focus();
    } else if (request.type === "keep") {
      panelRef.current
        ?.querySelector<HTMLElement>(
          `[data-asset-id="${request.assetId}"] [data-media-action="keep"]`
        )
        ?.focus();
    } else {
      for (const action of request.fallbacks) {
        const target = panelRef.current?.querySelector<HTMLButtonElement>(
          `[data-asset-id="${request.assetId}"] [data-media-action="${action}"]`
        );
        if (target && !target.disabled) {
          target.focus();
          return;
        }
      }
    }
  });

  const failCommand = useCallback(
    (context: MediaFailureContext, cause: unknown) => {
      const failure = mediaFailure(context, cause);
      setError(failure.message);
      if (failure.reloadList) {
        loadAssets(true);
      }
    },
    [loadAssets]
  );

  useEffect(
    () => () => {
      fileSelectionGeneration.current += 1;
    },
    []
  );

  useEffect(() => {
    let current = true;
    orpcClient.product
      .getVariants({ id: product.id, organizationId })
      .then((result) => {
        if (current) {
          setVariants(result);
        }
      })
      .catch(() => {
        if (current) {
          setVariants(null);
        }
      });
    return () => {
      current = false;
    };
  }, [organizationId, product.id]);

  useEffect(
    () => () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    },
    [previewUrl]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selected = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!selected) {
        return;
      }

      fileSelectionGeneration.current += 1;
      const generation = fileSelectionGeneration.current;
      setPreparedFile(null);
      setPreviewUrl(null);
      setPreviewDimensions(null);
      setUploadCommandId(null);
      setError(null);
      setNotice(null);
      setIsPreparing(true);
      try {
        const file = await prepareMediaUploadFile(selected);
        if (generation !== fileSelectionGeneration.current) {
          return;
        }
        const objectUrl = URL.createObjectURL(file);
        let dimensions: ImageDimensions;
        try {
          dimensions = await readImageDimensions(objectUrl);
        } catch (cause: unknown) {
          URL.revokeObjectURL(objectUrl);
          throw cause;
        }
        if (generation !== fileSelectionGeneration.current) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPreparedFile(file);
        setPreviewUrl(objectUrl);
        setPreviewDimensions(dimensions);
        setCrop(fullImageCrop);
        setSelectedVariantIds([]);
        setUploadCommandId(crypto.randomUUID());
      } catch (cause: unknown) {
        if (generation !== fileSelectionGeneration.current) {
          return;
        }
        setPreparedFile(null);
        setPreviewUrl(null);
        setPreviewDimensions(null);
        setUploadCommandId(null);
        setError(mediaFailure("prepare", cause).message);
      } finally {
        if (generation === fileSelectionGeneration.current) {
          setIsPreparing(false);
        }
      }
    },
    []
  );

  const normalizedPointer = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return { clientX: event.clientX, clientY: event.clientY, x: 0, y: 0 };
      }
      return {
        clientX: event.clientX,
        clientY: event.clientY,
        x: clamp((event.clientX - bounds.left) / bounds.width),
        y: clamp((event.clientY - bounds.top) / bounds.height),
      };
    },
    []
  );

  const handleCropPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (isUploading || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = normalizedPointer(event);
      setDragStart(point);
      setCrop({ height: 0.001, width: 0.001, x: point.x, y: point.y });
      setUploadCommandId(crypto.randomUUID());
    },
    [isUploading, normalizedPointer]
  );

  const handleCropPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (dragStart && !isUploading) {
        setCrop(cropFromDrag(dragStart, normalizedPointer(event)));
      }
    },
    [dragStart, isUploading, normalizedPointer]
  );

  const handleCropPointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (dragStart && !isUploading) {
        const end = normalizedPointer(event);
        const moved = Math.hypot(
          end.clientX - dragStart.clientX,
          end.clientY - dragStart.clientY
        );
        const selection = cropFromDrag(dragStart, end);
        setCrop(
          moved < 4 || selection.width < 0.005 || selection.height < 0.005
            ? fullImageCrop
            : selection
        );
        setDragStart(null);
        setUploadCommandId(crypto.randomUUID());
      }
    },
    [dragStart, isUploading, normalizedPointer]
  );

  const handleUseFullImage = useCallback(() => {
    setCrop(fullImageCrop);
    setUploadCommandId(crypto.randomUUID());
  }, []);

  const handleCropPointerCancel = useCallback(() => {
    setDragStart(null);
    setCrop(fullImageCrop);
  }, []);

  const handleCropPreviewKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (isUploading || !cropArrowKeys.has(event.key)) {
        return;
      }
      event.preventDefault();
      setCrop((current) => {
        const next = adjustCropWithKey(current, event.key, {
          alt: event.altKey,
          shift: event.shiftKey,
        });
        setCropAnnouncement(describeCrop(next));
        return next;
      });
      setUploadCommandId(crypto.randomUUID());
    },
    [isUploading]
  );
  const handleToggleAdjusting = useCallback(
    () => setAdjusting((current) => !current),
    []
  );

  const handleVariantToggle = useCallback((variantId: string) => {
    setUploadCommandId(crypto.randomUUID());
    setSelectedVariantIds((current) => {
      const next = current.includes(variantId)
        ? current.filter((value) => value !== variantId)
        : [...current, variantId];
      return next;
    });
  }, []);

  const handleVariantChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { variantId } = event.currentTarget.dataset;
      if (variantId) {
        handleVariantToggle(variantId);
      }
    },
    [handleVariantToggle]
  );

  const handleUpload = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!preparedFile || imagesBusy) {
        return;
      }

      setIsUploading(true);
      setError(null);
      setNotice(null);
      const commandId = uploadCommandId ?? crypto.randomUUID();
      setUploadCommandId(commandId);
      try {
        await uploadProductMedia({
          crop,
          file: preparedFile,
          organizationId,
          productId: product.id,
          uploadCommandId: commandId,
          variantIds: selectedVariantIds,
        });
        setNotice(
          replacementPending
            ? replacementDoneText
            : "Imagem adicionada ao produto."
        );
        setReplacementPending(false);
        setPreparedFile(null);
        setPreviewUrl(null);
        setPreviewDimensions(null);
        setSelectedVariantIds([]);
        setUploadCommandId(null);
        setReloadVersion((version) => version + 1);
      } catch (cause: unknown) {
        failCommand("upload", cause);
      } finally {
        setIsUploading(false);
      }
    },
    [
      crop,
      failCommand,
      imagesBusy,
      organizationId,
      preparedFile,
      product.id,
      replacementPending,
      selectedVariantIds,
      uploadCommandId,
    ]
  );

  const handleMove = useCallback(
    async (assetId: string, direction: MoveDirection) => {
      if (commandLock.current || isUploading) {
        return;
      }
      const index = assets.findIndex((asset) => asset.assetId === assetId);
      const order = movedAssetOrder(
        assets.map((asset) => asset.assetId),
        index,
        direction
      );
      if (!order) {
        return;
      }
      commandLock.current = true;
      setRunning({ assetId, kind: "move" });
      setConfirm(null);
      setError(null);
      setNotice(null);
      focusRequest.current = {
        assetId,
        fallbacks:
          direction === "earlier"
            ? ["moveEarlier", "moveLater"]
            : ["moveLater", "moveEarlier"],
        type: "item",
      };
      try {
        const result = await reorderProductMedia({
          assetIds: order,
          organizationId,
          productId: product.id,
        });
        assetsVersion.current += 1;
        setAssets(result.media);
        const to = result.media.findIndex((asset) => asset.assetId === assetId);
        setNotice(movedNotice({ from: index + 1, to: to + 1 }));
      } catch (cause: unknown) {
        failCommand("reorder", cause);
      } finally {
        commandLock.current = false;
        setRunning(null);
      }
    },
    [assets, failCommand, isUploading, organizationId, product.id]
  );

  const handleAsk = useCallback(
    (assetId: string, kind: ConfirmKind) => {
      if (commandLock.current || isUploading) {
        return;
      }
      setError(null);
      setNotice(null);
      setConfirm({ assetId, kind });
      focusRequest.current = { assetId, type: "keep" };
    },
    [isUploading]
  );

  const handleKeep = useCallback((assetId: string, kind: ConfirmKind) => {
    if (commandLock.current) {
      return;
    }
    setConfirm(null);
    focusRequest.current = { assetId, fallbacks: [kind], type: "item" };
  }, []);

  const handleConfirm = useCallback(
    async (assetId: string, kind: ConfirmKind) => {
      if (commandLock.current || isUploading) {
        return;
      }
      const position = assets.findIndex((asset) => asset.assetId === assetId);
      commandLock.current = true;
      setRunning({ assetId, kind });
      setError(null);
      setNotice(null);
      try {
        const result = await removeProductMedia({
          assetId,
          organizationId,
          productId: product.id,
        });
        // Removing is idempotent: "already gone" leaves the same list.
        assetsVersion.current += 1;
        setAssets((current) =>
          current.filter((asset) => asset.assetId !== assetId)
        );
        if (kind === "replace") {
          setReplacementPending(true);
          focusRequest.current = { type: "file" };
        } else {
          setNotice(removedNotice(result.removed, position + 1));
          focusRequest.current = { type: "heading" };
        }
        loadAssets(true);
      } catch (cause: unknown) {
        failCommand("remove", cause);
        focusRequest.current = { assetId, fallbacks: [kind], type: "item" };
      } finally {
        commandLock.current = false;
        setConfirm(null);
        setRunning(null);
      }
    },
    [assets, failCommand, isUploading, loadAssets, organizationId, product.id]
  );

  const handleAbandonReplacement = useCallback(() => {
    fileSelectionGeneration.current += 1;
    setReplacementPending(false);
    setPreparedFile(null);
    setPreviewUrl(null);
    setPreviewDimensions(null);
    setUploadCommandId(null);
    setIsPreparing(false);
    setError(null);
    setNotice(replacementAbandonedText);
  }, []);

  const cropStyle = {
    height: `${crop.height * 100}%`,
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
  };
  let uploadButtonLabel = "Enviar imagem";
  if (isPreparing) {
    uploadButtonLabel = "Preparando…";
  }
  if (isUploading) {
    uploadButtonLabel = "Processando…";
  }

  return (
    <section
      aria-labelledby="product-media-heading"
      className="product-form-panel product-media-panel"
      ref={panelRef}
    >
      <div className="product-form-heading">
        <div>
          <p className="categories-eyebrow">Imagens do produto</p>
          <h2 id="product-media-heading">{product.name}</h2>
        </div>
        <button className="quiet-button" onClick={onClose} type="button">
          Fechar
        </button>
      </div>

      <div className="product-media-content">
        {error ? (
          <p className="categories-message is-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="categories-message is-success" role="status">
            {notice}
          </p>
        ) : null}

        {replacementPending ? (
          <div className="product-media-replacement" role="status">
            <p>{replacementPendingText}</p>
            <button
              className="quiet-button"
              disabled={isUploading}
              onClick={handleAbandonReplacement}
              type="button"
            >
              Desistir da substituição
            </button>
          </div>
        ) : null}

        <form className="product-media-upload" onSubmit={handleUpload}>
          <div className="product-form-field">
            <label className="field-label" htmlFor="product-media-file">
              Escolher imagem
            </label>
            <input
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
              disabled={isPreparing || imagesBusy}
              id="product-media-file"
              onChange={handleFileChange}
              ref={fileInputRef}
              type="file"
            />
            <p className="field-help">
              JPEG, PNG e WebP; HEIC do iPhone é convertido neste dispositivo.
              Até 20 MB.
            </p>
          </div>

          {isPreparing ? (
            <p className="field-help" role="status">
              Preparando a imagem para recorte…
            </p>
          ) : null}

          {previewUrl ? (
            <div className="product-media-crop-field">
              <div className="product-media-crop-heading">
                <div>
                  <p className="field-label">Recorte</p>
                  <p className="field-help">
                    Arraste sobre a imagem para escolher uma área. Com o
                    teclado, as setas aumentam ou diminuem o recorte a partir do
                    canto inferior direito; com Alt, a partir do canto superior
                    esquerdo; com Shift, movem a área. Um toque sem arraste
                    mantém a imagem inteira.
                  </p>
                </div>
                <div className="product-media-crop-actions">
                  <button
                    aria-pressed={adjusting}
                    className="quiet-button"
                    disabled={isUploading}
                    onClick={handleToggleAdjusting}
                    type="button"
                  >
                    {adjusting ? "Concluir ajuste" : "Ajustar com o dedo"}
                  </button>
                  <button
                    className="quiet-button"
                    disabled={isUploading}
                    onClick={handleUseFullImage}
                    type="button"
                  >
                    Imagem inteira
                  </button>
                </div>
              </div>
              <div className="product-media-crop-stage">
                <button
                  aria-describedby="product-media-crop-help product-media-crop-state"
                  aria-label="Área de recorte. Arraste ou use as setas para ajustar."
                  className={
                    adjusting
                      ? "product-media-crop-frame is-adjusting"
                      : "product-media-crop-frame"
                  }
                  onKeyDown={handleCropPreviewKeyDown}
                  onPointerCancel={handleCropPointerCancel}
                  onPointerDown={handleCropPointerDown}
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={handleCropPointerUp}
                  type="button"
                >
                  <img
                    alt=""
                    className="product-media-crop-preview"
                    draggable={false}
                    height={previewDimensions?.height}
                    src={previewUrl}
                    width={previewDimensions?.width}
                  />
                  <span
                    aria-hidden="true"
                    className="product-media-crop-selection"
                    style={cropStyle}
                  />
                </button>
              </div>
              <p
                aria-live="polite"
                className="field-help"
                id="product-media-crop-state"
                role="status"
              >
                {cropAnnouncement || describeCrop(crop)}
              </p>
              <p className="field-help" id="product-media-crop-help">
                Saída WebP, proporção preservada e dimensão máxima de 1200 px
                sem ampliação.
              </p>
            </div>
          ) : null}

          {availableVariants.length > 0 ? (
            <fieldset className="product-media-variants">
              <legend className="field-label">
                Associar também às variantes
              </legend>
              <p className="field-help">
                A imagem continua vinculada ao produto e pode ser reutilizada
                nas variantes marcadas.
              </p>
              <div className="product-media-variant-options">
                {availableVariants.map((variant) => (
                  <label
                    className="product-media-variant-option"
                    key={variant.id}
                  >
                    <input
                      checked={selectedVariantIds.includes(variant.id)}
                      data-variant-id={variant.id}
                      disabled={isUploading}
                      onChange={handleVariantChange}
                      type="checkbox"
                    />
                    <span>{variantLabel(variant)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {availableVariants.length === 0 && variants?.configured === false ? (
            <p className="field-help">
              Configure as variantes do produto para associar imagens a
              combinações específicas.
            </p>
          ) : null}

          <div className="product-form-actions">
            <button
              className="primary-button"
              disabled={!preparedFile || isPreparing || imagesBusy}
              type="submit"
            >
              {uploadButtonLabel}
            </button>
          </div>
        </form>

        <section aria-labelledby="product-media-list-heading">
          <h3
            className="product-media-list-heading"
            id="product-media-list-heading"
            ref={listHeadingRef}
            tabIndex={-1}
          >
            Imagens associadas
          </h3>
          {isLoading ? (
            <p className="product-empty-state" role="status">
              Carregando imagens…
            </p>
          ) : (
            <ProductMediaList
              assets={assets}
              busy={imagesBusy}
              confirm={confirm}
              onAsk={handleAsk}
              onConfirm={handleConfirm}
              onKeep={handleKeep}
              onMove={handleMove}
              organizationId={organizationId}
              productName={product.name}
              running={running}
            />
          )}
        </section>
      </div>
    </section>
  );
}
