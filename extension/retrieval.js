const RetrievalGrounding = (() => {
  const MAX_EXCERPT_LENGTH = 260;
  const MAX_QUERY_LENGTH = 1200;
  const MAX_QUERY_TERMS = 256;

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
  }

  function normalizeQuery(question) {
    return String(question || "").trim().slice(0, MAX_QUERY_LENGTH);
  }

  function queryTerms(question) {
    const normalized = normalizeQuery(question).toLocaleLowerCase("zh-CN");
    const values = normalized.match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
    const terms = [];
    for (const value of values) {
      if (terms.length >= MAX_QUERY_TERMS) break;
      terms.push(value);
      if (/^[\u4e00-\u9fff]{3,}$/.test(value)) {
        for (let index = 0;
          index < value.length - 1 && terms.length < MAX_QUERY_TERMS;
          index += 1) {
          terms.push(value.slice(index, index + 2));
        }
      }
    }
    return [...new Set(terms)]
      .sort((left, right) => right.length - left.length)
      .slice(0, MAX_QUERY_TERMS);
  }

  function keywordScore(question, entry) {
    const terms = queryTerms(question);
    if (!terms.length) return 0;
    const title = String(entry.title || "").toLocaleLowerCase("zh-CN");
    const tags = (entry.tags || []).join(" ").toLocaleLowerCase("zh-CN");
    const project = String(entry.project || "").toLocaleLowerCase("zh-CN");
    const content = `${entry.summary || ""}\n${entry.content || ""}`.toLocaleLowerCase("zh-CN");
    return terms.reduce((score, term) => {
      if (title.includes(term)) score += 6;
      if (tags.includes(term)) score += 5;
      if (project.includes(term)) score += 4;
      if (content.includes(term)) score += 1;
      return score;
    }, 0);
  }

  function normalizeScore(semanticScore, keywordValue) {
    const semantic = clamp(semanticScore);
    const keyword = clamp(keywordValue / 12);
    return Number((semantic * 0.65 + keyword * 0.35).toFixed(4));
  }

  function excerpt(question, entry, maximumLength = MAX_EXCERPT_LENGTH) {
    const candidates = [entry.summary, entry.content]
      .map(value => String(value || "").trim())
      .filter(Boolean);
    const terms = queryTerms(question);
    const text = candidates.find(value => {
      const lower = value.toLocaleLowerCase("zh-CN");
      return terms.some(term => lower.includes(term));
    }) || candidates[0] || "";
    if (!text) return "";
    const limit = Math.max(80, Math.min(600, Number(maximumLength) || MAX_EXCERPT_LENGTH));
    const lower = text.toLocaleLowerCase("zh-CN");
    let matchIndex = -1;
    let matchLength = 0;
    terms.forEach(term => {
      const index = lower.indexOf(term);
      if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
        matchIndex = index;
        matchLength = term.length;
      }
    });
    if (text.length <= limit) return text;
    const center = matchIndex >= 0 ? matchIndex + Math.floor(matchLength / 2) : 0;
    let start = Math.max(0, center - Math.floor(limit / 2));
    start = Math.min(start, text.length - limit);
    const end = Math.min(text.length, start + limit);
    return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
  }

  function highlightSegments(text, question) {
    const value = String(text || "");
    const terms = queryTerms(question);
    if (!terms.length) return [{ text: value, match: false }];
    const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(${escaped.join("|")})`, "giu");
    const output = [];
    let lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > lastIndex) {
        output.push({ text: value.slice(lastIndex, match.index), match: false });
      }
      output.push({ text: match[0], match: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) output.push({ text: value.slice(lastIndex), match: false });
    return output.length ? output : [{ text: value, match: false }];
  }

  function retrieve(question, entries, similarity, limit = 8) {
    const normalizedQuestion = normalizeQuery(question);
    return entries
      .map(entry => {
        const semantic = clamp(similarity(normalizedQuestion, entry));
        const keyword = keywordScore(normalizedQuestion, entry);
        return {
          entry,
          score: normalizeScore(semantic, keyword),
          excerpt: excerpt(normalizedQuestion, entry)
        };
      })
      .filter(item => item.score >= 0.01)
      .sort((left, right) =>
        right.score - left.score ||
        new Date(right.entry.updatedAt || right.entry.createdAt) -
          new Date(left.entry.updatedAt || left.entry.createdAt)
      )
      .slice(0, limit);
  }

  return {
    MAX_QUERY_LENGTH,
    MAX_QUERY_TERMS,
    excerpt,
    highlightSegments,
    keywordScore,
    normalizeScore,
    normalizeQuery,
    queryTerms,
    retrieve
  };
})();
