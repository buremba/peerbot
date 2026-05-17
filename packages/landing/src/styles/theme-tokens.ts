// Theme tokens for the landing page.
//
// This module is inlined as a <script is:inline> in BaseLayout.astro so it
// runs before paint, bypassing Tailwind's CSS cascade entirely.  It sets CSS
// custom properties directly on document.documentElement.style — which wins
// over any stylesheet rule.
//
// Components reference these via var(--color-page-*) in inline styles and
// Tailwind arbitrary-value classes like bg-[var(--color-page-surface)].

/** Light palette (default) — tweakcn "Retro" */
export const light = {
  "--color-page-bg": "oklch(0.9808 0.0079 73.7452)",
  "--color-page-bg-elevated": "oklch(0.9724 0.0096 72.6627)",
  "--color-page-bg-overlay": "oklch(0.9808 0.0079 73.7452 / 0.85)",
  "--color-page-surface": "oklch(0.9724 0.0096 72.6627)",
  "--color-page-surface-dim": "oklch(0.9439 0.0148 70.8848)",
  "--color-page-border": "oklch(0.8900 0.0196 72.5571)",
  "--color-page-border-active": "oklch(0.7006 0.1891 46.5400 / 0.45)",
  "--color-page-text": "oklch(0.1804 0.0154 57.0973)",
  "--color-page-text-muted": "oklch(0.4806 0.0254 51.1528)",

  "--color-tg-bg": "oklch(0.2606 0.0040 84.5838)",
  "--color-tg-bg-secondary": "oklch(0.2007 0.0101 52.8852)",
  "--color-tg-bubble-out": "oklch(0.7006 0.1891 46.5400)",
  "--color-tg-bubble-in": "oklch(0.2606 0.0040 84.5838)",
  "--color-tg-accent": "oklch(0.7006 0.1891 46.5400)",
  "--color-tg-accent-rgb": "224, 121, 56",
  "--color-tg-border": "oklch(0.2701 0.0106 48.3077)",
  "--color-tg-text": "oklch(0.9206 0.0042 56.3709)",
  "--color-tg-meta": "oklch(0.9206 0.0042 56.3709 / 0.55)",

  "--color-page-bg-inverted": "oklch(0.1488 0.0098 61.6463)",
  "--color-page-text-inverted": "oklch(0.9808 0.0079 73.7452)",
  "--color-page-dotted": "oklch(0.1804 0.0154 57.0973 / 0.10)",
  "--color-page-grid": "oklch(0.1804 0.0154 57.0973 / 0.07)",
  "--color-page-divider-mark": "oklch(0.1804 0.0154 57.0973 / 0.22)",
  "--color-page-overlay-backdrop": "rgba(0, 0, 0, 0.7)",
  "--color-page-code-bg": "rgba(0, 0, 0, 0.04)",
  "--color-page-code-border": "rgba(0, 0, 0, 0.08)",
  "--color-page-pre-bg-from": "rgba(20, 20, 24, 0.98)",
  "--color-page-pre-bg-to": "rgba(12, 12, 16, 0.98)",
  "--color-page-pre-border": "rgba(255, 255, 255, 0.09)",
  "--color-page-prose-text": "rgba(11, 11, 13, 0.82)",
  "--color-page-prose-blockquote": "rgba(11, 11, 13, 0.7)",
  "--color-page-hex-stroke": "rgba(0, 0, 0, 0.18)",
  "--color-page-hex-line": "rgba(0, 0, 0, 0.08)",
  "--color-page-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.05)",
  "--color-page-shadow-md":
    "0 12px 32px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)",
  "--color-page-dialog-close-bg": "rgba(0, 0, 0, 0.5)",
  "--color-page-dialog-close-hover": "rgba(0, 0, 0, 0.7)",
  "--color-page-meta-theme": "#ffffff",
} as const;

/** Dark palette — tweakcn "Retro" (aligned with packages/owletto/src/index.css .dark) */
export const dark = {
  "--color-page-bg": "oklch(0.1700 0.0040 50)",
  "--color-page-bg-elevated": "oklch(0.2250 0.0050 50)",
  "--color-page-bg-overlay": "oklch(0.1700 0.0040 50 / 0.85)",
  "--color-page-surface": "oklch(0.2250 0.0050 50)",
  "--color-page-surface-dim": "oklch(0.2000 0.0050 50)",
  "--color-page-border": "oklch(0.3400 0.0080 50)",
  "--color-page-border-active": "oklch(0.7006 0.1891 46.5400 / 0.55)",
  "--color-page-text": "oklch(0.9206 0.0042 56.3709)",
  "--color-page-text-muted": "oklch(0.7200 0.0080 50)",

  "--color-tg-bg": "oklch(0.2250 0.0050 50)",
  "--color-tg-bg-secondary": "oklch(0.2000 0.0050 50)",
  "--color-tg-bubble-out": "oklch(0.7006 0.1891 46.5400)",
  "--color-tg-bubble-in": "oklch(0.2250 0.0050 50)",
  "--color-tg-accent": "oklch(0.7006 0.1891 46.5400)",
  "--color-tg-accent-rgb": "224, 121, 56",
  "--color-tg-border": "oklch(0.3400 0.0080 50)",
  "--color-tg-text": "oklch(0.9206 0.0042 56.3709)",
  "--color-tg-meta": "oklch(0.9206 0.0042 56.3709 / 0.55)",

  "--color-page-bg-inverted": "oklch(0.9808 0.0079 73.7452)",
  "--color-page-text-inverted": "oklch(0.1700 0.0040 50)",
  "--color-page-dotted": "oklch(0.9206 0.0042 56.3709 / 0.08)",
  "--color-page-grid": "oklch(0.9206 0.0042 56.3709 / 0.05)",
  "--color-page-divider-mark": "oklch(0.9206 0.0042 56.3709 / 0.16)",
  "--color-page-overlay-backdrop": "rgba(0, 0, 0, 0.8)",
  "--color-page-code-bg": "rgba(255, 255, 255, 0.06)",
  "--color-page-code-border": "rgba(255, 255, 255, 0.08)",
  "--color-page-pre-bg-from": "rgba(20, 20, 24, 0.98)",
  "--color-page-pre-bg-to": "rgba(12, 12, 16, 0.98)",
  "--color-page-pre-border": "rgba(255, 255, 255, 0.09)",
  "--color-page-prose-text": "rgba(240, 240, 242, 0.82)",
  "--color-page-prose-blockquote": "rgba(240, 240, 242, 0.7)",
  "--color-page-hex-stroke": "rgba(255, 255, 255, 0.14)",
  "--color-page-hex-line": "rgba(255, 255, 255, 0.06)",
  "--color-page-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
  "--color-page-shadow-md":
    "0 12px 32px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.2)",
  "--color-page-dialog-close-bg": "rgba(255, 255, 255, 0.15)",
  "--color-page-dialog-close-hover": "rgba(255, 255, 255, 0.25)",
  "--color-page-meta-theme": "#0a0a0b",
} as const;
