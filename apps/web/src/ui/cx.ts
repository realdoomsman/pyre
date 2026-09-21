/** Joins class names, dropping falsy entries. */
export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");
