// The #38 / #40 type audit, run in the page by page.evaluate: it must stay self-contained.

/** Every visible text node's size and contrast, and each control's label size. */
export function audit() {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const rgba = (c: string) => {
    const m = (c.match(/[\d.]+/g) ?? []).map(Number);
    // color(srgb r g b / a) reports 0-1 channels.
    const [r, g, b] = c.startsWith('color(') ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3);
    const a = c.startsWith('color(') ? (m[3] ?? 1) : (m[3] ?? 1);
    return { r: r!, g: g!, b: b!, a };
  };
  const lum = (c: { r: number; g: number; b: number }) =>
    0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  type Px = { r: number; g: number; b: number; a: number };
  const NONE: Px = { r: 0, g: 0, b: 0, a: 0 };
  // Premultiplied alpha, so a group's opacity scales every channel at once.
  const pre = (c: Px): Px => ({ r: c.r * c.a, g: c.g * c.a, b: c.b * c.a, a: c.a });
  const fade = (c: Px, o: number): Px => ({ r: c.r * o, g: c.g * o, b: c.b * o, a: c.a * o });
  const over = (top: Px, back: Px): Px => ({
    r: top.r + back.r * (1 - top.a),
    g: top.g + back.g * (1 - top.a),
    b: top.b + back.b * (1 - top.a),
    a: top.a + back.a * (1 - top.a),
  });
  /**
   * The colour on screen where `ink` is drawn inside `el`, or behind it when `ink` is NONE.
   * Every ancestor paints its background, and its opacity fades its whole subtree as one
   * group (CSS opacity), all over the white canvas. Only the element's own ancestors are
   * stacked: siblings drawn over it and background images are not modelled.
   */
  const paint = (el: Element, ink: Px): Px => {
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let inner = pre(ink);
    for (let i = chain.length - 1; i >= 0; i--) {
      const cs = getComputedStyle(chain[i]!);
      inner = fade(over(inner, pre(rgba(cs.backgroundColor))), Number(cs.opacity));
    }
    return over(inner, { r: 255, g: 255, b: 255, a: 1 });
  };
  /** Contrast of `ink` drawn in `el` against the same spot without it. */
  const ratio = (el: Element, ink: Px) => {
    const [x, y] = [lum(paint(el, ink)), lum(paint(el, NONE))];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  /** Its own opacity times every ancestor's. */
  const opacity = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement)
      o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && opacity(el) > 0;
  };
  const disabled = (el: Element) => !!el.closest('[disabled], [aria-disabled="true"]');

  const small: string[] = [];
  const faint: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.textContent?.trim();
    const el = n.parentElement;
    if (!t || !el || !visible(el) || el.closest('script, style, [aria-hidden="true"]:not(svg)'))
      continue;
    const cs = getComputedStyle(el);
    const svg = el.closest('svg');
    // SVG text is drawn in a 300-unit viewBox scaled to the dial.
    const size = svg
      ? parseFloat(cs.fontSize) * (svg.getBoundingClientRect().width / svg.viewBox.baseVal.width)
      : parseFloat(cs.fontSize);
    if (size < 15 - 1e-6) small.push(`${t.slice(0, 30)} @${size.toFixed(1)}`);
    if (disabled(el)) continue;
    const ink = rgba(svg ? cs.fill : cs.color);
    if (svg) ink.a *= Number(cs.fillOpacity);
    const r = ratio(el, ink);
    if (r < 4.5) faint.push(`${t.slice(0, 30)} ${r.toFixed(2)}`);
  }

  // Form values and placeholders are drawn by the control, not by a text node.
  const NO_TEXT = ['checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (!visible(el) || disabled(el)) continue;
    if (el instanceof HTMLInputElement && NO_TEXT.includes(el.type)) continue;
    const field = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const shown =
      field instanceof HTMLSelectElement
        ? { text: field.selectedOptions[0]?.text ?? '', cs: getComputedStyle(field) }
        : field.value
          ? { text: field.value, cs: getComputedStyle(field) }
          : { text: field.placeholder, cs: getComputedStyle(field, '::placeholder') };
    const t = shown.text.trim();
    if (!t) continue;
    const size = parseFloat(shown.cs.fontSize);
    if (size < 15 - 1e-6) small.push(`${t.slice(0, 30)} @${size.toFixed(1)}`);
    const r = ratio(el, rgba(shown.cs.color));
    if (r < 4.5) faint.push(`${t.slice(0, 30)} ${r.toFixed(2)}`);
  }

  const controls: string[] = [];
  const tappable =
    'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary';
  for (const el of document.querySelectorAll(tappable)) {
    // A transparent native picker laid over its label is not visible(): the label is its text.
    if (!visible(el) || el.matches('.dial-link')) continue;
    const sizes = [el, ...el.querySelectorAll('*')]
      .filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()))
      .map((e) => parseFloat(getComputedStyle(e).fontSize));
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    )
      sizes.push(parseFloat(getComputedStyle(el).fontSize));
    if (sizes.length && Math.max(...sizes) < 20 - 1e-6) {
      controls.push(
        `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" @${Math.max(...sizes)}`,
      );
    }
  }
  return { small, faint, controls };
}
