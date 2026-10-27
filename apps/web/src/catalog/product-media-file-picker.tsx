import { type ChangeEvent, type Ref, useCallback, useRef } from "react";
import { Button } from "@/ui/button";

const MEDIA_FILE_ACCEPT =
  "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
const NO_IMAGE_CHOSEN = "Nenhuma imagem escolhida";

const FILE_NAME_ID = "product-media-file-name";

interface ProductMediaFilePickerProps {
  /** The button, for the focus that returns to the picker after a replacement starts. */
  buttonRef: Ref<HTMLButtonElement>;
  disabled: boolean;
  /** The file chosen and prepared, said beside the button; `null` before one is. */
  fileName: string | null;
  inputRef: Ref<HTMLInputElement>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * The native file control says "Choose file / No file chosen" in the language of the browser: the visible control is
 * ours, a button and the name of the file in Portuguese. The input stays out of the way (not focusable, not read) and
 * takes only the picker the button opens and the files the tests give it.
 */
export function ProductMediaFilePicker({
  buttonRef,
  disabled,
  fileName,
  inputRef,
  onChange,
}: ProductMediaFilePickerProps) {
  const ownInputRef = useRef<HTMLInputElement | null>(null);
  const setInput = useCallback(
    (element: HTMLInputElement | null) => {
      ownInputRef.current = element;
      if (typeof inputRef === "function") {
        inputRef(element);
      } else if (inputRef) {
        inputRef.current = element;
      }
    },
    [inputRef]
  );
  const handlePick = useCallback(() => ownInputRef.current?.click(), []);

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          aria-describedby={FILE_NAME_ID}
          disabled={disabled}
          onClick={handlePick}
          ref={buttonRef}
          type="button"
          variant="outline"
        >
          Escolher imagem
        </Button>
        <span
          className="min-w-0 text-muted-foreground text-support [overflow-wrap:anywhere]"
          id={FILE_NAME_ID}
        >
          {fileName ?? NO_IMAGE_CHOSEN}
        </span>
      </div>
      <input
        accept={MEDIA_FILE_ACCEPT}
        aria-hidden="true"
        aria-label="Escolher imagem"
        className="sr-only"
        disabled={disabled}
        id="product-media-file"
        onChange={onChange}
        ref={setInput}
        tabIndex={-1}
        type="file"
      />
    </>
  );
}
