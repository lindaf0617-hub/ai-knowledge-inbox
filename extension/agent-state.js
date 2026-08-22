const AgentExecutionCore = (() => {
  let execution = null;
  let nextGeneration = 1;

  function begin(runId) {
    if (execution) throw new Error("Agent execution already running");
    execution = {
      runId,
      generation: nextGeneration++,
      state: "running",
      cancelled: false,
      controller: new AbortController()
    };
    return execution;
  }

  function cancel(runId, generation) {
    if (!isCurrent(runId, generation)) return false;
    execution.cancelled = true;
    execution.state = "cancelling";
    execution.controller.abort();
    return true;
  }

  function isCurrent(runId, generation) {
    return Boolean(execution && execution.runId === runId &&
      execution.generation === generation);
  }

  function isActive(runId, generation) {
    return isCurrent(runId, generation) && execution.state === "running";
  }

  function finish(runId, generation) {
    if (!isCurrent(runId, generation) || execution.state === "cancelling") return false;
    execution = null;
    return true;
  }

  function finishCancel(runId, generation) {
    if (!isCurrent(runId, generation) || execution.state !== "cancelling") return false;
    execution = null;
    return true;
  }

  function sourcesFromRun(run, retrieved = []) {
    const scores = new Map(retrieved.map(item => [item.entry.id, Number(item.score) || 0]));
    if (!run || !Array.isArray(run.sourcePins) || !run.sourcePins.length) {
      throw new Error("Run has no pinned source snapshots");
    }

    return run.sourcePins.map(pin => ({
      entry: {
        id: pin.id,
        title: pin.title,
        content: pin.content,
        summary: pin.summary,
        source: pin.source,
        project: pin.project,
        tags: [...pin.tags],
        createdAt: pin.createdAt,
        updatedAt: pin.updatedAt,
        status: pin.lifecycle
      },
      score: scores.get(pin.id) || 0,
      pin: { ...pin }
    }));
  }

  function resetPlanState(state) {
    state.proposals = [];
    state.result = null;
    state.planGeneration = Number(state.planGeneration || 0) + 1;
    return state.planGeneration;
  }

  function isProposalActionCurrent(action, currentRunId, currentGeneration) {
    return Boolean(action && action.runId === currentRunId &&
      action.generation === currentGeneration);
  }

  return {
    begin,
    cancel,
    finish,
    finishCancel,
    isActive,
    isCurrent,
    isProposalActionCurrent,
    resetPlanState,
    sourcesFromRun,
    current: () => execution
  };
})();
