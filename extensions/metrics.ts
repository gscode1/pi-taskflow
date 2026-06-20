/**
 * Vendor-neutral metrics seam — ZERO runtime dependencies.
 *
 * The sibling of `trace.ts`. Traces answer "what happened in this one run";
 * metrics answer "are runs getting slower / costlier / flakier over time". The
 * runtime records through this minimal interface instead of importing any
 * OpenTelemetry package directly, so the zero-dep promise stays intact. The
 * shape (`counter`/`histogram` → `add`/`record`) is a structural subset of the
 * OpenTelemetry `Meter` API, so the adapter is almost a pass-through.
 *
 * Users who want metrics install `@opentelemetry/api` (+ the metrics SDK) and
 * pass an adapter via `RuntimeDeps.meter`. Everyone else pays nothing: the
 * default is a no-op meter whose instruments do nothing.
 *
 * See `extensions/otel/metrics-adapter.ts` for the optional OpenTelemetry adapter.
 */

/** Primitive attribute (dimension) values — mirrors OTel `MetricAttributes`. */
export type MetricAttributeValue = string | number | boolean;
export type MetricAttributes = Record<string, MetricAttributeValue | undefined>;

/** Monotonic counter. Structural subset of the OTel `Counter`. */
export interface Counter {
	/** Increment by `value` (defaults to 1), tagged with `attrs` dimensions. */
	add(value: number, attrs?: MetricAttributes): void;
}

/** Distribution instrument. Structural subset of the OTel `Histogram`. */
export interface Histogram {
	/** Record a single measurement, tagged with `attrs` dimensions. */
	record(value: number, attrs?: MetricAttributes): void;
}

/** Instrument options — `unit` follows UCUM (e.g. "ms", "{token}", "USD"). */
export interface InstrumentOptions {
	unit?: string;
	description?: string;
}

/** Creates instruments. Structural subset of the OpenTelemetry `Meter`. */
export interface Meter {
	counter(name: string, opts?: InstrumentOptions): Counter;
	histogram(name: string, opts?: InstrumentOptions): Histogram;
}

const NOOP_COUNTER: Counter = { add() {} };
const NOOP_HISTOGRAM: Histogram = { record() {} };

/** The default meter: every instrument is inert. Zero overhead, zero deps. */
export const NOOP_METER: Meter = {
	counter: () => NOOP_COUNTER,
	histogram: () => NOOP_HISTOGRAM,
};

/**
 * Metric name constants — kept here so the adapter, the runtime, and tests agree.
 * Names follow the OTel convention of dotted, namespaced identifiers.
 */
export const METRIC = {
	runDuration: "taskflow.run.duration",
	runCost: "taskflow.run.cost",
	runs: "taskflow.runs",
	phaseDuration: "taskflow.phase.duration",
	phaseCost: "taskflow.phase.cost",
	phases: "taskflow.phases",
	subagentDuration: "taskflow.subagent.duration",
	subagentTokens: "taskflow.subagent.tokens",
	subagentRetries: "taskflow.subagent.retries",
	cacheHits: "taskflow.cache.hits",
} as const;

/**
 * A bundle of pre-created instruments, built once per process from a `Meter`.
 * Instrument creation is idempotent in OTel (same name → same instrument), but
 * building the bundle once and threading it avoids re-wrapping on every phase.
 */
export interface Instruments {
	runDuration: Histogram;
	runCost: Histogram;
	runs: Counter;
	phaseDuration: Histogram;
	phaseCost: Histogram;
	phases: Counter;
	subagentDuration: Histogram;
	subagentTokens: Counter;
	subagentRetries: Counter;
	cacheHits: Counter;
}

/** Build the taskflow instrument bundle from a `Meter` (defaults to no-op). */
export function buildInstruments(meter: Meter = NOOP_METER): Instruments {
	return {
		runDuration: meter.histogram(METRIC.runDuration, { unit: "ms", description: "Wall-clock duration of a taskflow run" }),
		runCost: meter.histogram(METRIC.runCost, { unit: "USD", description: "Total USD cost of a taskflow run" }),
		runs: meter.counter(METRIC.runs, { description: "Count of completed taskflow runs, by terminal status" }),
		phaseDuration: meter.histogram(METRIC.phaseDuration, { unit: "ms", description: "Wall-clock duration of a phase" }),
		phaseCost: meter.histogram(METRIC.phaseCost, { unit: "USD", description: "USD cost of a phase" }),
		phases: meter.counter(METRIC.phases, { description: "Count of phase outcomes, by type and status" }),
		subagentDuration: meter.histogram(METRIC.subagentDuration, { unit: "ms", description: "Wall-clock duration of a single subagent invocation" }),
		subagentTokens: meter.counter(METRIC.subagentTokens, { unit: "{token}", description: "Tokens consumed by subagents, by direction" }),
		subagentRetries: meter.counter(METRIC.subagentRetries, { description: "Subagent attempts retried, by reason" }),
		cacheHits: meter.counter(METRIC.cacheHits, { description: "Phase cache lookups, by hit/miss" }),
	};
}
