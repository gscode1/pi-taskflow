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
		opts?: { startTime?: number; parent?: SpanLike; attributes?: Record<string, SpanAttributeValue | undefined> },
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

/** Span name constants — kept here so the adapter and tests agree on them. */
export const SPAN = {
	run: "taskflow.run",
	phase: "taskflow.phase",
	subagent: "taskflow.subagent",
} as const;
