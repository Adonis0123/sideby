import { cn, esc } from "../lib/cn.ts";

export const CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

export type MenuEntry =
  | {
      type?: "item";
      label: string;
      /** 前置图标，已拼好的 svg */
      icon?: string;
      /** 右侧快捷键，例如 "⌘K" */
      shortcut?: string;
      /** 右侧次要文字，例如日期 "11-04"：灰字、等宽数字、不换行 */
      meta?: string;
      danger?: boolean;
      disabled?: boolean;
      /** 给了就是勾选项（menuitemcheckbox），点了切换、不关菜单 */
      checked?: boolean;
      /** 单选项（menuitemradio）：同一菜单（或同一 role="group"）里只有一项 checked；点了选中它并关菜单 */
      radio?: boolean;
      attrs?: string;
      /** 只给状态矩阵定格展示用 */
      force?: "hover" | "active" | "focus" | "disabled" | "checked";
    }
  | { type: "label"; label: string }
  | { type: "separator" };

/** 一个菜单项。menuId 给了就点完关闭菜单（浏览器原生 popovertargetaction="hide"）。 */
export function menuItem(e: Extract<MenuEntry, { label: string; type?: "item" }>, menuId?: string): string {
  const isRadio = !!e.radio;
  const isCheck = isRadio || e.checked !== undefined;
  const a = [
    'type="button"',
    `role="${isRadio ? "menuitemradio" : isCheck ? "menuitemcheckbox" : "menuitem"}"`,
    `class="${cn("ui-menu-item", e.danger && "ui-menu-item-danger", isCheck && "ui-menu-item-inset")}"`,
    isCheck && `aria-checked="${!!e.checked}"`,
    (!isCheck || isRadio) && menuId && `popovertarget="${esc(menuId)}" popovertargetaction="hide"`,
    e.disabled && "disabled",
    e.force && `data-force="${e.force}"`,
    e.attrs,
  ].filter(Boolean);
  const ind = isCheck ? `<span class="ui-menu-indicator">${CHECK}</span>` : "";
  const meta = e.meta ? `<span class="ui-menu-meta">${esc(e.meta)}</span>` : "";
  const sc = e.shortcut ? `<kbd class="ui-menu-shortcut">${esc(e.shortcut)}</kbd>` : "";
  return `<button ${a.join(" ")}>${ind}${e.icon ?? ""}<span class="ui-menu-text">${esc(e.label)}</span>${meta}${sc}</button>`;
}

export interface MenuOptions {
  id: string;
  items: MenuEntry[];
  /** 读屏软件念的菜单名 */
  label?: string;
  className?: string;
  /** 菜单宽度，CSS 长度，例如 "360px"、"min(420px, 90vw)"；不给就随内容（至少 180px） */
  width?: string;
}

/** 菜单本体：popover 元素。触发按钮的 attrs 用 menuTrigger(id)。 */
export function menu(o: MenuOptions): string {
  const body = o.items
    .map((e) =>
      e.type === "separator" ? '<hr class="ui-menu-separator" role="separator">' : e.type === "label" ? `<div class="ui-menu-label" role="presentation">${esc(e.label)}</div>` : menuItem(e, o.id),
    )
    .join("");
  const width = o.width ? ` style="width: ${esc(o.width)}"` : "";
  return `<div popover id="${esc(o.id)}" role="menu" class="${cn("ui-menu", o.className)}"${o.label ? ` aria-label="${esc(o.label)}"` : ""}${width}>${body}</div>`;
}

/** 放在按钮的 attrs 里：点击开关菜单。Esc、点外面关闭由浏览器负责。 */
export const menuTrigger = (id: string) => `popovertarget="${esc(id)}" aria-haspopup="menu"`;

/**
 * 可选的几行 JS（放进 <script>）：打开时聚焦选中的单选项（并滚进可视区），没有就聚焦第一项；↑↓ Home End 移动焦点；
 * 勾选项点击切换 aria-checked，单选项点击选中自己、取消同组其他项。不加也能用：Tab 在菜单项间移动，Esc 关闭。
 */
export const menuScript = `document.addEventListener("toggle",e=>{if(e.newState!=="open"||!e.target.matches?.(".ui-menu"))return;const m=e.target,f=m.querySelector('.ui-menu-item[role="menuitemradio"][aria-checked="true"]:not(:disabled)')||m.querySelector(".ui-menu-item:not(:disabled)");if(f){f.focus({preventScroll:true});f.scrollIntoView({block:"nearest"})}},true);
document.addEventListener("keydown",e=>{const m=e.target.closest?.(".ui-menu");if(!m||!["ArrowDown","ArrowUp","Home","End"].includes(e.key))return;const it=[...m.querySelectorAll(".ui-menu-item:not(:disabled)")],n=it.length,i=it.indexOf(e.target),d=e.key==="ArrowDown"?1:-1;it[e.key==="Home"?0:e.key==="End"||(i<0&&d<0)?n-1:(i+d+n)%n]?.focus();e.preventDefault()});
document.addEventListener("click",e=>{const c=e.target.closest?.('.ui-menu [role="menuitemcheckbox"]');if(c)c.setAttribute("aria-checked",String(c.getAttribute("aria-checked")!=="true"));const r=e.target.closest?.('.ui-menu [role="menuitemradio"]');if(r&&!r.disabled){const g=r.parentElement.closest('[role="group"],.ui-menu');g.querySelectorAll('[role="menuitemradio"]').forEach(x=>{if(x.parentElement.closest('[role="group"],.ui-menu')===g)x.setAttribute("aria-checked",String(x===r))})}});`;
