/**
 * Detached runner — spawned as a child process for background (detached) runs.
 *
 * Reads a context JSON file (path passed as argv[2]), calls executeTaskflow,
 * and persists the terminal state.  Top-level try/catch writes status "failed"
 * on crash.  Approval phases auto-reject in detached mode (no interactive
 * approver available).
 *
 * This file is NOT imported by index.ts — it is spawned via `child_process.spawn`.
 */

import { readFileSync } from "node:fs";
import { type AgentScope, discoverAgents, readSubagentSettings } from "./agents.ts";
import { executeTaskflow } from "./runtime.ts";
import { startTracing } from "./otel/setup.ts";
import { getFlow, loadRun, saveRun, DEFAULT_KEPT_RUNS, DEFAULT_RUN_AGE_DAYS } from "./store.ts";

interface DetachContext {
	runId: string;
	defName: string;
	args: Record<string, unknown>;
	cwd: string;
}

const contextPath = process.argv[2];
if (!contextPath) {
	console.error("[detached-runner] Missing context file path argument");
	process.exit(1);
}

let ctx: DetachContext;
try {
	ctx = JSON.parse(readFileSync(contextPath, "utf-8")) as DetachContext;
} catch (e) {
	console.error(`[detached-runner] Failed to read context: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}

const cleanupConfig = { maxKeep: DEFAULT_KEPT_RUNS, maxAgeDays: DEFAULT_RUN_AGE_DAYS };

try {
	const state = loadRun(ctx.cwd, ctx.runId);
	if (!state) {
		console.error(`[detached-runner] Run not found: ${ctx.runId}`);
		process.exit(1);
	}

	// Re-discover agents using the same settings as the host session.
	const settings = readSubagentSettings();
	cleanupConfig.maxKeep = settings.taskflow.maxKeptRuns;
	cleanupConfig.maxAgeDays = settings.taskflow.maxRunAgeDays;
	const scope: AgentScope = state.def.agentScope ?? "user";
	const { agents } = discoverAgents(ctx.cwd, scope, settings.modelRoles, settings.providerRoles, settings.taskflow);

	// Opt-in OpenTelemetry (same env gate as the host). Background runs live in
	// their own process, so we MUST flush spans before exiting or they're lost.
	const tracing = startTracing();

	// Graceful pause: a `/tf pause <runId>` sends SIGTERM to this process. Abort
	// the run signal so the runtime finishes the in-flight phase, marks the run
	// "paused" (resumable), and persists — instead of dying mid-phase as "running".
	const controller = new AbortController();
	const onPauseSignal = () => controller.abort();
	process.on("SIGTERM", onPauseSignal);
	process.on("SIGINT", onPauseSignal);

	try {
		const result = await executeTaskflow(state, {
			cwd: ctx.cwd,
			agents,
			globalThinking: settings.globalThinking,
			signal: controller.signal,
			persist: (s) => saveRun(s, cleanupConfig),
			// No requestApproval — approval phases auto-reject in detached/CI mode
			// (safety: approval gates are never bypassed; the run records the rejection).
			loadFlow: (name: string) => getFlow(ctx.cwd, name)?.def,
			tracer: tracing?.tracer,
		});

		saveRun(result.state, cleanupConfig);
	} finally {
		process.off("SIGTERM", onPauseSignal);
		process.off("SIGINT", onPauseSignal);
		await tracing?.shutdown();
	}
} catch (e) {
	// Top-level catch: persist failure so the host can poll the terminal state.
	const message = e instanceof Error ? e.message : String(e);
	console.error(`[detached-runner] Fatal: ${message}`);
	try {
		const state = loadRun(ctx.cwd, ctx.runId);
		if (state && state.status === "running") {
			state.status = "failed";
			saveRun(state, cleanupConfig);
		}
	} catch {
		// Best-effort — if we can't even load the state, there's nothing to persist.
	}
	process.exit(1);
}
