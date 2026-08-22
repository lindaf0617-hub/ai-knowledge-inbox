(() => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";

  const fragment = selection.getRangeAt(0).cloneContents();

  function cleanBlock(value) {
    return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function convert(node, listDepth = 0) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return "";
    }

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return Array.from(node.childNodes)
        .map(child => child.nodeType === Node.TEXT_NODE && !(child.textContent || "").trim()
          ? ""
          : convert(child, listDepth))
        .join("");
    }

    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes)
      .map(child => convert(child, listDepth))
      .join("");

    if (tag === "br") return "\n";
    if (/^h[1-6]$/.test(tag)) {
      return `${"#".repeat(Number(tag.slice(1)))} ${cleanBlock(children())}\n\n`;
    }
    if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
      const value = cleanBlock(children());
      return value ? `${value}\n\n` : "";
    }
    if (tag === "strong" || tag === "b") return `**${children()}**`;
    if (tag === "em" || tag === "i") return `_${children()}_`;
    if (tag === "code" && node.parentElement && node.parentElement.tagName.toLowerCase() === "pre") {
      return node.textContent || "";
    }
    if (tag === "code") return `\`${(node.textContent || "").replace(/`/g, "\\`")}\``;
    if (tag === "pre") return `\`\`\`\n${(node.textContent || "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
    if (tag === "blockquote") {
      const value = cleanBlock(children());
      return `${value.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "a") {
      const label = cleanBlock(children()) || node.href;
      return /^https?:/i.test(node.href) ? `[${label}](${node.href})` : label;
    }
    if (tag === "ul" || tag === "ol") {
      return `${Array.from(node.children)
        .filter(child => child.tagName.toLowerCase() === "li")
        .map((child, index) => {
          const prefix = tag === "ol" ? `${index + 1}. ` : "- ";
          const value = cleanBlock(convert(child, listDepth + 1));
          const indent = "  ".repeat(listDepth);
          return `${indent}${prefix}${value.replace(/\n/g, `\n${indent}  `)}`;
        })
        .join("\n")}\n\n`;
    }
    if (tag === "li") return children();

    return children();
  }

  return cleanBlock(convert(fragment));
})();
