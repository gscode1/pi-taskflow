/**
 * OPTIONAL OpenTelemetry SDK bootstrap (Option A — the extension owns setup).
 *
 * This module is loaded LAZILY and only when the user opts in by setting an
 * OTLP endpoint. It is the single place that constructs a TracerProvider +
 * exporter, so `@opentelemetry/*` stays a true optional dependency: the core
 * runtime never imports it, and a user who hasn't set the env var (or hasn't
 * installed the packages) pays nothing.
 *
 * Activation: set `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTel env var), e.g.
 *
 *   npm install @opentelemetry/sdk-trace-node \
 *               @opentelemetry/exporter-trace-otlp-http \
 *               @opentelemetry/resources @opentelemetry/semantic-conventions
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 *
 * Everything here is fail-open: if the env var is absent, packages are missing,
 * or setup throws, we return `undefined` and the run proceeds untraced. A flow
 * must never fail because observability isn't configured.
 */

import { createRequire } from "node:module";
import { otelTracer } from "./adapter.ts";
import type { Tracer } from "../trace.ts";

/** A live tracing session: the tracer to inject, plus a flush/shutdown hook. */
export interface TracingSession {
	tracer: Tracer;
	/** Flush pending spans and shut down the exporter. Always safe to await. */
	shutdown: () => Promise<void>;
}

/** True when the user has opted into tracing via the standard OTel env var. */
export function tracingEnabled(): boolean {
	return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/**
 * Bootstrap OpenTelemetry if (and only if) the user opted in. Returns a
 * `TracingSession` to wire into `RuntimeDeps.tracer`, or `undefined` to run
 * untraced. Never throws.
 */
export function startTracing(serviceName = "pi-taskflow"): TracingSession | undefined {
	if (!tracingEnabled()) return undefined;
	try {
		const require = createRequire(import.meta.url);
		const { BasicTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
		const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

		// Optional resource attributes — degrade gracefully if the packages aren't present.
		let resource: unknown;
		try {
			const { resourceFromAttributes } = require("@opentelemetry/resources");
			const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
			resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
		} catch {
			resource = undefined;
		}

		const exporter = new OTLPTraceExporter(); // reads OTEL_EXPORTER_OTLP_* env vars
		const provider = new BasicTracerProvider({
			...(resource ? { resource } : {}),
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});

		const tracer = otelTracer(provider.getTracer(serviceName));
		return {
			tracer,
			shutdown: async () => {
				try {
					await provider.forceFlush();
					await provider.shutdown();
				} catch {
					// best-effort flush — never block run teardown on the exporter
				}
			},
		};
	} catch (e) {
		// Packages not installed, or SDK setup failed. Warn once, run untraced.
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`[pi-taskflow] OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing setup failed (${msg}). Running untraced.`);
		return undefined;
	}
}
