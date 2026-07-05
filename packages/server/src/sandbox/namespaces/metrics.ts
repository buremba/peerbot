/**
 * ClientSDK `metrics` namespace. Thin wrapper over the metric MCP tools
 * (`list_metrics`, `query_metric`, `metric_series`).
 */

import type { Static } from "@sinclair/typebox";
import type { Env } from "../../index";
import {
	ListMetricsSchema,
	listMetrics,
} from "../../tools/admin/list_metrics";
import {
	MetricSeriesSchema,
	metricSeries,
} from "../../tools/admin/metric_series";
import {
	QueryMetricSchema,
	queryMetric,
} from "../../tools/admin/query_metric";
import type { ToolContext } from "../../tools/registry";

export type MetricsListInput = Static<typeof ListMetricsSchema>;
export type MetricsQueryInput = Static<typeof QueryMetricSchema>;
export type MetricsSeriesInput = Static<typeof MetricSeriesSchema>;

export interface MetricsNamespace {
	list(input?: MetricsListInput): Promise<unknown>;
	query(input: MetricsQueryInput): Promise<unknown>;
	series(input: MetricsSeriesInput): Promise<unknown>;
}

export function buildMetricsNamespace(
	ctx: ToolContext,
	env: Env,
): MetricsNamespace {
	return {
		list: (input) => listMetrics(input ?? {}, env, ctx),
		query: (input) => queryMetric(input, env, ctx),
		series: (input) => metricSeries(input, env, ctx),
	};
}