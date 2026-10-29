import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

// Regenerates every SVG source and PNG export in this folder:
//   npm i @resvg/resvg-js && node generate.mjs
//
// The icon sources contain no text, so no fonts are needed. The concept
// board (fonts + captions) is a designer artifact and lives outside the repo.

const OUT = new URL(".", import.meta.url);

// Canonical Instrument tokens (#14, docs/design/README.md). The concept board
// used nicknames: night ink "stone", night accent "sage", light accent "steel".
// Keep these canonical names in any downstream comment or manifest wiring.
const T = {
  light: { bg: "#ECEFF1", ink: "#1F2A33", dim: "#77848E", accent: "#2E6A8E" },
  night: { bg: "#0D0C0B", ink: "#ADA59A", dim: "#68625A", accent: "#6F8F84" },
};

const S = 1024;
// Maskable: full-bleed background; the mark stays inside a central circle of
// radius 40% of the canvas (r 409.6 at 1024). Measured per tile by Pepper
// [Reviewer], 2026-10-29: Cairn 0.760/0.765, Fledge 0.779, Hearth 0.757.

// Geometry is frozen as reviewed 2026-10-29 ("accept with nits"); only
// comments and names may change without a fresh review.
function cairn(p) {
  return `<g>
    <rect x="234" y="638" width="556" height="168" rx="58" fill="${p.ink}"/>
    <rect x="314" y="444" width="440" height="150" rx="75" fill="${p.ink}"/>
    <rect x="331" y="230" width="330" height="170" rx="85" fill="${p.accent}"/>
  </g>`;
}

function fledge(p) {
  return `<g transform="translate(-20,35) scale(0.93)">
    <g stroke="${p.dim}" stroke-width="10" opacity="0.55" stroke-linecap="round">
      <line x1="250" y1="744" x2="470" y2="744"/>
      <line x1="250" y1="744" x2="250" y2="716"/>
      <line x1="323" y1="744" x2="323" y2="716"/>
      <line x1="396" y1="744" x2="396" y2="716"/>
      <line x1="470" y1="744" x2="470" y2="716"/>
    </g>
    <path d="M240 660 C 370 636 480 596 570 520 C 630 468 676 408 700 352"
          fill="none" stroke="${p.ink}" stroke-width="92" stroke-linecap="round"/>
    <path d="M640 442 C 628 512 580 570 498 610 C 524 528 544 482 560 430 Z" fill="${p.accent}"/>
    <circle cx="748" cy="300" r="92" fill="${p.accent}"/>
    <path d="M866 208 L823 271 L794 234 Z" fill="${p.accent}"/>
  </g>`;
}

function hearth(p) {
  const arch =
    "M 262 784 L 262 462 A 250 250 0 0 1 762 462 L 762 784 A 28 28 0 0 1 734 812 L 290 812 A 28 28 0 0 1 262 784 Z";
  const open = "M 318 812 L 318 462 A 194 194 0 0 1 706 462 L 706 812 Z";
  const flame =
    "M512 448 C 566 520 608 578 608 664 A 96 96 0 0 1 416 664 C 416 578 458 520 512 448 Z";
  return `<g>
    <path d="${arch}" fill="${p.ink}"/>
    <path d="${open}" fill="${p.bg}"/>
    <path d="${flame}" fill="${p.accent}"/>
  </g>`;
}

const CONCEPTS = [
  {
    id: "cairn",
    paint: cairn,
    note:
      "Three size-graded stones (slab, capsule, pebble), tonally flat; the top stone carries the accent.",
  },
  {
    id: "fledge",
    paint: fledge,
    note:
      "Growth line takes wing: one rising stroke, folded wing, head and beak in accent, baseline ticks in dim. Reads fully from ~96 px; at 48 px it reads as a rising trend with a reading point.",
  },
  {
    id: "hearth",
    paint: hearth,
    note:
      "An arch holding a flame; the arch quotes the rounded wells in the UI, the interior cutout uses bg.",
  },
];

function tokensUsed(mode, paintId) {
  const p = T[mode];
  const names = { bg: p.bg, ink: p.ink, dim: p.dim, accent: p.accent };
  if (paintId === "cairn") delete names.dim;
  if (paintId === "hearth") delete names.dim;
  return Object.entries(names)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
}

function comment(concept, mode) {
  return `<!-- ${concept.id.toUpperCase()} icon — ${concept.note}
     ${mode} mode, Instrument direction #14 (docs/design/README.md). Canonical tokens: ${tokensUsed(mode, concept.id)}.
     Full-bleed bg; mark inside the Ø80% maskable safe zone (r 409.6 at 1024). -->`;
}

function svgFor(concept, mode) {
  const p = T[mode];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  ${comment(concept, mode)}
  <rect width="${S}" height="${S}" fill="${p.bg}"/>${concept.paint(p)}</svg>`;
}

function renderPng(svg, width) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
}

mkdirSync(new URL("png", OUT), { recursive: true });
for (const concept of CONCEPTS) {
  for (const mode of ["light", "night"]) {
    const svg = svgFor(concept, mode);
    writeFileSync(new URL(`svg/${concept.id}-${mode}.svg`, OUT), svg);
    for (const w of [512, 192, 48]) {
      writeFileSync(new URL(`png/${concept.id}-${mode}-${w}.png`, OUT), renderPng(svg, w));
    }
  }
}
console.log("brand assets generated");
