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

test("otel setup: fail-open — env set but @opentelemetry packages absent → undefined, no throw", () => {
	const prev = process.env[ENV_KEY];
	process.env[ENV_KEY] = "http://localhost:4318";
	// Silence the expected one-line warning so test output stays clean.
	const origErr = console.error;
	console.error = () => {};
	try {
		assert.equal(tracingEnabled(), true);
		// The OTel SDK packages are NOT a dependency of this repo, so setup must
		// degrade gracefully to undefined rather than crash the run.
		assert.equal(startTracing(), undefined);
	} finally {
		console.error = origErr;
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	}
});
