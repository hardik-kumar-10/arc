/**
 * Read a single dynamic route param. Next resolves a catch-all-free segment to a string, but the
 * pipeline types params as `string | string[]`; this collapses the array case and missing case.
 */
export function oneParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
