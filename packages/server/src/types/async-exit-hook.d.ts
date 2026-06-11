/**
 * Minimal typings for `async-exit-hook` (ships untyped; transitive dep of
 * `embedded-postgres`). Only the surface used by embedded-postgres-backend.ts.
 */
declare module 'async-exit-hook' {
  interface AsyncExitHook {
    (hook: (done?: () => void) => void): void;
    /** Remove the listener async-exit-hook registered for a process event. */
    unhookEvent(event: string): void;
    hookEvent(event: string, code?: number, filter?: (...args: unknown[]) => boolean): void;
    hookedEvents(): string[];
    forceExitTimeout(ms: number): void;
  }
  const exitHook: AsyncExitHook;
  export default exitHook;
}
