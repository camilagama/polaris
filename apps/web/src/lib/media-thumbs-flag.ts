import { createContext, useContext } from "react";

/**
 * Whether the thumbnails of the lists are on for the store the page is in (`MEDIA_THUMBS_ENABLED`, as
 * `organization.listMine` said). `MediaThumbnailScope` provides it; outside it (a screen mounted alone, a lab) it is
 * off, so the rows draw what they drew before and ask for nothing. Kept apart from the organization context so a
 * list does not pull the RPC client in just to read a boolean.
 */
const MediaThumbsFlag = createContext(false);

export const MediaThumbsFlagProvider = MediaThumbsFlag.Provider;

export function useMediaThumbsEnabled(): boolean {
  return useContext(MediaThumbsFlag);
}
