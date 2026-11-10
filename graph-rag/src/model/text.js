// Small text helpers every stream shares. Pure.

/** "Credit limit" / "creditLimit" / "credit-limit" -> "credit_limit": a class or column name as a map key */
export const snakeCase = (a) =>
  String(a ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

/** a name for matching: case and punctuation dropped */
export const normalizeName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** a date (ISO, or YYYY-MM-DD, a Date, a number) -> ISO, or null when unusable; no zone given is UTC */
export function isoDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v).toISOString() : null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00.000Z` : withZone.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

/** whitespace collapsed, cut to `max` */
export const clip = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** an error that names the field (a path into the object) it is about */
export class ShapeError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = "ShapeError";
    this.field = field;
    this.reason = message;
  }
}
