/** The sale does not exist in the caller's organization (or never existed). */
export class SaleNotFoundError extends Error {
  readonly code = "sale_not_found";

  constructor() {
    super("sale_not_found");
    this.name = "SaleNotFoundError";
  }
}
