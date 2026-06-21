import assert from "node:assert/strict";
import { test } from "node:test";

import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import type { RunState } from "../extensions/store.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import type { RunResult } from "../extensions/runner.ts";
import { emptyUsage } from "../extensions/usage.ts";
import { NOOP_TRACER, SPAN, type SpanAttributeValue, type SpanLike, type Tracer } from "../extensions/trace.ts";

// ---------------------------------------------------------------------------
// Recording tracer — an in-memory implementation of the Tracer seam. Verifies
// the runtime emits the run → phase → subagent span hierarchy with attributes.
// ---------------------------------------------------------------------------

interface RecordedSpan {
	name: string;
	parent: RecordedSpan | undefined;
	attributes: Record<string, SpanAttributeValue>;
	status?: { ok: boolean; message?: string };
	ended: boolean;
	endTime?: number;
}

function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
	const spans: RecordedSpan[] = [];
	const make = (rec: RecordedSpan): SpanLike => ({
		setAttributes(attrs) {
			for (const [k, v] of Object.entries(attrs)) if (v !== undefined) rec.attributes[k] = v;
		},
		setStatus(status) {
			rec.status = status;
		},
		end(endTime) {
			rec.ended = true;
			rec.endTime = endTime;
		},
	});
	const tracer: Tracer = {
		startSpan(name, opts) {
			const rec: RecordedSpan = {
				name,
				parent: opts?.parent ? (opts.parent as any).__rec : undefined,
				attributes: {},
				ended: false,
			};
			if (opts?.attributes) for (const [k, v] of Object.entries(opts.attributes)) if (v !== undefined) rec.attributes[k] = v;
			spans.push(rec);
			const span = make(rec) as any;
			span.__rec = rec;
			return span;
		},
	};
	return { tracer, spans };
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
		cwd: "/tmp/test-trace",
	};
}

function mockRunResult(output: string): RunResult {
	return { agent: "default", task: "", exitCode: 0, output, stderr: "", usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01 }, model: "test/model" };
}

test("trace: emits run → phase → subagent span hierarchy", async () => {
	const def = {
		name: "trace-flow",
		phases: [
			{ id: "a", type: "agent", task: "do a" },
			{ id: "b", type: "agent", task: "do b", dependsOn: ["a"] },
		],
	};
	const state = mkState(def, "trace-1");
	const { tracer, spans } = recordingTracer();
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		tracer,
		runTask: async (_cwd, _agents, _an, task) => mockRunResult(task),
	};

	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);

	const runSpans = spans.filter((s) => s.attributes["taskflow.span_kind"] === SPAN.run);
	const phaseSpans = spans.filter((s) => s.attributes["taskflow.span_kind"] === SPAN.phase);
	const subSpans = spans.filter((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent);

	// One run span, two phase spans, two subagent spans.
	assert.equal(runSpans.length, 1);
	assert.equal(phaseSpans.length, 2);
	assert.equal(subSpans.length, 2);

	// Span NAMES are descriptive (not the shared constant) so trace UIs that label
	// by operation name render a readable, per-phase/per-agent hierarchy.
	assert.equal(runSpans[0].name, "taskflow.run trace-flow");
	assert.ok(phaseSpans.some((p) => p.name === "phase:agent a"), "phase span named by type + id");
	assert.ok(subSpans.some((s) => s.name === "subagent default"), "subagent span named by agent");

	// All spans ended.
	assert.ok(spans.every((s) => s.ended), "every span must be ended");

	// Hierarchy: run is root, phases parent to run, subagents parent to phases.
	const run = runSpans[0];
	assert.equal(run.parent, undefined);
	assert.ok(phaseSpans.every((p) => p.parent === run), "phases parent to run span");
	assert.ok(subSpans.every((s) => s.parent && phaseSpans.includes(s.parent)), "subagents parent to a phase span");

	// Run-level attributes.
	assert.equal(run.attributes["taskflow.name"], "trace-flow");
	assert.equal(run.attributes["taskflow.run_id"], "trace-1");

	// EVERY span carries the run id so any span is filterable by run without
	// having to walk up to the root span.
	assert.ok(spans.every((s) => s.attributes["taskflow.run_id"] === "trace-1"), "every span must carry taskflow.run_id");
	assert.equal(run.attributes["taskflow.phase_count"], 2);
	assert.equal(run.attributes["taskflow.status"], "completed");
	assert.equal(run.status?.ok, true);

	// Phase-level attributes + GenAI usage convention.
	const phaseA = phaseSpans.find((p) => p.attributes["phase.id"] === "a");
	assert.ok(phaseA);
	assert.equal(phaseA.attributes["phase.status"], "done");
	assert.equal(phaseA.attributes["gen_ai.usage.input_tokens"], 10);
	assert.equal(phaseA.attributes["taskflow.usage.cost_usd"], 0.01);
	assert.equal(phaseA.attributes["cache.hit"], false);
});

