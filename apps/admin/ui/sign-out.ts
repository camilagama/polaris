/**
 * "Sair" is a plain link to the edge's logout of Cloudflare Access: a relative path of the Admin's own hostname that
 * the edge answers (`/cdn-cgi/*` never reaches the Worker). There is no route, script or call of the Admin behind it.
 */
export const SIGN_OUT_PATH = "/cdn-cgi/access/logout";
export const SIGN_OUT_LABEL = "Sair";
