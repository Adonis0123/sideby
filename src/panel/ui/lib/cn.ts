/** 拼类名，跳过 false / undefined。组件库只用 ui-* 类，不需要 tailwind-merge。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** HTML 版用：转义属性值和文字。 */
export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
