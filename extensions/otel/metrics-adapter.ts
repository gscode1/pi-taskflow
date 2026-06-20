/**
 * OPTIONAL OpenTelemetry metrics adapter — the metrics sibling of `adapter.ts`.
 *
 * This module is the only metrics file that imports `@opentelemetry/api`. It is
 * not loaded by the runtime and not part of the zero-dependency core. The
 * taskflow `Meter`/`Counter`/`Histogram` seam is a structural subset of the OTel
 * metrics API, so this just maps `add`/`record` and drops undefined dimensions.
 *
 *   import { metrics } from "@opentelemetry/api";
 *   import { otelMeter } from "pi-taskflow/extensions/otel/metrics-adapter.ts";
 *   const meter = otelMeter(metrics.getMeter("pi-taskflow"));
 *
 * The dynamic require keeps type-checking and tests green without the package
 * installed; the import only resolves when a user calls `otelMeter()`.
 */

import { createRequire } from "node:module";
import type { Counter, Histogram, InstrumentOptions, MetricAttributes, MetricAttributeValue, Meter } from "../metrics.ts";

// Minimal shapes we rely on from @opentelemetry/api, declared locally so this
// file type-checks without the package present.
interface OtelCounter {
	add(value: number, attrs?: Record<string, MetricAttributeValue>): void;
}
interface OtelHistogram {
	record(value: number, attrs?: Record<string, MetricAttributeValue>): void;
}
interface OtelMeter {
	createCounter(name: string, opts?: InstrumentOptions): OtelCounter;
	createHistogram(name: string, opts?: InstrumentOptions): OtelHistogram;
}
interface OtelApi {
	metrics: { getMeter(name: string, version?: string): OtelMeter };
}

function loadOtel(): OtelApi {
	const require = createRequire(import.meta.url);
	return require("@opentelemetry/api") as OtelApi;
}

function dropUndefined(attrs: MetricAttributes | undefined): Record<string, MetricAttributeValue> | undefined {
	if (!attrs) return undefined;
	const out: Record<string, MetricAttributeValue> = {};
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
	return out;
}

/**
 * Build a taskflow `Meter` backed by OpenTelemetry. Pass an existing OTel `Meter`
 * (from `metrics.getMeter(...)`), or omit it to use the global one (requires
 * `@opentelemetry/api` installed and a MeterProvider set up).
 */
export function otelMeter(otelMeterInstance?: OtelMeter): Meter {
	const api = loadOtel();
	const meter = otelMeterInstance ?? api.metrics.getMeter("pi-taskflow");
	return {
		counter(name, opts): Counter {
			const c = meter.createCounter(name, opts);
			return { add: (value, attrs) => c.add(value, dropUndefined(attrs)) };
		},
		histogram(name, opts): Histogram {
			const h = meter.createHistogram(name, opts);
			return { record: (value, attrs) => h.record(value, dropUndefined(attrs)) };
		},
	};
}
