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
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldDescription, FieldLegend, FieldSet } from "@/ui/field";
import { Label } from "@/ui/label";
import { markLegalAcceptanceRequired } from "../lib/legal-acceptance";
import {
  listProductMedia,
  prepareMediaUploadFile,
  removeProductMedia,
  reorderProductMedia,
  uploadProductMedia,
} from "../lib/media-upload";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import { endSessionHere } from "../offline/runtime/session-ended";
import {
  LimitHelp,
  useLimitFocus,
  useLimitHelp,
} from "../subscription/limit-help";
import {
  describeMediaFailure,
  isMediaLegalAcceptanceRequired,
  isMediaSessionEnded,
  type MediaFailure,
  type MediaFailureContext,
  type MoveDirection,
  movedAssetOrder,
  movedNotice,
  PRODUCT_IMAGES_LIMIT_REACHED,
  removedNotice,
  replacementAbandonedText,
  replacementDoneText,
  replacementPendingText,
  STORE_IMAGES_LIMIT_REACHED,
} from "./media-commands-model";
import {
  adjustCropWithKey,
  cropArrowKeys,
  describeCrop,
} from "./media-crop-model";
import { ProductMediaCropField } from "./product-media-crop";
import { ProductMediaFilePicker } from "./product-media-file-picker";
import {
  type ConfirmKind,
  type ConfirmRequest,
  ProductMediaList,
  type RunningCommand,
} from "./product-media-list";

interface ProductMediaPanelProps {
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
  if (isMediaSessionEnded(error)) {
    // media calls are plain fetches, not oRPC: tell the shell here that the session is over, as the oRPC client does
    endSessionHere();
  } else if (isMediaLegalAcceptanceRequired(error)) {
    // not a refused session: the shell shows the fixed notice with `/aceite`, as the oRPC client does
    markLegalAcceptanceRequired();
  }
  return describeMediaFailure(context, error);
}

/** The text on screen is a refusal by the plan's limit: the way to the Pro goes with it, only while it shows. */
function isImageLimitText(error: string): boolean {
  return (
    error === STORE_IMAGES_LIMIT_REACHED ||
    error === PRODUCT_IMAGES_LIMIT_REACHED
  );
}

function variantLabel(variant: {
  isDefault: boolean;
  values: Array<{ optionValueName: string }>;
}): string {
  const values = variant.values.map((value) => value.optionValueName);
  return values.length > 0 ? values.join(" / ") : "Variante padrão";
}

type FocusRequest =
  | { assetId: string; fallbacks: readonly string[]; type: "item" }
  | { assetId: string; type: "keep" }
  | { type: "file" }
  | { type: "heading" };

interface VariantOptionProps {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: (variantId: string) => void;
  variantId: string;
}

function VariantOption({
  checked,
  disabled,
  label,
  onToggle,
  variantId,
}: VariantOptionProps) {
  const handleChange = useCallback(
    () => onToggle(variantId),
    [onToggle, variantId]
  );
  return (
    <Label className="min-h-ctl-md rounded-md border border-border px-3">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleChange}
      />
      <span className="[overflow-wrap:anywhere]">{label}</span>
    </Label>
  );
}

