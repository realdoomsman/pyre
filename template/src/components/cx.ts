/** Joins class names, dropping falsy entries: `cx("a", cond && "b", className)`. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
