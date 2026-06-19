import assert from "node:assert/strict";
import { test } from "node:test";

import { startTracing, tracingEnabled } from "../extensions/otel/setup.ts";

const ENV_KEY = "OTEL_EXPORTER_OTLP_ENDPOINT";

test("otel setup: disabled when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
	const prev = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	try {
		assert.equal(tracingEnabled(), false);
		assert.equal(startTracing(), undefined);
	} finally {
		if (prev !== undefined) process.env[ENV_KEY] = prev;
	}
});

test("otel setup: env set → never throws; returns undefined OR a valid session", async () => {
	const prev = process.env[ENV_KEY];
	process.env[ENV_KEY] = "http://localhost:4318";
	// Silence the warning emitted on the fail-open (packages-absent) path.
	const origErr = console.error;
	console.error = () => {};
	try {
		assert.equal(tracingEnabled(), true);
		// The OTel SDK packages are optional and not declared deps of this repo.
		// The contract is fail-OPEN: setup must never throw. The result is either
		// `undefined` (packages not installed) or a usable { tracer, shutdown }
		// session (packages present) — both are valid; assert the shape, not which.
		const session = startTracing("pi-taskflow-test");
		if (session !== undefined) {
			assert.equal(typeof session.tracer.startSpan, "function");
			assert.equal(typeof session.shutdown, "function");
			// Exercising the seam must not throw, and shutdown must resolve.
			const span = session.tracer.startSpan("setup.test.span");
			span.setStatus({ ok: true });
			span.end();
			await session.shutdown();
		}
	} finally {
		console.error = origErr;
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	}
});
