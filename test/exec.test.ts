/**
 * Tests for the `exec` phase type: deterministic `bash -c` steps with no
 * subagent. Covers exit-code -> status mapping, stdout capture, JSON parsing,
 * timeout, interpolation, zero usage, and schema validation (cmd required;
 * exec forbidden in dynamic sub-flows).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTaskflow, type RuntimeDeps } from "../extensions/runtime.ts";
import { validateTaskflow, type Taskflow } from "../extensions/schema.ts";
import type { RunState } from "../extensions/store.ts";

function mkState(def: Taskflow, args: Record<string, unknown> = {}): RunState {
	return {
		runId: "test-run",
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

// exec must never invoke the model — this runner throws if it's ever called.
const deps: RuntimeDeps = {
	cwd: "/tmp",
	agents: [],
	runTask: (async () => {
		throw new Error("runTask must not be called for an exec phase");
	}) as RuntimeDeps["runTask"],
	persist: () => {},
	onProgress: () => {},
};

test("exec: exit 0 -> done, stdout is the (trimmed) output", async () => {
	const def: Taskflow = { name: "exec-ok", phases: [{ id: "e", type: "exec", cmd: "echo hello" }] };
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.phases.e.status, "done");
	assert.equal(res.state.phases.e.output, "hello");
});

test("exec: output:'json' parses stdout into .json", async () => {
	const def: Taskflow = {
		name: "exec-json",
		phases: [{ id: "e", type: "exec", output: "json", cmd: "echo '{\"a\":1,\"b\":\"x\"}'" }],
	};
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.phases.e.status, "done");
	assert.deepEqual(res.state.phases.e.json, { a: 1, b: "x" });
});

test("exec: usage is zero (no model cost)", async () => {
	const def: Taskflow = { name: "exec-usage", phases: [{ id: "e", type: "exec", cmd: "echo hi" }] };
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.phases.e.usage?.cost, 0);
	assert.equal(res.state.phases.e.usage?.turns, 0);
});

test("exec: interpolates {args.X} and {steps.X} into the command", async () => {
	const def: Taskflow = {
		name: "exec-interp",
		phases: [
			{ id: "first", type: "exec", cmd: "echo one" },
			{ id: "second", type: "exec", cmd: "echo '{args.who}-{steps.first.output}'", dependsOn: ["first"], final: true },
		],
	};
	const res = await executeTaskflow(mkState(def, { who: "bob" }), deps);
	assert.equal(res.state.phases.second.output, "bob-one");
});

test("exec: non-zero exit -> failed with the exit code in error", async () => {
	const def: Taskflow = { name: "exec-fail", phases: [{ id: "e", type: "exec", cmd: "exit 3" }] };
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.phases.e.status, "failed");
	assert.match(res.state.phases.e.error ?? "", /exited 3/);
});

test("exec: exceeding timeoutMs -> failed with 'timed out'", async () => {
	const def: Taskflow = { name: "exec-timeout", phases: [{ id: "e", type: "exec", cmd: "sleep 5", timeoutMs: 100 }] };
	const res = await executeTaskflow(mkState(def), deps);
	assert.equal(res.state.phases.e.status, "failed");
	assert.match(res.state.phases.e.error ?? "", /timed out/);
});

test("validate: exec requires cmd", () => {
	const r = validateTaskflow({ name: "v", phases: [{ id: "e", type: "exec" }] });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => /exec\) requires 'cmd'/.test(e)), r.errors.join("; "));
});

test("validate: a well-formed exec flow is valid", () => {
	const r = validateTaskflow({ name: "v", phases: [{ id: "e", type: "exec", cmd: "echo hi" }] });
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("validate: exec is rejected in dynamic (LLM-generated) sub-flows", () => {
	const r = validateTaskflow({ name: "v", phases: [{ id: "e", type: "exec", cmd: "rm -rf /" }] }, { dynamic: true, cwd: "/tmp" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => /'exec' is not allowed in generated flows/.test(e)), r.errors.join("; "));
});
