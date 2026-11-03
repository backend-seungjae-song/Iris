// 웹 반응 관찰의 role·name 기대가 qa_snapshot 의 접근성 이름과 같은 요소를 찾는지(qa-92771d8c seq 10435)
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { reactionWatch } = require("../native/electron/cdp-qa-reaction.cjs");

function element(localName, attrs = {}, childNodes = []) {
  const el = { nodeType: 1, localName, id: attrs.id || "", childNodes, children: childNodes.filter(c => c.nodeType === 1), parentElement: null, isConnected: true,
    getAttribute: key => attrs[key] ?? null, hasAttribute: key => key in attrs, closest: () => null, contains: other => other === el,
    scrollWidth: 10, clientWidth: 10, getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) };
  const textOf = n => n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join("");
  el.textContent = el.innerText = textOf(el);
  return el;
}
const textNode = data => ({ nodeType: 3, data });

function snapshot(nodes, effects) {
  const byId = Object.fromEntries(nodes.filter(n => n.id).map(n => [n.id, n]));
  const body = { children: nodes, innerText: "화면", textContent: "화면", isConnected: true, parentElement: null, getAttribute: () => null };
  for (const n of nodes) n.parentElement = body;
  const document = { body, documentElement: { scrollWidth: 800 }, activeElement: null,
    querySelectorAll: sel => sel === "body *" ? nodes : nodes.filter(n => sel === "#" + n.id), getElementById: id => byId[id] || null, elementFromPoint: () => nodes[0],
    addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ document, location: { href: "http://site/" }, innerWidth: 800, innerHeight: 600, Date,
    MutationObserver: class { observe() {} disconnect() {} }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", overflowX: "visible", textOverflow: "clip" }),
    PerformanceObserver: class { observe() {} disconnect() {} }, binding: () => {} });
  return vm.runInContext(`(${reactionWatch.toString()})(${JSON.stringify({ id: "w", effects, binding: "binding", deadline: 1e15 })})`, context);
}

test("label 로 이름을 얻는 스위치는 접근성 이름(aria-labelledby, label 안 컨트롤 이름 포함)으로 찾는다", () => {
  const sw = element("span", { role: "switch", "aria-label": "배너 켜기", "aria-labelledby": "lbl" });
  const hidden = element("input", { type: "checkbox", "aria-hidden": "true" });
  const label = element("label", { id: "lbl" }, [sw, hidden, textNode("\n  켜기 (꺼 두면 기간 안이어도 보이지 않습니다)\n")]);
  const effects = [{ id: "e1", type: "appear", role: "switch", name: "배너 켜기 켜기 (꺼 두면 기간 안이어도 보이지 않습니다)" }];
  assert.equal(snapshot([label, sw, hidden], effects).effects[0].found, true);
});

test("이미지는 role img 와 alt 이름으로 찾는다", () => {
  const img = element("img", { alt: "배너 미리보기" });
  assert.equal(snapshot([img], [{ id: "e1", type: "appear", role: "img", name: "배너 미리보기" }]).effects[0].found, true);
});

test("선택 상자의 글자는 선택된 항목 글자로 읽어 값만 바뀌는 선택도 change 기대로 본다", () => {
  const select = element("select", { id: "brand", "aria-label": "추가할 브랜드" }, [textNode("추가할 브랜드교촌치킨BBQ")]);
  select.selectedOptions = [{ label: "교촌치킨" }];
  assert.equal(snapshot([select], [{ id: "e1", type: "change", sel: "#brand", to: "교촌치킨" }]).effects[0].text, "교촌치킨");
});

test("체크박스·검색칸·제목은 qa_snapshot 과 같은 role 과 이름으로 찾는다", () => {
  const box = element("input", { type: "checkbox", "aria-label": "품절 상품 숨기기" }); box.type = "checkbox";
  const search = element("input", { type: "search", placeholder: "브랜드 검색" }); search.type = "search"; search.value = "";
  const heading = element("h2", {}, [textNode("인기 브랜드")]);
  const found = effects => JSON.parse(JSON.stringify(snapshot([box, search, heading], effects).effects.map(e => e.found)));
  assert.deepEqual(found([
    { id: "e1", type: "appear", role: "checkbox", name: "품절 상품 숨기기" },
    { id: "e2", type: "appear", role: "searchbox", name: "브랜드 검색" },
    { id: "e3", type: "appear", role: "heading", name: "인기 브랜드" },
  ]), [true, true, true]);
});
