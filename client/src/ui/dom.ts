/** Tiny DOM helpers. Text is always set via textContent (names are never rendered as HTML). */
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | EventListener | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function toast(message: string, ms = 3000): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: 'toast', role: 'status' }, message);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export function mono(text: string, cls = ''): HTMLSpanElement {
  return h('span', { class: `mono ${cls}`.trim() }, text);
}

/** Set text only when it changed (avoids layout work every frame). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
