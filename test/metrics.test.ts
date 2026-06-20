import assert from "node:assert/strict";
import { test } from "node:test";

import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { RunState } from "../extensions/store.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunResult } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";
import { type Counter, type Histogram, type Meter, METRIC, type MetricAttributes, NOOP_METER } from "../extensions/metrics.ts";

// ---------------------------------------------------------------------------
// Recording meter — an in-memory implementation of the Meter seam. Verifies the
// runtime records run/phase/subagent metrics with the expected dimensions.
// ---------------------------------------------------------------------------

interface Measurement {
	name: string;
	value: number;
	attrs: MetricAttributes;
}

function recordingMeter(): { meter: Meter; measurements: Measurement[] } {
	const measurements: Measurement[] = [];
	const make = (name: string): Counter & Histogram => ({
		add: (value, attrs) => measurements.push({ name, value, attrs: attrs ?? {} }),
		record: (value, attrs) => measurements.push({ name, value, attrs: attrs ?? {} }),
	});
	const meter: Meter = { counter: (name) => make(name), histogram: (name) => make(name) };
	return { meter, measurements };
}

const dummyAgent: AgentConfig = { name: "default", model: "test/model", description: "dummy", systemPrompt: "", source: "user", filePath: "none" };

function mkState(def: any, runId: string): RunState {
	return {
		runId,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp/test-metrics",
	};
}

function mockRunResult(output: string): RunResult {
	return { agent: "default", task: "", exitCode: 0, output, stderr: "", usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01 }, model: "test/model" };
}

test("metrics: records run, phase, and subagent instruments with dimensions", async () => {
	const def = {
		name: "metric-flow",
		phases: [
			{ id: "a", type: "agent", task: "do a" },
			{ id: "b", type: "agent", task: "do b", dependsOn: ["a"] },
		],
	};
	const state = mkState(def, "metric-1");
	const { meter, measurements } = recordingMeter();
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		meter,
		runTask: async (_cwd, _agents, _an, task) => mockRunResult(task),
	};

	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);

	const byName = (n: string) => measurements.filter((m) => m.name === n);

	// One run-level measurement per instrument.
	const runs = byName(METRIC.runs);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].attrs["taskflow.status"], "completed");
	assert.equal(runs[0].attrs["taskflow.name"], "metric-flow");
	assert.equal(byName(METRIC.runDuration).length, 1);
	assert.equal(byName(METRIC.runCost)[0].value, 0.02); // two phases × 0.01

	// Two phases recorded duration, cost, count, and a cache hit/miss sample.
	assert.equal(byName(METRIC.phases).length, 2);
	assert.equal(byName(METRIC.phaseDuration).length, 2);
	assert.equal(byName(METRIC.cacheHits).length, 2);
	assert.ok(byName(METRIC.phases).every((m) => m.attrs["phase.status"] === "done"));

	// Two subagent invocations recorded duration + token throughput (input+output).
	assert.equal(byName(METRIC.subagentDuration).length, 2);
	const tokens = byName(METRIC.subagentTokens);
	assert.equal(tokens.length, 4); // 2 subagents × {input, output}
	assert.ok(tokens.some((t) => t.attrs["gen_ai.token.type"] === "input" && t.value === 10));
	assert.ok(tokens.some((t) => t.attrs["gen_ai.token.type"] === "output" && t.value === 5));
});

test("metrics: retried subagent bumps the retry counter", async () => {
	const def = { name: "metric-retry", phases: [{ id: "x", type: "agent", task: "flaky", retry: { max: 2, backoffMs: 0 } }] };
	const state = mkState(def, "metric-2");
	const { meter, measurements } = recordingMeter();
	let calls = 0;
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		meter,
		runTask: async () => {
			calls++;
			// Fail first attempt, succeed second.
			return calls < 2
				? { agent: "default", task: "", exitCode: 1, output: "", stderr: "boom", usage: emptyUsage(), errorMessage: "boom" }
				: mockRunResult("ok");
		},
	};

	await executeTaskflow(state, deps);
	const retries = measurements.filter((m) => m.name === METRIC.subagentRetries);
	assert.equal(retries.length, 1, "one retry recorded");
	assert.equal(retries[0].attrs["retry.reason"], "policy");
});

test("metrics: default no-op meter is inert and does not throw", async () => {
	const def = { name: "metric-noop", phases: [{ id: "a", type: "agent", task: "hi" }] };
	const state = mkState(def, "metric-3");
	const deps: RuntimeDeps = { cwd: "/tmp", agents: [dummyAgent], runTask: async (_c, _a, _n, t) => mockRunResult(t) };
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);

	// Sanity: exported NOOP meter instruments are inert.
	NOOP_METER.counter("x").add(1, { a: 1 });
	NOOP_METER.histogram("y").record(2, { b: "z" });
});
