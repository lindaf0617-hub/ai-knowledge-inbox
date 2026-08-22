"use strict";

const agentState = {
  entries: [],
  sources: [],
  run: null,
  proposals: [],
  result: null,
  planGeneration: 0
};

const agentElements = {
  form: document.getElementById("agentForm"),
  goal: document.getElementById("goal"),
  outputFormat: document.getElementById("outputFormat"),
  project: document.getElementById("project"),
  timeRange: document.getElementById("timeRange"),
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  modelLabel: document.getElementById("modelLabel"),
  runButton: document.getElementById("runButton"),
  cancelButton: document.getElementById("cancelButton"),
  status: document.getElementById("status"),
  planPanel: document.getElementById("planPanel"),
  planSummary: document.getElementById("planSummary"),
  sources: document.getElementById("sources"),
  resultPanel: document.getElementById("resultPanel"),
  analysis: document.getElementById("analysis"),
  proposalPanel: document.getElementById("proposalPanel"),
  proposals: document.getElementById("proposals")
};

I18n.bindPicker(document.getElementById("languagePicker"));

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function setStatus(value, error = false) {
  agentElements.status.textContent = value;
  agentElements.status.classList.toggle("danger", error);
}

function setExecutionControls(running) {
  agentElements.form.querySelectorAll("input, textarea, select, button")
    .forEach(element => {
      if (element === agentElements.cancelButton) return;
      if (running) {
        element.dataset.agentWasDisabled = String(element.disabled);
        element.disabled = true;
      } else {
        element.disabled = element.dataset.agentWasDisabled === "true";
        delete element.dataset.agentWasDisabled;
      }
    });
  agentElements.cancelButton.disabled = !running;
  agentElements.cancelButton.classList.toggle("hidden", !running);
}

function scopedEntries() {
  const project = agentElements.project.value;
  const days = Number(agentElements.timeRange.value);
  const threshold = Number.isFinite(days) && days > 0
    ? Date.now() - days * 24 * 60 * 60 * 1000
    : 0;
  return agentState.entries.filter(entry =>
    entry.status !== "deprecated" &&
    (!project || entry.project === project) &&
    (!threshold || new Date(entry.updatedAt || entry.createdAt).getTime() >= threshold)
  );
}

function renderSources() {
  agentElements.sources.replaceChildren();
  agentState.sources.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "source";
    card.append(
      text("h3", `K${index + 1} · ${item.entry.title}`),
      text("p", item.excerpt),
      text("div", `${I18n.t("检索匹配度")} ${(item.score * 100).toFixed(1)}% · ID ${item.entry.id}`, "meta")
    );
    agentElements.sources.append(card);
  });
}

async function makePlan() {
  if (AgentExecutionCore.current()) {
    throw new Error(I18n.t("Agent 正在运行，不能重新规划"));
  }
  AgentExecutionCore.resetPlanState(agentState);
  agentElements.analysis.replaceChildren();
  agentElements.proposals.replaceChildren();
  agentElements.resultPanel.classList.add("hidden");
  agentElements.proposalPanel.classList.add("hidden");
  const goal = agentElements.goal.value.trim();
  if (!goal) throw new Error(I18n.t("请先输入目标"));
  if (agentState.run && agentState.run.status === "planned") {
    agentState.run = await KnowledgeStore.transitionAgentRun(agentState.run.id, "cancel");
  }
  const candidates = scopedEntries();
  agentState.sources = RetrievalGrounding.retrieve(
    goal,
    candidates,
    (query, entry) => SemanticSearch.similarity(query, entry),
    8
  );
  if (!agentState.sources.length) throw new Error(I18n.t("没有找到足够相关的知识"));
  const now = Date.now();
  const days = Number(agentElements.timeRange.value);
  const startAt = Number.isFinite(days) && days > 0
    ? new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
    : "";
  const plan = {
    steps: ["local-retrieval", "grounded-analysis", "proposal-review"],
    sourceCount: agentState.sources.length,
    externalSupplementation: false
  };
  const retrievedSources = agentState.sources;
  agentState.run = await KnowledgeStore.createAgentRun({
    goal,
    outputFormat: agentElements.outputFormat.value,
    provider: agentElements.provider.value,
    model: agentElements.provider.value === "ollama" ? agentElements.model.value : "",
    sourceIds: agentState.sources.map(item => item.entry.id),
    plan,
    permissionScope: {
      project: agentElements.project.value,
      startAt,
      endAt: new Date(now).toISOString(),
      externalSupplementation: false
    }
  });
  agentState.sources = AgentExecutionCore.sourcesFromRun(
    agentState.run,
    retrievedSources
  ).map(item => ({
    ...item,
    excerpt: RetrievalGrounding.excerpt(goal, item.entry)
  }));
  agentElements.planSummary.textContent = I18n.getLanguage() === "en"
    ? `Plan: read ${agentState.sources.length} local items, generate ${
      agentElements.outputFormat.selectedOptions[0].textContent
    }, then present approval-gated candidate cards.`
    : `计划：仅在本地读取 ${agentState.sources.length} 条知识，生成 ${
      agentElements.outputFormat.selectedOptions[0].textContent
    }和待审批候选卡。`;
  renderSources();
  agentElements.planPanel.classList.remove("hidden");
  agentElements.runButton.classList.remove("hidden");
  agentElements.cancelButton.classList.remove("hidden");
  setStatus(I18n.t("计划已保存。确认来源后点击“运行 Agent”。"));
}

