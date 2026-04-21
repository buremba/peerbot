import { useEffect, useRef, useState } from "preact/hooks";

type RevealPhase = "idle" | "armed" | "visible";

/**
 * Returns a ref and a className that drives a subtle fade-rise animation the
 * first time the element enters the viewport.
 *
 * SSR-safe: the element ships with no animation class, so it's visible to
 * users without JavaScript (and during hydration). Post-hydration, if the
 * element is still below the fold we arm it (fade out), then reveal it with
 * a transition when it intersects. If it's already on-screen at mount, we
 * skip the animation entirely to avoid a flash.
 *
 * Honors `prefers-reduced-motion: reduce` by skipping animations outright.
 */
export function useReveal<T extends Element = HTMLDivElement>(
  rootMargin = "0px 0px -10% 0px"
) {
  const ref = useRef<T | null>(null);
  const [phase, setPhase] = useState<RevealPhase>("idle");

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof window === "undefined") return;

    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
      return;
    }

    const rect = node.getBoundingClientRect();
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;

    // Already on screen at mount → don't animate; just leave it as-is.
    if (rect.top < viewportHeight && rect.bottom > 0) {
      return;
    }

    setPhase("armed");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setPhase("visible");
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin, threshold: 0.1 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  const className =
    phase === "armed"
      ? "reveal"
      : phase === "visible"
        ? "reveal is-visible"
        : "";

  return { ref, className };
}
