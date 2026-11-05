import { type Ref, useEffect, useState } from "react";

/**
 * A small square picture over a marker: the box (40 px with `rounded-md`, 32 px with `rounded-sm`) is reserved with
 * width, height and aspect ratio before any image, so it is the same with or without one; the marker (a short
 * text on `bg-muted`) is the base state and the picture, decoded first, is laid over it. A picture that does not
 * decode leaves the marker, with no icon, no error text and no warning border. The picture is decoration: the box
 * is hidden from assistive technology and the image has `alt=""` and no focus. It appears at once on a phone and
 * with `prefers-reduced-motion`, and fades in over 150 ms only at the `full` level of motion.
 */
export type ThumbnailSize = 32 | 40;

const BOX_CLASS: Record<ThumbnailSize, string> = {
  32: "size-8 rounded-sm",
  40: "size-10 rounded-md",
};

export interface ThumbnailProps {
  /** What the box says without a picture (two letters). */
  marker: string;
  /** The box, for whoever needs to know when it is on screen. */
  ref?: Ref<HTMLSpanElement>;
  size: ThumbnailSize;
  /** The picture, or `null` for the marker alone. */
  src: string | null;
}

export function Thumbnail({ marker, ref, size, src }: ThumbnailProps) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  useEffect(() => {
    if (!src || typeof Image === "undefined") {
      return;
    }
    let current = true;
    const probe = new Image();
    probe.src = src;
    // decoded off screen first: the picture then appears whole, never drawn in strips over the marker
    probe.decode().then(
      () => {
        if (current) {
          setLoaded(src);
        }
      },
      () => {
        if (current) {
          setBroken(src);
        }
      }
    );
    return () => {
      current = false;
    };
  }, [src]);

  const picture = src && src !== broken ? src : null;
  return (
    <span
      aria-hidden="true"
      className={`relative grid shrink-0 select-none place-items-center overflow-hidden bg-muted font-medium text-muted-foreground text-xs ${BOX_CLASS[size]}`}
      data-thumbnail={picture && loaded === picture ? "photo" : "marker"}
      ref={ref}
      style={{ aspectRatio: "1 / 1", height: size, width: size }}
    >
      {marker}
      {picture ? (
        <img
          alt=""
          className="absolute inset-0 size-full object-cover object-center opacity-0 motion-full:transition-opacity motion-full:duration-150 data-[loaded]:opacity-100"
          data-loaded={loaded === picture ? "" : undefined}
          decoding="async"
          draggable={false}
          height={size}
          src={picture}
          width={size}
        />
      ) : null}
    </span>
  );
}
