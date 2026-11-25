// 이벤트를 상위 요소에서 받는 목록용. 항목의 키는 같은 목록 안에서 고유해야 함
import morphdom from "../../vendor/morphdom.js";

const drawn = new WeakMap();

export function patchHtml(host, html, key) {
  const last = drawn.get(host);
  if (last?.html === html && host.innerHTML === last.dom) return;
  if (host.firstChild) {
    const next = host.cloneNode(false);
    next.innerHTML = html;
    morphdom(host, next, {
      childrenOnly: true,
      getNodeKey: key && ((node) => node.nodeType === 1 ? key(node) : undefined),
      onBeforeElUpdated: (node, target) => !node.hasAttribute("data-inline-edit") && !node.isEqualNode(target),
      onBeforeElChildrenUpdated: (_node, target) => !target.hasAttribute("data-owned-children"),
    });
  } else {
    host.innerHTML = html;
  }
  drawn.set(host, { html, dom: host.innerHTML });
}

export const tabKey = (node) => node.dataset.tab && 'tab:' + node.dataset.tab;
