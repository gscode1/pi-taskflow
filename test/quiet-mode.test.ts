import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveQuiet } from "../extensions/index.ts";

// resolveQuiet decides whether the live-update stream emits only on phase
// transitions (quiet) or every heartbeat frame. Quiet is the default for
// headless/scheduled runs — that is the case whose transcript otherwise bloats
// into the hundreds of MB — while interactive TUI sessions stay live.

test("resolveQuiet: explicit env wins regardless of UI", () => {
	assert.equal(resolveQuiet("1", true), true);
	assert.equal(resolveQuiet("1", false), true);
	assert.equal(resolveQuiet("0", true), false);
	assert.equal(resolveQuiet("0", false), false);
});

test("resolveQuiet: unset → quiet when headless, live when a UI is present", () => {
	assert.equal(resolveQuiet(undefined, false), true); // headless/scheduled → quiet (the bloat fix)
	assert.equal(resolveQuiet(undefined, true), false); // interactive TUI → live frames
});

test("resolveQuiet: unrecognized env value falls back to the UI-aware default", () => {
	assert.equal(resolveQuiet("yes", false), true);
	assert.equal(resolveQuiet("", true), false);
});
