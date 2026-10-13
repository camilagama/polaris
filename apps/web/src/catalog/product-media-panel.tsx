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
  MediaUploadHttpError,
  prepareMediaUploadFile,
  productMediaAssetUrl,
  uploadProductMedia,
} from "../lib/media-upload";
import { orpcClient } from "../lib/orpc";
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

function mediaErrorMessage(error: unknown): string {
  if (error instanceof MediaImageTooLargeError) {
    return "A imagem original ultrapassa 20 MB. Escolha um arquivo menor.";
  }
  if (error instanceof UnsupportedMediaImageError) {
    return "Não foi possível ler este arquivo. Use JPEG, PNG, WebP ou HEIC.";
  }
  if (error instanceof InvalidMediaCropError) {
    return "A área de recorte não é válida. Selecione uma área maior.";
  }
  if (error instanceof MediaUploadHttpError) {
    switch (error.code) {
      case "forbidden":
      case "tenant_access_denied":
        return "Sua conta não tem permissão para alterar este produto.";
      case "media_image_too_large":
        return "A imagem original ultrapassa 20 MB. Escolha um arquivo menor.";
      case "unsupported_media_image":
        return "O arquivo não é uma imagem JPEG, PNG ou WebP válida.";
      case "invalid_media_crop":
        return "A área de recorte não é válida. Ajuste a seleção e tente novamente.";
      case "media_upload_command_conflict":
        return "A tentativa de envio mudou. Selecione a imagem novamente para tentar de novo.";
      case "media_processing_unavailable":
        return "O processamento de imagens está indisponível. Tente novamente.";
      default:
        return "Não foi possível carregar a imagem. Tente novamente.";
    }
  }
  return "Não foi possível preparar a imagem. Escolha outro arquivo e tente novamente.";
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

function ProductMediaList({
  assets,
  organizationId,
  productName,
}: {
  assets: ProductMediaAssetReadModel[];
  organizationId: string;
  productName: string;
}) {
  if (assets.length === 0) {
    return (
      <p className="product-empty-state">Ainda não há imagens neste produto.</p>
    );
  }

  return (
    <ul className="product-media-list">
      {assets.map((asset, index) => (
        <li className="product-media-item" key={asset.assetId}>
          <img
            alt={`${productName}, imagem ${index + 1}`}
            height={asset.height}
            loading="lazy"
            src={productMediaAssetUrl(asset, organizationId, undefined, 320)}
            width={asset.width}
          />
          <div className="product-media-item-copy">
            <p>Imagem {index + 1}</p>
            <span>
              {asset.width} × {asset.height} · {formatBytes(asset.byteSize)}
            </span>
            {asset.variantIds.length > 0 ? (
              <span>
                Associada a {asset.variantIds.length}{" "}
                {asset.variantIds.length === 1 ? "variante" : "variantes"}
              </span>
            ) : null}
          </div>
        </li>
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
  const fileSelectionGeneration = useRef(0);

  const availableVariants =
    variants?.variants.filter((variant) => !variant.isDefault) ?? [];

  const loadAssets = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await listProductMedia({
        organizationId,
        productId: product.id,
      });
      setAssets(result.media);
      setError(null);
    } catch (cause: unknown) {
      setError(mediaErrorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, product.id]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets, reloadVersion]);

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
        setError(mediaErrorMessage(cause));
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
      if (!preparedFile || isUploading) {
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
        setNotice("Imagem adicionada ao produto.");
        setPreparedFile(null);
        setPreviewUrl(null);
        setPreviewDimensions(null);
        setSelectedVariantIds([]);
        setUploadCommandId(null);
        setReloadVersion((version) => version + 1);
      } catch (cause: unknown) {
        setError(mediaErrorMessage(cause));
      } finally {
        setIsUploading(false);
      }
    },
    [
      crop,
      isUploading,
      organizationId,
      preparedFile,
      product.id,
      selectedVariantIds,
      uploadCommandId,
    ]
  );

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

        <form className="product-media-upload" onSubmit={handleUpload}>
          <div className="product-form-field">
            <label className="field-label" htmlFor="product-media-file">
              Escolher imagem
            </label>
            <input
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
              disabled={isPreparing || isUploading}
              id="product-media-file"
              onChange={handleFileChange}
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
              disabled={!preparedFile || isPreparing || isUploading}
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
              organizationId={organizationId}
              productName={product.name}
            />
          )}
        </section>
      </div>
    </section>
  );
}
