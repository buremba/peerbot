/**
 * Race a promise against an AbortSignal. Rejects with the signal's reason on
 * abort. The `abort` listener is removed when the underlying promise settles
 * first so callers can re-use one signal across many calls (e.g. a sandbox
 * script making multiple `client.query` invocations) without stacking
 * listener leaks.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const reason = () =>
      signal.reason instanceof Error ? signal.reason : new Error("AbortError: signal aborted");
    if (signal.aborted) return reject(reason());
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
