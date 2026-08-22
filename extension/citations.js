const CitationGuard = (() => {
  function citedIds(answer) {
    return [...String(answer || "").matchAll(/\[K(\d+)\]/g)]
      .map(match => Number(match[1]));
  }

  function validate(answer, sourceCount) {
    const ids = citedIds(answer);
    const invalid = [...new Set(ids.filter(id => id < 1 || id > sourceCount))];
    const paragraphs = String(answer || "")
      .split(/\n{2,}/)
      .map(value => value.trim())
      .filter(value =>
        value &&
        !/^#{1,6}\s/.test(value) &&
        !/^\|?[-:|\s]+\|?$/.test(value)
      );
    const uncited = paragraphs.filter(value =>
      value.length >= 45 &&
      !/\[K\d+\]/.test(value)
    );
    return {
      cited: [...new Set(ids.filter(id => id >= 1 && id <= sourceCount))],
      invalid,
      uncited,
      valid: ids.length > 0 && invalid.length === 0
    };
  }

  function splitTokens(text) {
    const value = String(text || "");
    const output = [];
    let lastIndex = 0;
    for (const match of value.matchAll(/\[K(\d+)\]/g)) {
      if (match.index > lastIndex) {
        output.push({ type: "text", value: value.slice(lastIndex, match.index) });
      }
      output.push({ type: "citation", value: match[0], id: Number(match[1]) });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) output.push({ type: "text", value: value.slice(lastIndex) });
    return output;
  }

  function normalizeCitationLinks(markdown) {
    return String(markdown || "").replace(
      /\[K(\d+)\]\([^)\r\n]*\)/g,
      (_match, id) => `[K${id}]`
    );
  }

  return { citedIds, normalizeCitationLinks, splitTokens, validate };
})();
