/**
 * Embedding model/version stamp guard.
 *
 * Kept in its own module (separate from `embeddings.ts`) so it can be unit
 * tested in isolation — `embeddings.ts` is module-mocked by the executor tests,
 * and bun's `mock.module` is process-global, so the guard logic would otherwise
 * be unreachable in those test runs.
 */

/**
 * Resolve the model/version stamp to persist for a service-produced embedding.
 *
 * Equal dimensionality is NOT enough — vectors from a different model occupy an
 * incompatible space, so a same-dimension model swap would silently mix spaces
 * in `event_embeddings`. Throws (fail loud) when the service reports a model
 * that differs from the worker's expectation; otherwise returns the stamp
 * (service-reported when present, else the confirmed expectation).
 */
export function resolveServiceModel(
  serviceModel: string | undefined,
  expectedModel: string
): string {
  if (serviceModel && serviceModel !== expectedModel) {
    throw new Error(
      `Embeddings service returned model '${serviceModel}' but this worker expects ` +
        `'${expectedModel}'. Refusing to mix incompatible vector spaces — align ` +
        `EMBEDDINGS_MODEL on the worker and the embeddings service.`
    );
  }
  return serviceModel || expectedModel;
}
