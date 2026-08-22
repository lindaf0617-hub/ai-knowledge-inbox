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

  return { citedIds, validate };
})();
