/**
 * Vendor-neutral tracing seam — ZERO runtime dependencies.
 *
 * The runtime emits spans through this minimal interface instead of importing
 * any OpenTelemetry package directly, so the zero-dep promise stays intact. The
 * shape (`startSpan` / `setAttributes` / `setStatus` / `end`) is deliberately a
 * structural subset of the OpenTelemetry `Tracer`/`Span` API, so an adapter that
 * wraps a real OTel tracer is almost a pass-through.
 *
 * Users who want traces install `@opentelemetry/api` (+ an SDK) themselves and
 * pass an adapter via `RuntimeDeps.tracer`. Everyone else pays nothing: the
 * default is a no-op tracer whose spans do nothing.
 *
 * See `extensions/otel/adapter.ts` for the optional OpenTelemetry adapter.
 */

/** Primitive attribute values accepted on a span (mirrors OTel `AttributeValue`). */
export type SpanAttributeValue = string | number | boolean;

/**
 * Span kind — structural subset of OTel `SpanKind`. The runtime marks subagent
 * spans (the actual outbound LLM/process calls) as CLIENT so they're visually
 * distinct from the INTERNAL orchestration spans (run/phase) in trace UIs.
 */
export type SpanKind = "internal" | "client";

/** A single span. Structural subset of the OpenTelemetry `Span`. */
export interface SpanLike {
	/** Attach key/value attributes. Undefined values are ignored by convention. */
	setAttributes(attrs: Record<string, SpanAttributeValue | undefined>): void;
	/** Record terminal status. `ok: false` maps to an OTel ERROR status. */
	setStatus(status: { ok: boolean; message?: string }): void;
	/** Record a point-in-time event on the span (optional; no-op if unsupported). */
	addEvent?(name: string, attrs?: Record<string, SpanAttributeValue | undefined>): void;
	/** End the span. `endTime` is epoch-ms (matches PhaseState.endedAt). */
	end(endTime?: number): void;
}

/** Creates spans. Structural subset of the OpenTelemetry `Tracer`. */
export interface Tracer {
	startSpan(
		name: string,
		opts?: { startTime?: number; parent?: SpanLike; kind?: SpanKind; attributes?: Record<string, SpanAttributeValue | undefined> },
	): SpanLike;
}

/** A span that does nothing. Shared singleton — spans are stateless no-ops. */
const NOOP_SPAN: SpanLike = {
	setAttributes() {},
	setStatus() {},
	addEvent() {},
	end() {},
};

/** The default tracer: every span is a no-op. Zero overhead, zero deps. */
export const NOOP_TRACER: Tracer = {
	startSpan: () => NOOP_SPAN,
};

/**
 * Stable, low-cardinality span "kind" identifiers. These are NOT the span names
 * anymore (those are descriptive — see `spanName` below) but live on every span
 * as the `taskflow.span_kind` attribute, so dashboards can aggregate across all
 * phase/subagent/run spans regardless of their human-readable name.
 */
export const SPAN = {
	run: "taskflow.run",
	phase: "taskflow.phase",
	subagent: "taskflow.subagent",
} as const;

/**
 * Descriptive span names. Trace UIs (Jaeger, Tempo, etc.) label and group spans
 * by their operation NAME, so a single shared constant renders every span as the
 * same opaque row ("taskflow.phase"). These builders fold the most useful
 * identifier into the name — the phase id, the agent, the flow — keeping the name
 * low-cardinality (ids/agents/flows are bounded per flow) while making a trace
 * readable at a glance. The stable `SPAN.*` value still rides along as the
 * `taskflow.span_kind` attribute for aggregation.
 */
export const spanName = {
	run: (flow: string) => `taskflow.run ${flow}`,
	/** e.g. `phase:gate review` or `phase:agent build` — type prefix + phase id. */
	phase: (type: string, id: string) => `phase:${type} ${id}`,
	/** e.g. `subagent coder` — the agent doing the work. */
	subagent: (agent: string) => `subagent ${agent}`,
} as const;
