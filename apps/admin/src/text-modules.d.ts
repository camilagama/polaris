// The page's script and sheet, built by `build:ui` into src/ui/generated/ and bundled as Text modules (wrangler.jsonc).
declare module "*.txt" {
  const text: string;
  export default text;
}