function proposalCard(proposal, runId, generation) {
  const card = document.createElement("article");
  card.className = `proposal ${proposal.status}`;
  card.dataset.proposalId = proposal.id;
  card.dataset.runId = runId;
  card.dataset.planGeneration = String(generation);
  card.dataset.idempotencyKey = crypto.randomUUID();
  card.append(
    text("h3", proposal.title),
    text("p", proposal.summary || proposal.content)
  );
  if (proposal.summary && proposal.content !== proposal.summary) {
    const details = document.createElement("details");
    details.append(text("summary", I18n.t("查看候选正文")), text("p", proposal.content));
    card.append(details);
  }
  card.append(
    text("div", `${proposal.project || "—"} · ${(proposal.confidence * 100).toFixed(0)}% · ${proposal.sourceIds.join(", ")}`, "meta"),
    text("p", proposal.rationale, "meta")
  );
  const actions = document.createElement("div");
  actions.className = "actions";
  const lifecycle = document.createElement("select");
  lifecycle.append(new Option("draft", "draft"), new Option("verified", "verified"));
  const approve = text("button", I18n.t("批准写入"));
  approve.type = "button";
  const reject = text("button", I18n.t("拒绝"));
  reject.type = "button";
  const undo = text("button", I18n.t("撤销写入"));
  undo.type = "button";
  undo.className = "button hidden";
  approve.className = reject.className = "button";
  const actionContext = { runId, generation };
  const currentAction = () => {
    const current = AgentExecutionCore.isProposalActionCurrent(
      actionContext,
      agentState.run?.id,
      agentState.planGeneration
    );
    if (!current) {
      approve.disabled = reject.disabled = undo.disabled = lifecycle.disabled = true;
      setStatus(I18n.t("此候选属于旧运行，操作已拒绝"), true);
    }
    return current;
  };
  approve.addEventListener("click", async () => {
    if (!currentAction()) return;
    try {
      const result = await KnowledgeStore.decideProposal(proposal.id, "approve", {
        approvedBy: "local-user",
        entryStatus: lifecycle.value,
        idempotencyKey: card.dataset.idempotencyKey
      });
      if (!currentAction()) return;
      proposal.status = result.proposal.status;
      card.classList.add("approved");
      approve.disabled = reject.disabled = lifecycle.disabled = true;
      undo.classList.remove("hidden");
      setStatus(I18n.t("候选知识已批准并写入"));
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  reject.addEventListener("click", async () => {
    if (!currentAction()) return;
    try {
      await KnowledgeStore.decideProposal(proposal.id, "reject", { rejectedBy: "local-user" });
      if (!currentAction()) return;
      proposal.status = "rejected";
      card.classList.add("rejected");
      approve.disabled = reject.disabled = lifecycle.disabled = true;
      setStatus(I18n.t("候选知识已拒绝"));
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  undo.addEventListener("click", async () => {
    if (!currentAction()) return;
    try {
      await KnowledgeStore.decideProposal(proposal.id, "undo", { actor: "local-user" });
      if (!currentAction()) return;
      undo.disabled = true;
      setStatus(I18n.t("写入已撤销；知识已标记 deprecated"));
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  actions.append(lifecycle, approve, reject, undo);
  card.append(actions);
  return card;
}

async function runAgent() {
  if (!agentState.run || agentState.run.status !== "planned") return;
  const executionRun = Object.freeze({ ...agentState.run });
  const planGeneration = agentState.planGeneration;
  const executionSources = [...agentState.sources];
  const execution = AgentExecutionCore.begin(executionRun.id);
  setExecutionControls(true);
  try {
    agentState.run = await KnowledgeStore.transitionAgentRun(executionRun.id, "start");
    setStatus(I18n.t("Agent 正在本地分析…"));
    const provider = AIProviders.get(executionRun.provider);
    const envelope = await provider.agent(
      executionRun.goal,
      executionSources,
      {
        outputFormat: executionRun.outputFormat,
        project: executionRun.permissionScope.project
      },
      I18n.getLanguage(),
      {
        provider: executionRun.provider,
        ollamaModel: executionRun.model,
        signal: execution.controller.signal
      }
    );
    if (!AgentExecutionCore.isActive(executionRun.id, execution.generation)) return;
    agentState.proposals = [];
    for (const proposal of envelope.proposals) {
      if (!AgentExecutionCore.isActive(executionRun.id, execution.generation)) return;
      agentState.proposals.push(
        await KnowledgeStore.createProposal(executionRun.id, proposal)
      );
    }
    if (!AgentExecutionCore.isActive(executionRun.id, execution.generation)) return;
    agentState.run = await KnowledgeStore.transitionAgentRun(
      executionRun.id,
      "complete",
      { result: envelope.analysisMarkdown }
    );
    agentState.result = envelope.analysisMarkdown;
    MarkdownRenderer.render(agentElements.analysis, envelope.analysisMarkdown);
    agentElements.resultPanel.classList.remove("hidden");
    agentElements.proposals.replaceChildren();
    agentState.proposals.forEach(proposal =>
      agentElements.proposals.append(
        proposalCard(proposal, executionRun.id, planGeneration)
      )
    );
    agentElements.proposalPanel.classList.remove("hidden");
    setStatus(I18n.t("Agent 已完成。请逐条审查候选知识。"));
  } catch (error) {
    if (!AgentExecutionCore.isActive(executionRun.id, execution.generation)) {
      setStatus(I18n.t("Agent 运行已取消"));
      return;
    }
    if (agentState.run && agentState.run.id === executionRun.id &&
        agentState.run.status === "running") {
      try {
        agentState.run = await KnowledgeStore.transitionAgentRun(
          executionRun.id,
          "fail",
          { error: error.message }
        );
      } catch {}
    }
    setStatus(error.message, true);
  } finally {
    if (AgentExecutionCore.finish(executionRun.id, execution.generation)) {
      setExecutionControls(false);
    }
  }
}

agentElements.form.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    agentElements.runButton.classList.add("hidden");
    agentElements.cancelButton.classList.add("hidden");
    await makePlan();
  } catch (error) {
    setStatus(error.message, true);
  }
});

agentElements.runButton.addEventListener("click", runAgent);
agentElements.cancelButton.addEventListener("click", async () => {
  let execution = AgentExecutionCore.current();
  const runId = execution?.runId ||
    (agentState.run?.status === "planned" ? agentState.run.id : "");
  if (!runId) return;
  if (!execution) {
    execution = AgentExecutionCore.begin(runId);
    setExecutionControls(true);
  }
  const generation = execution.generation;
  AgentExecutionCore.cancel(runId, generation);
  agentElements.cancelButton.disabled = true;
  try {
    const cancelledRun = await KnowledgeStore.transitionAgentRun(runId, "cancel");
    if (!AgentExecutionCore.isCurrent(runId, generation)) return;
    agentState.run = cancelledRun;
    agentElements.runButton.classList.add("hidden");
    setStatus(I18n.t("Agent 运行已取消"));
  } catch (error) {
    if (!AgentExecutionCore.isCurrent(runId, generation)) return;
    setStatus(error.message, true);
  } finally {
    if (AgentExecutionCore.finishCancel(runId, generation)) {
      setExecutionControls(false);
    }
  }
});
agentElements.provider.addEventListener("change", () => {
  agentElements.modelLabel.classList.toggle("hidden", agentElements.provider.value !== "ollama");
});
document.getElementById("backButton").addEventListener("click", () => {
  location.href = "library.html";
});

(async () => {
  try {
    agentState.entries = await KnowledgeStore.getEntries();
    const projects = [...new Set(agentState.entries.map(entry => entry.project).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    projects.forEach(project => agentElements.project.append(new Option(project, project)));
    agentElements.provider.dispatchEvent(new Event("change"));
  } catch (error) {
    setStatus(error.message, true);
  }
})();
