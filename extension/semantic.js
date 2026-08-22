const SemanticSearch = (() => {
  const DIMENSIONS = 384;
  const CONCEPTS = [
    ["security", "cyber", "protection", "安全", "网络安全", "防护", "漏洞", "攻击", "权限", "合规"],
    ["agent", "agents", "智能体", "代理", "工作流", "automation", "自动化"],
    ["product", "产品", "需求", "用户", "mvp", "原型", "roadmap", "路线图"],
    ["code", "coding", "development", "代码", "编程", "开发", "调试", "重构", "api"],
    ["data", "analytics", "数据", "分析", "指标", "报表", "数据库", "sql"],
    ["meeting", "会议", "纪要", "讨论", "行动项", "决策"],
    ["customer", "sales", "客户", "销售", "商机", "报价", "合同"],
    ["research", "研究", "调研", "洞察", "报告", "论文"],
    ["writing", "content", "写作", "内容", "文案", "文章", "摘要", "翻译"],
    ["ai", "artificial intelligence", "人工智能", "大模型", "llm", "生成式"]
  ];

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  }

  function tokens(text) {
    const normalized = String(text || "")
      .toLocaleLowerCase("zh-CN")
      .replace(/https?:\/\/\S+/g, " ")
      .slice(0, 16000);
    const values = normalized.match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]+/g) || [];
    const output = [];
    values.forEach(value => {
      output.push(value);
      if (/^[\u4e00-\u9fff]{3,}$/.test(value)) {
        for (let index = 0; index < value.length - 1; index += 1) {
          output.push(value.slice(index, index + 2));
        }
      }
    });
    CONCEPTS.forEach((concept, index) => {
      if (concept.some(term => normalized.includes(term))) {
        output.push(`__concept_${index}`, `__concept_${index}`, `__concept_${index}`);
      }
    });
    return output;
  }

  function embed(text) {
    const vector = new Float32Array(DIMENSIONS);
    tokens(text).forEach(token => {
      const tokenHash = hash(token);
      const position = tokenHash % DIMENSIONS;
      const sign = tokenHash & 1 ? 1 : -1;
      vector[position] += sign;
    });
    let magnitude = 0;
    vector.forEach(value => { magnitude += value * value; });
    magnitude = Math.sqrt(magnitude);
    if (magnitude) {
      for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
    }
    return vector;
  }

  function entryText(entry) {
    return [
      entry.title, entry.title, entry.title,
      entry.project, entry.project,
      entry.tags.join(" "), entry.tags.join(" "),
      entry.summary || "",
      entry.content
    ].join("\n");
  }

  function similarity(query, entry) {
    const left = embed(query);
    const right = embed(entryText(entry));
    let score = 0;
    for (let index = 0; index < DIMENSIONS; index += 1) score += left[index] * right[index];
    return score;
  }

  return { embed, similarity };
})();
