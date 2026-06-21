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
 * Content capture (task inputs + result text on spans) is OFF by default since
 * those can carry sensitive data. To aid troubleshooting, opt in with the
 * standard OTel GenAI flag — outputs are always truncated:
 *
 *   export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
 *   export PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS=4000   # optional per-field cap
 *
 * Everything here is fail-open: if the env var is absent, packages are missing,
 * or setup throws, we return `undefined` and the run proceeds untraced. A flow
 * must never fail because observability isn't configured.
 */

import { createRequire } from "node:module";
import { otelTracer } from "./adapter.ts";
import { otelMeter } from "./metrics-adapter.ts";
import type { Tracer } from "../trace.ts";
import type { Meter } from "../metrics.ts";

/** A live telemetry session: tracer + meter to inject, plus a flush/shutdown hook. */
export interface TracingSession {
	tracer: Tracer;
	/** Optional metrics meter, present when the metrics SDK is installed. */
	meter?: Meter;
	/** Flush pending spans/metrics and shut down the exporters. Always safe to await. */
	shutdown: () => Promise<void>;
}

/**
 * Resource attributes describing THIS process — attached to every span/metric so
 * you can slice telemetry by service version and deployment environment. Read
 * from standard env vars with sensible fallbacks; degrades to service.name only
 * if the resources/semconv packages aren't installed.
 */
function buildResource(require: NodeRequire, serviceName: string): unknown {
	try {
		const { resourceFromAttributes } = require("@opentelemetry/resources");
		const sc = require("@opentelemetry/semantic-conventions");
		const attrs: Record<string, string> = { [sc.ATTR_SERVICE_NAME]: serviceName };
		const version = process.env.OTEL_SERVICE_VERSION ?? process.env.npm_package_version;
		if (version) attrs[sc.ATTR_SERVICE_VERSION ?? "service.version"] = version;
		const env = process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV;
		// `deployment.environment.name` is the current stable semconv key.
		if (env) attrs["deployment.environment.name"] = env;
		return resourceFromAttributes(attrs);
	} catch {
		return undefined;
	}
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
		const resource = buildResource(require, serviceName);

		const exporter = new OTLPTraceExporter(); // reads OTEL_EXPORTER_OTLP_* env vars
		const provider = new BasicTracerProvider({
			...(resource ? { resource } : {}),
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		const tracer = otelTracer(provider.getTracer(serviceName));

		// Metrics pipeline (OTLP push). Optional & independent: if the metrics SDK
		// or exporter isn't installed, we run with traces only — never fail.
		let meter: Meter | undefined;
		let meterProvider: { forceFlush: () => Promise<void>; shutdown: () => Promise<void> } | undefined;
		try {
			const { MeterProvider, PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
			const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
			const mp = new MeterProvider({
				...(resource ? { resource } : {}),
				// Push to the collector on an interval (and once more on shutdown).
				readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
			});
			meterProvider = mp;
			meter = otelMeter(mp.getMeter(serviceName));
		} catch {
			meter = undefined; // traces-only; metrics packages not installed
		}

		return {
			tracer,
			meter,
			shutdown: async () => {
				try {
					await provider.forceFlush();
					await provider.shutdown();
				} catch {
					// best-effort flush — never block run teardown on the exporter
				}
				try {
					await meterProvider?.forceFlush();
					await meterProvider?.shutdown();
				} catch {
					// best-effort flush — metrics must never block teardown either
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
