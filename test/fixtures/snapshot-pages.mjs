// snapshot golden·동등성 시험용 가짜 페이지 · 접근성 트리 노드와 Runtime.evaluate 응답을 흉내냄
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const node = (id, role, name, extra = {}) => ({ nodeId: String(id), role: { value: role }, name: { value: name }, ...extra });

function ordinaryTree() {
  return [
    node(1, "RootWebArea", "예시", { childIds: ["2", "3", "4", "5", "6", "7", "8"] }),
    node(2, "banner", "", { childIds: ["9"] }),
    node(9, "link", "홈", { backendDOMNodeId: 101 }),
    node(3, "heading", "주문서", { childIds: [] }),
    node(4, "textbox", "이메일", { backendDOMNodeId: 102 }),
    node(5, "button", "저장", { backendDOMNodeId: 103 }),
    node(6, "button", "저장", { backendDOMNodeId: 104 }),
    node(7, "StaticText", "  안내 문구  "),
    node(8, "generic", "", { childIds: ["10"] }),
    node(10, "checkbox", "동의", { backendDOMNodeId: 105, properties: [{ name: "focusable", value: { value: false } }] }),
  ];
}

function longTree() {
  const ids = Array.from({ length: 80 }, (_, i) => 100 + i);
  const nodes = [node(1, "RootWebArea", "목록", { childIds: ids.map(String) })];
  ids.forEach((id, i) => {
    if (i % 20 === 5) nodes.push(node(id, "alert", `경고 ${i}`));
    else if (i % 10 === 0) nodes.push(node(id, "heading", `구역 ${i}`));
    else nodes.push(node(id, "button", `항목 ${i}`, { backendDOMNodeId: 1000 + i }));
  });
  return nodes;
}

export const pages = {
  ordinary: { url: "https://example.test/order", title: "주문서", tree: ordinaryTree(), args: {}, frames: {},
    cursor: [{ text: "더보기", tag: "div" }, { text: "이미 있는 것", tag: "span" }], login: false, human: [] },
  iframe: { url: "https://example.test/frame", title: "프레임 페이지", tree: ordinaryTree(), args: {},
    frames: { "frame-1": [node(1, "RootWebArea", "결제", { childIds: ["2", "3"] }), node(2, "button", "결제하기", { backendDOMNodeId: 201 }), node(3, "textbox", "카드", { backendDOMNodeId: 202 })] },
    cursor: [], login: false, human: ["결제 창"] },
  longList: { url: "https://example.test/list", title: "긴 목록", tree: longTree(), args: { budget: 700 }, frames: {}, cursor: [], login: false, human: [] },
  longListNext: { url: "https://example.test/list", title: "긴 목록", tree: longTree(), args: { budget: 700, cursor: 20 }, frames: {}, cursor: [], login: false, human: [] },
  query: { url: "https://example.test/order", title: "주문서", tree: ordinaryTree(), args: { role: "button", name: "저장" }, frames: {}, cursor: [], login: false, human: [] },
  login: { url: "https://example.test/login", title: "로그인", tree: ordinaryTree(), args: {}, frames: {}, cursor: [], login: true, human: ["인증번호 입력", "캡차"] },
};

// 페이지가 CDP 요청에 답하는 방식 · 옛 send 와 worker 의 cdp.send 가 같은 대역을 씀
export function createPageSend(page) {
  let described = 0;
  return async (method, params = {}, sessionId = null) => {
    const expression = String(params.expression || "");
    switch (method) {
      case "Accessibility.enable": return {};
      case "Accessibility.getFullAXTree": return { nodes: sessionId ? page.frames[sessionId] : page.tree };
      case "Runtime.evaluate":
        if (expression.includes("found.push")) return { result: { value: JSON.stringify(page.cursor) } };
        if (expression.startsWith("window.__acCursorInteractive[")) {
          described = Number(expression.match(/\[(\d+)\]/)[1]);
          return { result: { objectId: `obj-${described}` } };
        }
        if (expression.startsWith("delete window.__acCursorInteractive")) return { result: {} };
        if (expression.includes("input[type=password]")) return { result: { value: page.login ? new URL(page.url).origin : "" } };
        if (expression.includes("카드 정보 입력")) return { result: { value: page.human } };
        throw new Error(`예상하지 않은 expression: ${expression.slice(0, 40)}`);
      default:
        if (method === "DOM.describeNode") return { node: { backendNodeId: page.cursor[described]?.text === "이미 있는 것" ? 101 : 5000 + described } };
        throw new Error(`예상하지 않은 method: ${method}`);
    }
  };
}

// 옛 처리기 입력: send.frames() · send.on(sid) 를 가진 send
export function legacySend(page) {
  const raw = createPageSend(page);
  const send = (method, params) => raw(method, params, null);
  send.frames = () => [null, ...Object.keys(page.frames)];
  send.on = (sid) => (method, params) => raw(method, params, sid);
  return send;
}

export async function runLegacySnapshot(page, id, refRegistry) {
  const { createInspectCommands } = require("../../native/electron/cdp-cmd-inspect.cjs");
  const { buildSnapshot } = require("../../native/electron/snapshot-engine.cjs");
  const { loginHint, humanHint } = require("../../native/electron/cdp-hints.cjs");
  const commands = createInspectCommands({ buildSnapshot, refRegistry, loginHint, humanHint });
  const wc = { id, getURL: () => page.url, getTitle: () => page.title };
  return JSON.parse(JSON.stringify(await commands.snapshot(legacySend(page), wc, page.args)));
}

export function dumpRefs(refRegistry, id, refs) {
  return refs.map((ref) => [ref, refRegistry.resolveRef(id, ref)]);
}
