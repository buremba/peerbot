import type { AstroGlobal } from "astro";
import { dark, light } from "../styles/theme-tokens";

function varsToJs(vars: Record<string, string>) {
  return Object.entries(vars)
    .map(([k, v]) => `s.setProperty("${k}","${v.replace(/"/g, '\\"')}");`)
    .join("");
}

/**
 * Returns a `<script is:inline>` body that:
 *  1. Honours an explicit `forceTheme` passed by the page (skips media query)
 *  2. Checks `location.hash` for `#theme=dark` or `#theme=light` (testing override)
 *  3. Falls back to `prefers-color-scheme` media query (OS preference)
 *  4. Applies the matching palette via inline `style` on `<html>`
 *  5. Sets `data-theme` attribute + `starlight-theme` localStorage so Starlight stays in sync
 *  6. Adds `dark-mode`/`light-mode` class on `<body>` for Scalar API Reference
 *  7. Runs before paint so there's no FOUC
 */
export function themeScript(
  _astro: AstroGlobal,
  forceTheme?: "light" | "dark"
) {
  const forcedBranch = forceTheme
    ? `${forceTheme === "dark" ? "D()" : "L()"};return;`
    : "";
  return `(function(){var e=document.documentElement;var s=e.style;var n;var apply=function(){e.setAttribute("data-theme",n);try{localStorage.setItem("starlight-theme",n)}catch(x){}var b=document.body;if(b){b.classList.add(n+"-mode");b.classList.remove(n==="dark"?"light-mode":"dark-mode")}else{document.addEventListener("DOMContentLoaded",function(){document.body.classList.add(n+"-mode");document.body.classList.remove(n==="dark"?"light-mode":"dark-mode")})}};var L=function(){n="light";${varsToJs(light)};apply()};var D=function(){n="dark";${varsToJs(dark)};apply()};${forcedBranch}var h=location.hash.match(/[#&]theme=(dark|light)\\b/);if(h){if(h[1]==="dark"){D()}else{L()}}else if(window.matchMedia("(prefers-color-scheme:dark)").matches){D()}else{L()}})();`;
}
