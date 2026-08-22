(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme =
    param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  const skin = localStorage.getItem("library-skin") || "tech";
  document.documentElement.setAttribute("data-skin", skin);
  const language = localStorage.getItem("ui-language") || "zh";
  document.documentElement.setAttribute("lang", language === "en" ? "en" : "zh-CN");
})();
