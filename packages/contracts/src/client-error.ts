import { z } from "zod";
import {
  CLIENT_ERROR_BOUNDARIES,
  CLIENT_ERROR_EVENT_VERSION,
  CLIENT_ERROR_FRAME_PATTERN,
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_MAX_FRAMES,
  CLIENT_ERROR_NAMES,
  CLIENT_ERROR_RELEASE_PATTERN,
  CLIENT_ERROR_ROUTE_IDS,
  CLIENT_ERROR_RPC_CODES,
  type ClientErrorEvent,
} from "./client-error-fields";

// The same setting as the contract of `/rpc` (index.ts): no `new Function` probe under the CSP.
z.config({ jitless: true });

/**
 * The report of an error of the app in the browser, checked again on the server. Strict: a key outside this list,
 * a word outside its list or a frame outside its pattern refuses the whole event, and nothing is corrected.
 *
 * The event is anonymous by construction: it has no field of a store (organization, product, sale, customer) and
 * none of a person (user, session, device, address, user agent), and that is why it is out of the export, of the
 * requests of the data subject and of the purge (docs/business-rules/privacy.md). A field with the id of a store or
 * of a person makes it personal data: it needs a new privacy review (export, purge, retention) before it is added.
 */
export const clientErrorEventSchema: z.ZodType<ClientErrorEvent> = z
  .object({
    boundary: z.enum(CLIENT_ERROR_BOUNDARIES).optional(),
    code: z.enum(CLIENT_ERROR_RPC_CODES).optional(),
    errorName: z.enum(CLIENT_ERROR_NAMES),
    frames: z
      .array(z.string().max(96).regex(CLIENT_ERROR_FRAME_PATTERN))
      .max(CLIENT_ERROR_MAX_FRAMES)
      .optional(),
    kind: z.enum(CLIENT_ERROR_KINDS),
    release: z.string().regex(CLIENT_ERROR_RELEASE_PATTERN).optional(),
    routeId: z.enum(CLIENT_ERROR_ROUTE_IDS),
    status: z.number().int().min(400).max(599).optional(),
    v: z.literal(CLIENT_ERROR_EVENT_VERSION),
  })
  .strict();