test("trace: skipped phase emits a span with skip reason + topology", async () => {
	const def = {
		name: "trace-skip",
		phases: [
			{ id: "a", type: "agent", task: "do a" },
			// `when: false` → never runs; b should be skipped and still get a span.
			{ id: "b", type: "agent", task: "do b", dependsOn: ["a"], when: "false", agent: "default", optional: true },
		],
	};
	const state = mkState(def, "trace-skip-1");
	const { tracer, spans } = recordingTracer();
	const deps: RuntimeDeps = { cwd: "/tmp", agents: [dummyAgent], tracer, runTask: async (_c, _a, _n, t) => mockRunResult(t) };

	await executeTaskflow(state, deps);

	const phaseSpans = spans.filter((s) => s.attributes["taskflow.span_kind"] === SPAN.phase);
	const skipped = phaseSpans.find((p) => p.attributes["phase.id"] === "b");
	assert.ok(skipped, "skipped phase must still emit a span");
	assert.equal(skipped.attributes["phase.status"], "skipped");
	assert.ok(String(skipped.attributes["phase.skip_reason"]).includes("Condition not met"));
	// Static topology is attached even on skip.
	assert.equal(skipped.attributes["phase.agent"], "default");
	assert.equal(skipped.attributes["phase.optional"], true);
	assert.equal(skipped.attributes["phase.depends_on"], "a");
	assert.equal(skipped.attributes["phase.has_when"], true);

	// Run-level rollups reflect the skip.
	const run = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.run);
	assert.equal(run?.attributes["taskflow.phases_done"], 1);
	assert.equal(run?.attributes["taskflow.phases_skipped"], 1);
});

test("trace: subagent span carries exit code + timeout flags", async () => {
	const def = { name: "trace-sub", phases: [{ id: "a", type: "agent", task: "hi" }] };
	const state = mkState(def, "trace-sub-1");
	const { tracer, spans } = recordingTracer();
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		tracer,
		runTask: async () => ({ agent: "default", task: "", exitCode: 0, output: "ok", stderr: "", usage: emptyUsage(), model: "test/model", stopReason: "end_turn" }),
	};
	await executeTaskflow(state, deps);
	const sub = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent);
	assert.ok(sub);
	assert.equal(sub.attributes["subagent.exit_code"], 0);
	assert.equal(sub.attributes["subagent.stop_reason"], "end_turn");
	assert.equal(sub.attributes["subagent.timeout"], false);
	assert.equal(sub.attributes["gen_ai.response.model"], "test/model");
});

test("trace: failed phase marks span status not-ok", async () => {
	const def = { name: "trace-fail", phases: [{ id: "x", type: "agent", task: "boom" }] };
	const state = mkState(def, "trace-2");
	const { tracer, spans } = recordingTracer();
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		tracer,
		runTask: async () => ({ agent: "default", task: "", exitCode: 1, output: "", stderr: "kaboom", usage: emptyUsage(), errorMessage: "kaboom" }),
	};

	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, false);

	const run = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.run);
	const phase = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.phase);
	assert.equal(run?.status?.ok, false);
	assert.equal(phase?.status?.ok, false);
	assert.equal(phase?.attributes["phase.status"], "failed");
});

test("trace: content capture is on by default (task/output attributes present)", async () => {
	const def = { name: "trace-content-default", phases: [{ id: "a", type: "agent", task: "the task" }] };
	const state = mkState(def, "trace-content-default-1");
	const { tracer, spans } = recordingTracer();
	const prev = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
	delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
	try {
		const deps: RuntimeDeps = { cwd: "/tmp", agents: [dummyAgent], tracer, runTask: async (_c, _a, _n, t) => mockRunResult(`result of ${t}`) };
		await executeTaskflow(state, deps);
	} finally {
		if (prev === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = prev;
	}
	const sub = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent);
	const phase = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.phase);
	assert.equal(sub?.attributes["gen_ai.prompt"], "the task");
	assert.equal(sub?.attributes["subagent.output"], "result of the task");
	assert.equal(phase?.attributes["phase.output"], "result of the task");
});

test("trace: content capture can be disabled with the opt-out env var", async () => {
	const def = { name: "trace-content-off", phases: [{ id: "a", type: "agent", task: "secret task" }] };
	const state = mkState(def, "trace-content-off-1");
	const { tracer, spans } = recordingTracer();
	const prev = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
	process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "false";
	try {
		const deps: RuntimeDeps = { cwd: "/tmp", agents: [dummyAgent], tracer, runTask: async (_c, _a, _n, t) => mockRunResult(`result of ${t}`) };
		await executeTaskflow(state, deps);
	} finally {
		if (prev === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = prev;
	}
	const sub = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent);
	const phase = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.phase);
	assert.equal(sub?.attributes["subagent.output"], undefined);
	assert.equal(sub?.attributes["gen_ai.completion"], undefined);
	assert.equal(phase?.attributes["phase.output"], undefined);
});

