"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "agent-state.js"),
  "utf8"
);
const context = { AbortController, Error };
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.__core = AgentExecutionCore;`, context);
const core = context.__core;

test("agent execution captures one run and rejects replanning", () => {
  const execution = core.begin("run-1");
  assert.equal(execution.runId, "run-1");
  assert.equal(core.isActive("run-1", execution.generation), true);
  assert.throws(() => core.begin("run-2"), /already running/);
  assert.equal(core.current().runId, "run-1");
  core.finish("run-1", execution.generation);
});

test("cancellation aborts captured run and rejects late provider results", () => {
  const execution = core.begin("captured-run");
  assert.equal(core.cancel("different-run", execution.generation), false);
  assert.equal(execution.controller.signal.aborted, false);
  assert.equal(core.cancel("captured-run", execution.generation), true);
  assert.equal(execution.controller.signal.aborted, true);
  assert.equal(core.isActive("captured-run", execution.generation), false);
  assert.equal(core.finish("captured-run", execution.generation), false);
  assert.equal(core.current().state, "cancelling");
  assert.equal(core.finishCancel("captured-run", execution.generation), true);
  assert.equal(core.current(), null);
});

test("stale cancel generation cannot clear or overwrite a newer run", () => {
  const first = core.begin("run-1");
  core.cancel("run-1", first.generation);
  core.finishCancel("run-1", first.generation);
  const second = core.begin("run-2");
  assert.equal(core.cancel("run-1", first.generation), false);
  assert.equal(core.finishCancel("run-1", first.generation), false);
  assert.equal(core.isActive("run-2", second.generation), true);
  core.finish("run-2", second.generation);
});

test("provider sources are rebuilt exclusively from server pins", () => {
  const sources = core.sourcesFromRun({
    sourcePins: [{
      id: "source-1",
      title: "Pinned",
      content: "current server content",
      summary: "current",
      source: "",
      project: "P",
      tags: ["pin"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      lifecycle: "verified",
      opId: "device:2",
      contentHash: "hash"
    }]
  }, [{
    entry: { id: "source-1", content: "stale in-memory content" },
    score: 0.8
  }]);
  assert.equal(sources[0].entry.content, "current server content");
  assert.equal(sources[0].entry.status, "verified");
  assert.equal(sources[0].score, 0.8);
});

test("replanning resets prior results and advances proposal generation", () => {
  const state = {
    proposals: [{ id: "old" }],
    result: "old result",
    planGeneration: 4
  };
  const generation = core.resetPlanState(state);
  assert.equal(generation, 5);
  assert.deepEqual([...state.proposals], []);
  assert.equal(state.result, null);
});

test("proposal actions require matching run and plan generation", () => {
  const action = { runId: "run-current", generation: 8 };
  assert.equal(
    core.isProposalActionCurrent(action, "run-current", 8),
    true
  );
  assert.equal(
    core.isProposalActionCurrent(action, "run-new", 8),
    false
  );
  assert.equal(
    core.isProposalActionCurrent(action, "run-current", 9),
    false
  );
});
