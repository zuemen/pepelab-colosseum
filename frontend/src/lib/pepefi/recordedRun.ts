/** ①a → 1a: the monospace font used for step labels has no circled digits and renders them as dots. */
export function plainStep(n: string): string {
  return n.replace(/[①-⑳]/g, (c) => String(c.charCodeAt(0) - 0x2460 + 1))
}