test("trace: content capture surfaces truncated task + result when enabled", async () => {
	const def = { name: "trace-content-on", phases: [{ id: "a", type: "agent", task: "do the thing" }] };
	const state = mkState(def, "trace-content-on-1");
	const { tracer, spans } = recordingTracer();
	const prev = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
	const prevMax = process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS;
	process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
	process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS = "10";
	try {
		const deps: RuntimeDeps = { cwd: "/tmp", agents: [dummyAgent], tracer, runTask: async (_c, _a, _n, t) => mockRunResult(`RESULT-${"x".repeat(50)}`) };
		await executeTaskflow(state, deps);
	} finally {
		if (prev === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = prev;
		if (prevMax === undefined) delete process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS;
		else process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS = prevMax;
	}
	const sub = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent);
	// Head+tail truncation: max=10 → head=7, tail=3. "do the thing" (12) drops 2.
	assert.equal(sub?.attributes["gen_ai.prompt"], "do the \n…[truncated 2 chars]…\ning");
	const out = String(sub?.attributes["subagent.output"]);
	assert.ok(out.startsWith("RESULT-"), "output head present");
	assert.ok(out.includes("[truncated"), "output truncated to cap");
	const phase = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.phase);
	assert.ok(String(phase?.attributes["phase.output"]).includes("[truncated"), "phase output captured + truncated");
});

test("trace: head+tail truncation keeps content appended to the end (retry feedback)", async () => {
	const prev = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
	const prevMax = process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS;
	process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
	process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS = "100";
	try {
		// A large plan with a short, critical instruction appended at the very end —
		// exactly the shape of a retried executor task. Head-only truncation would
		// drop the tail; head+tail must preserve it.
		const task = "PLAN: " + "x".repeat(500) + " FIX_THE_FAILING_TEST_NOW";
		const { tracer, spans } = recordingTracer();
		const state = mkState({ name: "trace-tail", phases: [{ id: "a", type: "agent", task }] }, "trace-tail-1");
		await executeTaskflow(state, { cwd: "/tmp", agents: [dummyAgent], tracer, runTask: async () => mockRunResult("ok") });
		const sub = spans.find((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent);
		const prompt = String(sub?.attributes["gen_ai.prompt"]);
		assert.ok(prompt.startsWith("PLAN: xxx"), "head preserved");
		assert.ok(prompt.includes("…[truncated"), "middle dropped with marker");
		assert.ok(prompt.endsWith("FIX_THE_FAILING_TEST_NOW"), "tail (appended instruction) preserved");
	} finally {
		if (prev === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = prev;
		if (prevMax === undefined) delete process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS;
		else process.env.PI_TASKFLOW_OTEL_CONTENT_MAX_CHARS = prevMax;
	}
});

test("trace: gate-block retry tags the re-run subagent with is_retry + retry_feedback", async () => {
	// build (agent) → verify (gate, onBlock:retry). First verify blocks, forcing a
	// re-run of `build` with the gate feedback injected; second verify passes.
	const def = {
		name: "trace-retry",
		phases: [
			{ id: "build", type: "agent", task: "do the build" },
			{ id: "verify", type: "gate", dependsOn: ["build"], onBlock: "retry", retry: { max: 1 }, task: "check it" },
		],
	};
	const state = mkState(def, "trace-retry-1");
	const { tracer, spans } = recordingTracer();
	const prev = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
	process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
	let verifyCalls = 0;
	const runTask: RuntimeDeps["runTask"] = async (_c, _a, agent, _t) => {
		if (agent === "verifier" || _t === "check it") {
			verifyCalls++;
			const verdict = verifyCalls === 1 ? "tests failed at foo.test.ts\nVERDICT: BLOCK" : "VERDICT: PASS";
			return { agent: "verifier", task: "", exitCode: 0, output: verdict, stderr: "", usage: emptyUsage(), model: "m" };
		}
		return mockRunResult("built");
	};
	try {
		await executeTaskflow(state, { cwd: "/tmp", agents: [dummyAgent], tracer, runTask });
	} finally {
		if (prev === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = prev;
	}
	const buildSubs = spans.filter((s) => s.attributes["taskflow.span_kind"] === SPAN.subagent && s.attributes["phase.id"] === "build");
	assert.equal(buildSubs.length, 2, "build runs twice: initial + gate retry");
	// First build run: not a retry, no feedback.
	assert.equal(buildSubs[0].attributes["subagent.is_retry"], false);
	assert.equal(buildSubs[0].attributes["subagent.retry_feedback"], undefined);
	// Second build run: tagged as a retry, carrying the gate's block feedback.
	assert.equal(buildSubs[1].attributes["subagent.is_retry"], true);
	assert.ok(String(buildSubs[1].attributes["subagent.retry_feedback"]).includes("tests failed at foo.test.ts"), "gate feedback captured on the retried span");
});

test("trace: default no-op tracer does not throw and emits no records", async () => {
	const def = { name: "trace-noop", phases: [{ id: "a", type: "agent", task: "hi" }] };
	const state = mkState(def, "trace-3");
	// No tracer supplied → NOOP_TRACER path.
	const deps: RuntimeDeps = { cwd: "/tmp", agents: [dummyAgent], runTask: async (_c, _a, _n, t) => mockRunResult(t) };
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);

	// Sanity: the exported NOOP tracer is inert.
	const s = NOOP_TRACER.startSpan("x");
	s.setAttributes({ a: 1 });
	s.setStatus({ ok: true });
	s.end();
});
