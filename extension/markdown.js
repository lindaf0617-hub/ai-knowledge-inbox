const MarkdownRenderer = (() => {
  function appendInline(parent, text) {
    const tokenPattern = /(\*\*[^*\n]+\*\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
    let lastIndex = 0;

    for (const match of text.matchAll(tokenPattern)) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
      const token = match[0];
      let element;

      if (token.startsWith("**")) {
        element = document.createElement("strong");
        element.textContent = token.slice(2, -2);
      } else if (token.startsWith("_")) {
        element = document.createElement("em");
        element.textContent = token.slice(1, -1);
      } else if (token.startsWith("`")) {
        element = document.createElement("code");
        element.textContent = token.slice(1, -1);
      } else {
        const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
        element = document.createElement("a");
        element.textContent = parts[1];
        element.href = parts[2];
        element.target = "_blank";
        element.rel = "noopener noreferrer";
      }

      parent.append(element);
      lastIndex = match.index + token.length;
    }
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }

  function render(container, markdown) {
    container.replaceChildren();
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    let activeList = null;

    function closeList() {
      activeList = null;
    }

    while (index < lines.length) {
      const line = lines[index];
      const blockLine = line.trimStart();

      if (blockLine.startsWith("```")) {
        closeList();
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        index += 1;
        continue;
      }

      const heading = blockLine.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        closeList();
        const element = document.createElement(`h${heading[1].length}`);
        appendInline(element, heading[2]);
        container.append(element);
        index += 1;
        continue;
      }

      const listItem = line.match(/^\s*(-|\d+\.)\s+(.+)$/);
      if (listItem) {
        const listType = listItem[1] === "-" ? "ul" : "ol";
        if (!activeList || activeList.tagName.toLowerCase() !== listType) {
          activeList = document.createElement(listType);
          container.append(activeList);
        }
        const item = document.createElement("li");
        appendInline(item, listItem[2]);
        activeList.append(item);
        index += 1;
        continue;
      }

      if (blockLine.startsWith("> ")) {
        closeList();
        const quote = document.createElement("blockquote");
        const quoteLines = [];
        while (index < lines.length && lines[index].trimStart().startsWith("> ")) {
          quoteLines.push(lines[index].trimStart().slice(2));
          index += 1;
        }
        appendInline(quote, quoteLines.join("\n"));
        container.append(quote);
        continue;
      }

      if (!line.trim()) {
        closeList();
        index += 1;
        continue;
      }

      closeList();
      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() &&
        !/^(#{1,6})\s+|^```|^\s*(-|\d+\.)\s+|^> /.test(lines[index])) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement("p");
      appendInline(paragraph, paragraphLines.join("\n"));
      container.append(paragraph);
    }
  }

  return { render };
})();
