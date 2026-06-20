/**
 * OPTIONAL OpenTelemetry adapter.
 *
 * This module is the ONLY place that imports `@opentelemetry/api`. It is not
 * loaded by the runtime and not part of the zero-dependency core. Import it
 * yourself, after installing `@opentelemetry/api` (and an SDK + exporter), then
 * pass the result into `executeTaskflow(state, { tracer: otelTracer() })`.
 *
 *   import { trace } from "@opentelemetry/api";
 *   import { otelTracer } from "pi-taskflow/extensions/otel/adapter.ts";
 *   const tracer = otelTracer(trace.getTracer("pi-taskflow"));
 *
 * The adapter is a thin pass-through: the taskflow `Tracer`/`SpanLike` seam is a
 * structural subset of the OTel API, so this just maps attribute/status calls.
 *
 * NOTE: `@opentelemetry/api` is intentionally NOT a dependency of this package.
 * The dynamic require keeps `tsc --noEmit` and `node --test` green without it
 * installed; the import only resolves when a user actually calls `otelTracer()`.
 */

import { createRequire } from "node:module";
import type { SpanAttributeValue, SpanLike, Tracer } from "../trace.ts";

// Minimal shapes we rely on from @opentelemetry/api, declared locally so this
// file type-checks without the package present.
interface OtelSpan {
	setAttribute(key: string, value: SpanAttributeValue): void;
	setStatus(status: { code: number; message?: string }): void;
	addEvent(name: string, attrs?: Record<string, SpanAttributeValue>): void;
	end(endTime?: number | [number, number] | Date): void;
}
interface OtelContext {
	// opaque
	readonly __brand?: "context";
}
interface OtelTracer {
	startSpan(name: string, opts?: { startTime?: number | Date; kind?: number; attributes?: Record<string, SpanAttributeValue> }, ctx?: OtelContext): OtelSpan;
}
interface OtelApi {
	trace: {
		getTracer(name: string, version?: string): OtelTracer;
		setSpan(ctx: OtelContext, span: OtelSpan): OtelContext;
	};
	context: { active(): OtelContext };
	SpanStatusCode: { OK: number; ERROR: number };
	SpanKind: { INTERNAL: number; CLIENT: number };
}

function loadOtel(): OtelApi {
	const require = createRequire(import.meta.url);
	return require("@opentelemetry/api") as OtelApi;
}

function dropUndefined(attrs: Record<string, SpanAttributeValue | undefined>): Record<string, SpanAttributeValue> {
	const out: Record<string, SpanAttributeValue> = {};
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
	return out;
}

/** Wrap an OTel span in the taskflow `SpanLike` seam. */
function wrapSpan(api: OtelApi, span: OtelSpan): SpanLike {
	return {
		setAttributes(attrs) {
			for (const [k, v] of Object.entries(attrs)) if (v !== undefined) span.setAttribute(k, v);
		},
		setStatus(status) {
			span.setStatus({
				code: status.ok ? api.SpanStatusCode.OK : api.SpanStatusCode.ERROR,
				message: status.message,
			});
		},
		addEvent(name, attrs) {
			span.addEvent(name, attrs ? dropUndefined(attrs) : undefined);
		},
		end(endTime) {
			span.end(endTime);
		},
	};
}

/** Internal: carry the raw OTel span so we can establish parent context. */
const RAW = Symbol("otel.raw.span");
type WrappedSpan = SpanLike & { [RAW]?: OtelSpan };

/**
 * Build a taskflow `Tracer` backed by OpenTelemetry. Pass an existing OTel
 * `Tracer` (from `trace.getTracer(...)`), or omit it to use the global one
 * (requires `@opentelemetry/api` to be installed and a TracerProvider set up).
 */
export function otelTracer(otelTracerInstance?: OtelTracer): Tracer {
	const api = loadOtel();
	const tracer = otelTracerInstance ?? api.trace.getTracer("pi-taskflow");
	return {
		startSpan(name, opts) {
			// Parent the new span at the supplied parent span's context, falling back
			// to the active context. Explicit parenting (not relying solely on async
			// context) keeps spans correct under the runtime's manual concurrency.
			const parentRaw = (opts?.parent as WrappedSpan | undefined)?.[RAW];
			const ctx = parentRaw ? api.trace.setSpan(api.context.active(), parentRaw) : api.context.active();
			const kind = opts?.kind === "client" ? api.SpanKind.CLIENT : api.SpanKind.INTERNAL;
			const span = tracer.startSpan(
				name,
				{ startTime: opts?.startTime, kind, attributes: opts?.attributes ? dropUndefined(opts.attributes) : undefined },
				ctx,
			);
			const wrapped = wrapSpan(api, span) as WrappedSpan;
			wrapped[RAW] = span;
			return wrapped;
		},
	};
}