/** The tab "Imagens" of the product dialog: sending, cutting and ordering the images, each command on its own. */
export function ProductMediaPanel({
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
  // the plan's limit refused the image (L2, L3 of the corte 1.6): the way to the Pro goes with the text, which takes
  // the focus; the picked photo stays, to send once a place is free
  const limitHelp = useLimitHelp();
  const errorRef = useRef<HTMLDivElement | null>(null);
  const focusLimit = useLimitFocus(errorRef);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [running, setRunning] = useState<RunningCommand | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [replacementPending, setReplacementPending] = useState(false);
  // a photo picked and prepared that was not sent yet
  useReportUnsentWork(preparedFile !== null);
  const fileSelectionGeneration = useRef(0);
  const assetsVersion = useRef(0);
  const commandLock = useRef<boolean>(false);
  const focusRequest = useRef<FocusRequest | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileButtonRef = useRef<HTMLButtonElement | null>(null);
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
            setLoadError(null);
          }
        }
      } catch (cause: unknown) {
        if (version === assetsVersion.current) {
          const { message } = mediaFailure("list", cause);
          // the first read that fails is not an empty list: it says why and offers "Tentar novamente"
          if (quiet) {
            setError(message);
          } else {
            setLoadError(message);
          }
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
      fileButtonRef.current?.focus();
      fileButtonRef.current?.scrollIntoView?.({ block: "center" });
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
      if (failure.limit) {
        limitHelp.show(failure.limit);
        focusLimit();
      }
      if (failure.reloadList) {
        loadAssets(true);
      }
    },
    [focusLimit, limitHelp.show, loadAssets]
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

  const handleReload = useCallback(
    () => setReloadVersion((version) => version + 1),
    []
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

  let uploadButtonLabel = "Enviar imagem";
  if (isPreparing) {
    uploadButtonLabel = "Preparando…";
  }
  if (isUploading) {
    uploadButtonLabel = "Processando…";
  }

  let list: ReactNode;
  if (isLoading) {
    list = (
      <p className="text-muted-foreground text-support" role="status">
        Carregando imagens…
      </p>
    );
  } else if (loadError) {
    list = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {loadError}
          <Button onClick={handleReload} size="sm" type="button" variant="link">
            Tentar novamente
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else {
    list = (
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
    );
  }

  return (
    <div className="grid gap-4" ref={panelRef}>
      {error ? (
        <Alert ref={errorRef} tabIndex={-1} variant="destructive">
          <AlertDescription>
            {error}
            <LimitHelp help={limitHelp.help} shown={isImageLimitText(error)} />
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CircleCheckIcon aria-hidden="true" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {replacementPending ? (
        <Alert variant="warning">
          <AlertDescription className="grid justify-items-start gap-3">
            {replacementPendingText}
            <Button
              disabled={isUploading}
              onClick={handleAbandonReplacement}
              type="button"
              variant="outline"
            >
              Desistir da substituição
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <form className="grid gap-4" onSubmit={handleUpload}>
        <Field>
          <ProductMediaFilePicker
            buttonRef={fileButtonRef}
            disabled={isPreparing || imagesBusy}
            fileName={
              isPreparing ? "Preparando…" : (preparedFile?.name ?? null)
            }
            inputRef={fileInputRef}
            onChange={handleFileChange}
          />
          <FieldDescription>
            JPEG, PNG e WebP; HEIC do iPhone é convertido neste aparelho. Até 20
            MB.
          </FieldDescription>
        </Field>

        {isPreparing ? (
          <p className="text-muted-foreground text-support" role="status">
            Preparando a imagem para recorte…
          </p>
        ) : null}

        {previewUrl ? (
          <ProductMediaCropField
            adjusting={adjusting}
            announcement={cropAnnouncement}
            crop={crop}
            dimensions={previewDimensions}
            disabled={isUploading}
            onKeyDown={handleCropPreviewKeyDown}
            onPointerCancel={handleCropPointerCancel}
            onPointerDown={handleCropPointerDown}
            onPointerMove={handleCropPointerMove}
            onPointerUp={handleCropPointerUp}
            onToggleAdjusting={handleToggleAdjusting}
            onUseFullImage={handleUseFullImage}
            previewUrl={previewUrl}
          />
        ) : null}

        {availableVariants.length > 0 ? (
          <FieldSet>
            <div className="grid gap-0.5">
              <FieldLegend className="mb-0" variant="label">
                Associar também às variantes
              </FieldLegend>
              <FieldDescription>
                A imagem continua no produto e também aparece nas variantes
                marcadas.
              </FieldDescription>
            </div>
            <div className="flex flex-wrap gap-3">
              {availableVariants.map((variant) => (
                <VariantOption
                  checked={selectedVariantIds.includes(variant.id)}
                  disabled={isUploading}
                  key={variant.id}
                  label={variantLabel(variant)}
                  onToggle={handleVariantToggle}
                  variantId={variant.id}
                />
              ))}
            </div>
          </FieldSet>
        ) : null}
        {availableVariants.length === 0 && variants?.configured === false ? (
          <p className="text-muted-foreground text-support">
            Configure as variantes do produto para associar imagens a
            combinações específicas.
          </p>
        ) : null}

        <div className="flex min-[30rem]:justify-end">
          <Button
            className="max-[29.99rem]:w-full"
            disabled={!preparedFile || isPreparing || imagesBusy}
            type="submit"
          >
            {uploadButtonLabel}
          </Button>
        </div>
      </form>

      <section
        aria-labelledby="product-media-list-heading"
        className="grid gap-3 border-border border-t pt-4"
      >
        <h3
          className="focus-ring text-section"
          id="product-media-list-heading"
          ref={listHeadingRef}
          tabIndex={-1}
        >
          Imagens associadas
        </h3>
        {list}
      </section>
    </div>
  );
}
