import { useRoute, useData } from "vitepress";
import { onMounted, watch } from "vue";
import { Module } from "./module";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ObjectInspector } from "react-inspector";
import { Observable } from "./observable";

const SCRIPT_PREFIX = "cell";

function injectGlobal(global) {
  Object.assign(window, {
    ...global,
    display: (callback) => callback(),
    dispose: (node, callback) => {
      Object.assign(node, { __dispose__: callback });
      return node;
    },
  });
}

const parsers = {
  js: (d) => d,
  javascript: (d) => d,
};

function isMountableNode(node) {
  return node instanceof HTMLElement || node instanceof SVGElement;
}

function renderObjectInspector(data, { isDark }) {
  const node = document.createElement("div");
  node.classList.add("genji-object-inspector");

  const root = createRoot(node);
  const render = (isDark) => {
    root.render(
      createElement(ObjectInspector, {
        data,
        showNonenumerable: true,
        theme: isDark ? "chromeDark" : "chromeLight",
      })
    );
  };

  render(isDark);

  // Rerender when theme changes.
  window.addEventListener("theme-change", (event) => {
    const { isDark } = event.detail;
    render(isDark);
  });

  node.__dispose__ = () => root.unmount();

  return node;
}

function normalize(node, options) {
  if (isMountableNode(node)) return node;
  return renderObjectInspector(node, options);
}

function mount(block, node) {
  const cell = document.createElement("div");
  cell.classList.add("genji-cell");
  cell.appendChild(normalize(node));
  block.parentNode.insertBefore(cell, block);
}

function unmount(node) {
  if (!node) return;
  if (node.__dispose__) node.__dispose__();
  node.remove();
}

// Determined by new Function body.
function actualNumber(lineNumber) {
  return lineNumber - 2;
}

function extractLeadingWhitespace(str) {
  const match = str.match(/^\s*/);
  return match ? match[0] : "";
}

function renderError(e, { pre }) {
  const node = document.createElement("div");
  node.classList.add("genji-error");

  const regex = /\((.*?):(\d+):(\d+)\)/;
  const stacks = e.stack.split("\n");

  // Render error message.
  const [error, ...traces] = stacks;
  node.textContent = error;

  // Render error lines.
  const metaByLine = new Map(
    traces.map((d) => {
      const match = d.match(regex);
      if (!match) return [d, null];
      const [, name, line] = match;
      return [d, [name, +line]];
    })
  );

  // Only display error lines from the cell.
  const errorTraces = traces.filter((d) => {
    const match = metaByLine.get(d);
    if (!match) return false;
    const [name] = match;
    return name.startsWith(SCRIPT_PREFIX);
  });

  const removes = [];
  for (const at of errorTraces) {
    const [, lineNumber] = metaByLine.get(at);
    const actual = actualNumber(lineNumber);

    // Get the line and highlight it.
    const lines = pre.getElementsByClassName("line");
    const errorLine = lines[actual - 1];
    const spans = errorLine.getElementsByTagName("span");

    // Extract leading whitespace and insert it into the first span.
    const [first] = spans;
    const leadingWhitespace = extractLeadingWhitespace(first.textContent);
    const leadingSpan = first.cloneNode(true);
    leadingSpan.textContent = leadingWhitespace;
    first.textContent = first.textContent.trimStart();
    errorLine.insertBefore(leadingSpan, first);

    // Add error class to the line.
    for (const span of spans) span.classList.add("genji-error-line");
    leadingSpan.classList.remove("genji-error-line");

    removes.push(() => {
      for (const span of spans) span.classList.remove("genji-error-line");
    });
  }

  node.__dispose__ = () => {
    for (const remove of removes) remove();
  };
  return node;
}

function render(module, { isDark }) {
  module.dispose();

  const codes = document.querySelectorAll("[data-genji]");
  const blocks = Array.from(codes).filter((code) => {
    if (!code.dataset.genji) return false;
    return true;
  });

  if (!blocks.length) return;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const { dataset } = block;
    const { lang } = dataset;
    const parser = parsers[lang];
    if (parser) {
      const pre = block.getElementsByClassName("shiki")[0];
      const code = pre.textContent;

      const observable = new Observable((observer) => {
        let normalized;
        try {
          const parsed = parser(code);
          const node = new Function(
            `return ${parsed} //# sourceURL=${SCRIPT_PREFIX}-${i}.js`
          )();
          normalized = normalize(node, { isDark });
          observer.next(normalized);
        } catch (e) {
          console.error(e);
          normalized = renderError(e, { isDark, pre });
          observer.error(normalized);
        } finally {
          return () => unmount(normalized);
        }
      });

      const observer = {
        next: (node) => mount(block, node),
        error: (node) => mount(block, node),
      };

      module.add(observable, observer);
    }
  }
}

export function useRender({ global }) {
  const route = useRoute();
  const { isDark } = useData();
  const module = new Module();
  const renderModule = () => {
    render(module, { isDark: isDark.value });
  };

  // Avoid mount multiple times because of hot reload in development.
  if (import.meta.env.DEV) {
    if (window.__module__) window.__module__.dispose();
    window.__module__ = module;
  }

  watch(
    () => route.path,
    () => setTimeout(() => renderModule())
  );

  watch(
    () => isDark.value,
    () => {
      window.dispatchEvent(
        new CustomEvent("theme-change", { detail: { isDark: isDark.value } })
      );
    }
  );

  onMounted(() => {
    injectGlobal(global);
    renderModule();
  });
}