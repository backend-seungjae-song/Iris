import { isHostWindows } from "./host-path.js";
import { shortcutLabel } from "./keymap.js";

// 정적 HTML의 안내도 preload가 알려 준 호스트에 맞춘다.
export function applyHostUi(doc = document) {
  if (!isHostWindows()) return;
  doc.documentElement.classList.add("host-windows");
  for (const el of doc.querySelectorAll("[title], [placeholder], [aria-label]")) {
    for (const attr of ["title", "placeholder", "aria-label"]) {
      if (el.hasAttribute(attr)) el.setAttribute(attr, shortcutLabel(el.getAttribute(attr).replace("Ctrl/⌘", "⌘")));
    }
  }
  const walker = doc.createTreeWalker(doc.body, 4);
  let text;
  while ((text = walker.nextNode())) {
    if (["SCRIPT", "STYLE"].includes(text.parentElement?.tagName)) continue;
    text.nodeValue = shortcutLabel(text.nodeValue.replace(/Finder/g, "탐색기").replace("Ctrl/⌘", "⌘"));
  }
}
