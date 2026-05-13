import { createLogger } from "../logger";

const logger = createLogger("retry");

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  /** Maximum delay between retries (caps the computed delay before jitter). */
  maxDelay?: number;
  strategy?: "exponential" | "linear";
  /**
   * Jitter mode:
   * - `false` (default): no jitter
   * - `true`: add a uniform random 0-1000ms to each delay (additive jitter)
   * - `"full"`: multiply the computed delay by a uniform random in [1, 2)
   *   (equivalent to p-retry's `randomize: true`)
   */
  jitter?: boolean | "full";
  /**
   * Predicate to decide whether an error is retryable. If it returns `false`,
   * the loop aborts immediately and rethrows the error. Defaults to retrying
   * every error.
   */
  shouldRetry?: (error: Error, attempt: number) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Retry a function with configurable backoff strategy.
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries fail or `shouldRetry` returns `false`.
 *
 * @example
 * ```typescript
 * // Exponential backoff (default)
 * const result = await retryWithBackoff(
 *   () => fetch('https://api.example.com'),
 *   { maxRetries: 3, baseDelay: 1000 }
 * );
 *
 * // HTTP-style retry with full jitter, max delay cap, and a predicate
 * const result = await retryWithBackoff(() => fetch(url), {
 *   maxRetries: 5,
 *   baseDelay: 1000,
 *   maxDelay: 16000,
 *   jitter: "full",
 *   shouldRetry: (error) => !/(401|403|404)/.test(error.message),
 * });
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay,
    strategy = "exponential",
    jitter = false,
    shouldRetry,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Allow caller to abort on non-retryable errors. A buggy predicate that
      // throws must not mask the real error or skip remaining retries — log and
      // fall back to the default (retry).
      if (shouldRetry) {
        let allowRetry = true;
        try {
          allowRetry = shouldRetry(lastError, attempt + 1);
        } catch (predicateError) {
          logger.warn("shouldRetry predicate threw; defaulting to retry", {
            error:
              predicateError instanceof Error
                ? predicateError.message
                : String(predicateError),
          });
        }
        if (!allowRetry) {
          throw lastError;
        }
      }

      if (attempt < maxRetries) {
        // Calculate base delay based on strategy
        let delay =
          strategy === "exponential"
            ? baseDelay * 2 ** attempt
            : baseDelay * (attempt + 1);

        if (maxDelay !== undefined) {
          delay = Math.min(delay, maxDelay);
        }

        // Apply jitter
        let finalDelay: number;
        if (jitter === "full") {
          // Multiplicative jitter: random in [1, 2) — matches p-retry randomize.
          finalDelay = delay * (1 + Math.random());
        } else if (jitter === true) {
          // Additive jitter: 0–1000ms.
          finalDelay = delay + Math.random() * 1000;
        } else {
          finalDelay = delay;
        }

        // Notify caller of retry — isolate a throwing callback.
        if (onRetry) {
          try {
            onRetry(attempt + 1, lastError);
          } catch (callbackError) {
            logger.warn("onRetry callback threw", {
              error:
                callbackError instanceof Error
                  ? callbackError.message
                  : String(callbackError),
            });
          }
        } else {
          logger.warn(
            `Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(finalDelay)}ms`,
            { error: lastError.message }
          );
        }

        await new Promise((resolve) => setTimeout(resolve, finalDelay));
      }
    }
  }

  throw lastError;
}
