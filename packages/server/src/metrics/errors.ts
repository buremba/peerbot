/**
 * Metric compilation errors, shared by the compiler and the read-mode resolver.
 *
 * `MetricNotImplementedError` extends `MetricCompileError` so a caller that
 * catches the base class still catches deferred-feature failures.
 */

export class MetricCompileError extends Error {}
export class MetricNotImplementedError extends MetricCompileError {}
