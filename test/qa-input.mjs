import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createQaInputCommands } = require("../native/electron/cdp-qa-input.cjs");

function fixture({ disabled = false, received = [{ type: "click", trusted: true, role: "button", name: "저장", tag: "button" }],
  axNodes = [{ backendDOMNodeId: 7, role: { value: "button" }, name: { value: "저장" } }], covered = false } = {}) {
  const calls = [];
  const send = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 500, clientHeight: 300 } };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: covered ? 8 : 7 };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: params.backendNodeId,
      role: { value: "button" }, name: { value: covered ? "가림" : "저장" } }] };
    if (method === "DOM.describeNode") return { node: { localName: "button", attributes: [] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { top: !covered, disabled } } };
    if (method === "Runtime.evaluate") return { result: { value: params.expression.includes("inspectLoginPage") ? { fields: [], reasons: [] } : params.expression.includes("capture.events") ? received :
      params.expression.includes("document.activeElement") ? { role: "textbox", name: "검색", tag: "input", at: { x: 40, y: 30 }, disabled } : true } };
    if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
    if (method === "DOM.getBoxModel") return { model: { border: [10, 10, 110, 10, 110, 50, 10, 50] } };
    return {};
  };
  send.on = () => send;
  send.frames = () => [null];
  return { send, calls };
}

test("QA click sends only CDP mouse input and reports trusted receiver", async () => {
  const { send, calls } = fixture();
  const result = await createQaInputCommands()["qa-input"](send, {}, { action: "click", x: 20, y: 20, selected: { role: "button", name: "저장" } });
  assert.equal(result.via, "cdp-input");
  assert.equal(result.trusted, true);
  assert.equal(result.target.name, "저장");
  assert.deepEqual(result.received.map((event) => event.type), ["click"]);
  assert.deepEqual(calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(calls.some((call) => /scrollIntoView|dispatchEvent|\.click\(/.test(JSON.stringify(call))), false);
});

test("QA input rejects coordinates outside viewport and disabled target before input", async () => {
  const offscreen = fixture();
  await assert.rejects(createQaInputCommands()["qa-input"](offscreen.send, {}, { action: "click", x: 501, y: 20 }), /화면 밖/);
  assert.equal(offscreen.calls.some((call) => call.method.startsWith("Input.")), false);
  const inactive = fixture({ disabled: true });
  await assert.rejects(createQaInputCommands()["qa-input"](inactive.send, {}, { action: "click", x: 20, y: 20 }), /비활성/);
  assert.equal(inactive.calls.some((call) => call.method.startsWith("Input.")), false);
});

test("QA input refuses untrusted or absent delivery", async () => {
  const { send } = fixture({ received: [{ type: "click", trusted: false }] });
  await assert.rejects(createQaInputCommands()["qa-input"](send, {}, { action: "click", x: 20, y: 20 }), /수신을 확인하지/);
});

test("QA click reports the topmost target even when the selected target differs", async () => {
  const { send } = fixture({ covered: true, received: [{ type: "click", trusted: true, role: "button", name: "가림" }] });
  const result = await createQaInputCommands()["qa-input"](send, {}, {
    action: "click", x: 20, y: 20, selected: { role: "button", name: "저장" },
  });
  assert.equal(result.target.name, "가림");
  assert.equal(result.selected.name, "저장");
  assert.equal(result.received[0].name, "가림");
});

test("QA type and key use CDP text and key commands with a visible focused target", async () => {
  const typed = fixture({ received: [{ type: "input", trusted: true, role: "textbox", name: "검색" }] });
  const result = await createQaInputCommands()["qa-input"](typed.send, {}, {
    action: "type", text: "한글", expectedTarget: { role: "textbox", name: "검색" },
  });
  assert.deepEqual(result.at, { x: 40, y: 30 });
  assert.deepEqual(typed.calls.filter((call) => call.method.startsWith("Input.")).map((call) => call.method), ["Input.insertText"]);
  const keyed = fixture({ received: [{ type: "keydown", trusted: true, role: "textbox", name: "검색" }] });
  await createQaInputCommands()["qa-input"](keyed.send, {}, {
    action: "key", key: "Enter", expectedTarget: { role: "textbox", name: "검색" },
  });
  assert.deepEqual(keyed.calls.filter((call) => call.method.startsWith("Input.")).map((call) => [call.params.type, call.params.text]), [["keyDown", "\r"], ["keyUp", undefined]]);
});

test("QA locate requires one visible uncovered AX target", async () => {
  const good = fixture();
  const found = await createQaInputCommands()["qa-locate"](good.send, {}, { role: "button", name: "저장" });
  assert.deepEqual(found.at, { x: 60, y: 30 });
  const duplicate = fixture({ axNodes: [
    { backendDOMNodeId: 7, role: { value: "button" }, name: { value: "저장" } },
    { backendDOMNodeId: 9, role: { value: "button" }, name: { value: "저장" } },
  ] });
  await assert.rejects(createQaInputCommands()["qa-locate"](duplicate.send, {}, { role: "button", name: "저장" }), /여러 개/);
  const covered = fixture({ covered: true });
  await assert.rejects(createQaInputCommands()["qa-locate"](covered.send, {}, { role: "button", name: "저장" }), /다른 요소/);
});

test("재생 중 포인터 이동으로 대상이 바뀌면 누르지 않는다", async () => {
  const f = fixture();
  let moved = false;
  const send = async (method, args) => {
    if (method === "Input.dispatchMouseEvent" && args.type === "mouseMoved") moved = true;
    const result = await f.send(method, args);
    if (moved && method === "Accessibility.getPartialAXTree") result.nodes[0].name.value = "결제";
    return result;
  };
  send.on = () => send; send.frames = () => [null];
  await assert.rejects(createQaInputCommands()["qa-input"](send, {}, {
    action: "click", x: 20, y: 20, expectedTarget: { role: "button", name: "저장" },
  }), /바뀌었습니다/);
  assert.equal(f.calls.some(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed"), false);
});

test("재생 더블클릭은 두 번째 누르기 전에 대상 변경을 확인한다", async () => {
  const f = fixture(); let released = false;
  const send = async (method, args) => {
    if (method === "Input.dispatchMouseEvent" && args.type === "mouseReleased") released = true;
    const result = await f.send(method, args);
    if (released && method === "Accessibility.getPartialAXTree") result.nodes[0].name.value = "결제";
    return result;
  };
  send.on = () => send; send.frames = () => [null];
  await assert.rejects(createQaInputCommands()["qa-input"](send, {}, {
    action: "dblclick", x: 20, y: 20, expectedTarget: { role: "button", name: "저장" },
  }), /바뀌었습니다/);
  assert.equal(f.calls.filter(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed").length, 1);
});

test("재생 문자열·키 입력은 현재 포커스가 저장된 대상과 다르면 보내지 않는다", async () => {
  for (const action of ["type", "key"]) {
    const f = fixture();
    await assert.rejects(createQaInputCommands()["qa-input"](f.send, {}, {
      action, text: "일반 검색어", key: "Enter", expectedTarget: { role: "textbox", name: "다른 검색" },
    }), /포커스 대상이 다릅니다/);
    assert.equal(f.calls.some((call) => call.method.startsWith("Input.")), false);
  }
});

test("재생 문자열·키 입력은 수신 기록 준비 중 바뀐 포커스도 입력 직전에 확인한다", async () => {
  for (const action of ["type", "key"]) {
    const f = fixture();
    let focusReads = 0;
    const send = async (method, args) => {
      const result = await f.send(method, args);
      // 페이지 안 포커스 정보 읽기만 셈(접근성 노드 조회는 returnByValue:false)
      if (method === "Runtime.evaluate" && args.expression.includes("document.activeElement") && args.returnByValue !== false) {
        focusReads++;
        if (focusReads > 1) result.result.value.name = "다른 검색";
      }
      return result;
    };
    send.on = () => send; send.frames = () => [null];
    await assert.rejects(createQaInputCommands()["qa-input"](send, {}, {
      action, text: "일반 검색어", key: "Enter", expectedTarget: { role: "textbox", name: "검색" },
    }), /포커스 대상이 바뀌었습니다/);
    assert.equal(focusReads, 2);
    assert.equal(f.calls.some((call) => call.method.startsWith("Input.")), false);
  }
});

test('hover, scroll and drag reject a covering target before any pointer dispatch',async()=>{
 for(const action of ['hover','scroll','drag']){
  const f=fixture({covered:true});
  await assert.rejects(createQaInputCommands()['qa-input'](f.send,{}, {action,x:20,y:20,toX:50,toY:50,deltaY:100,expectedTarget:{role:'button',name:'저장'}}),/바뀌었습니다/);
  assert.equal(f.calls.some(c=>c.method.startsWith('Input.')),false,action);
 }
});
test('drag checks target again after pointer movement before pressing',async()=>{
 const f=fixture();let moved=false;
 const send=async(method,args)=>{if(method==='Input.dispatchMouseEvent'&&args.type==='mouseMoved')moved=true;const result=await f.send(method,args);if(moved&&method==='Accessibility.getPartialAXTree')result.nodes[0].name.value='가림';return result;};send.on=()=>send;send.frames=()=>[null];
 await assert.rejects(createQaInputCommands()['qa-input'](send,{}, {action:'drag',x:20,y:20,toX:50,toY:50,expectedTarget:{role:'button',name:'저장'}}),/바뀌었습니다/);
 assert.equal(f.calls.some(c=>c.method==='Input.dispatchMouseEvent'&&c.params.type==='mousePressed'),false);
});

test("재생 좌표의 맨 위 요소가 기대 대상 안쪽의 이름 없는 span 이면 같은 대상으로 보고 누른다", async () => {
  const f = fixture({ axNodes: [{ backendDOMNodeId: 7, role: { value: "combobox" }, name: { value: "분류" } }] });
  const send = async (method, args = {}) => {
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 9 };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 9, role: { value: "generic" }, name: { value: "" } }] };
    if (method === "DOM.describeNode") return { node: { localName: "span", attributes: [] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-" + args.backendNodeId } };
    if (method === "Runtime.callFunctionOn" && args.objectId === "node-7") return { result: { value: { inside: args.arguments?.[0]?.objectId === "node-9" } } };
    return f.send(method, args);
  };
  send.on = () => send; send.frames = () => [null];
  await createQaInputCommands()["qa-input"](send, {}, { action: "click", x: 20, y: 20, expectedTarget: { role: "combobox", name: "분류" } });
  assert.equal(f.calls.some(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed"), true);
});

test("맨 위 요소가 기대 대상 밖의 요소이면 재생 좌표를 누르지 않는다", async () => {
  const f = fixture({ axNodes: [{ backendDOMNodeId: 7, role: { value: "combobox" }, name: { value: "분류" } }] });
  const send = async (method, args = {}) => {
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 9 };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 9, role: { value: "generic" }, name: { value: "" } }] };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-" + args.backendNodeId } };
    if (method === "Runtime.callFunctionOn" && args.objectId === "node-7") return { result: { value: { inside: false } } };
    return f.send(method, args);
  };
  send.on = () => send; send.frames = () => [null];
  await assert.rejects(createQaInputCommands()["qa-input"](send, {}, { action: "click", x: 20, y: 20, expectedTarget: { role: "combobox", name: "분류" } }), /바뀌었습니다/);
  assert.equal(f.calls.some(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed"), false);
});

test("페이지 안 이름과 접근성 이름이 다른 포커스 입력칸은 접근성 노드로 같은 대상인지 확인한다", async () => {
  const f = fixture({ received: [{ type: "input", trusted: true, role: "textbox", name: "" }] });
  const send = async (method, params = {}) => {
    if (method === "Runtime.evaluate" && params.returnByValue === false) return { result: { objectId: "focused" } };
    if (method === "DOM.describeNode" && params.objectId === "focused") return { node: { backendNodeId: 5 } };
    if (method === "Accessibility.getPartialAXTree" && params.backendNodeId === 5) return { nodes: [{ backendDOMNodeId: 5, role: { value: "searchbox" }, name: { value: "브랜드 검색" } }] };
    if (method === "DOM.describeNode" && params.backendNodeId === 5) return { node: { localName: "input", attributes: ["type", "search", "placeholder", "브랜드 검색"] } };
    return f.send(method, params);
  };
  send.on = () => send; send.frames = () => [null];
  const result = await createQaInputCommands()["qa-input"](send, {}, { action: "type", text: "교촌", expectedTarget: { role: "searchbox", name: "브랜드 검색" } });
  assert.equal(result.trusted, true);
});

// 사용자 포커스 보호(guarded): QA 탭이 사용자가 쓰는 창에 있고 사용자 포커스가 그 창 다른 곳에 있을 때
test("사용자 포커스 보호 중 QA 누르기·키는 CDP 입력 없이 막힌다", async () => {
  for (const args of [{ action: "click", x: 20, y: 20 }, { action: "dblclick", x: 20, y: 20 },
    { action: "drag", x: 20, y: 20, toX: 50, toY: 50 }, { action: "key", key: "Enter" }]) {
    const f = fixture();
    await assert.rejects(createQaInputCommands({ prepareFocus: async () => "guarded" })["qa-input"](f.send, {}, args), /사용자 포커스 보호/);
    assert.equal(f.calls.some((call) => call.method.startsWith("Input.")), false, args.action);
  }
});

test("사용자 포커스 보호 중 QA 글자는 그 탭 위젯에만 진짜 키로 보내고 코드 포인트로 나눈다", async () => {
  const typed = fixture({ received: [{ type: "input", trusted: true, role: "textbox", name: "검색" }] });
  const sent = [];
  const wc = { sendInputEvent: (event) => sent.push(event) };
  const result = await createQaInputCommands({ prepareFocus: async () => "guarded" })["qa-input"](typed.send, wc, {
    action: "type", text: "한👨‍👩‍👧a", expectedTarget: { role: "textbox", name: "검색" },
  });
  assert.equal(result.via, "tab-key-input");
  assert.equal(typed.calls.some((call) => call.method.startsWith("Input.")), false);
  assert.deepEqual(sent.map((e) => e.type), Array(7).fill("char"));
  assert.equal(sent.map((e) => e.keyCode).join(""), "한👨‍👩‍👧a");
});

test("사용자 포커스 보호 중에도 QA 마우스 이동·휠은 판정 없이 보낸다", async () => {
  let asked = 0;
  const f = fixture({ received: [{ type: "mousemove", trusted: true, role: "button", name: "저장" }] });
  await createQaInputCommands({ prepareFocus: async () => { asked++; return "guarded"; } })["qa-input"](f.send, {}, { action: "hover", x: 20, y: 20 });
  assert.equal(asked, 0);
  assert.deepEqual(f.calls.filter((call) => call.method.startsWith("Input.")).map((call) => call.params.type), ["mouseMoved"]);
});

// 세션 탭 그룹의 QA 탭: 사용자 포커스를 입력 동안만 빌리고 입력 직후 반환
test("포커스를 빌린 QA 누르기는 CDP 진짜 입력을 보내고 바로 반환한다", async () => {
  for (const args of [{ action: "click", x: 20, y: 20 }]) {
    const f = fixture();
    const order = [];
    const send = async (method, params = {}) => { if (method.startsWith("Input.")) order.push(method); return f.send(method, params); };
    send.on = f.send.on; send.frames = f.send.frames;
    const result = await createQaInputCommands({ prepareFocus: async () => "borrowed",
      returnFocus: async () => { order.push("return"); return "restored"; } })["qa-input"](send, {}, args);
    assert.equal(result.via, "cdp-input", args.action);
    assert.equal(result.focusBorrowed, true);
    assert.equal(result.focusReturn, "restored");
    assert.equal(order.at(-1), "return", args.action);
    assert.ok(order.filter((step) => step !== "return").length > 0, args.action);
  }
});

test("판정이 trusted 면 QA 누르기는 기존 CDP 경로를 쓴다", async () => {
  const f = fixture();
  const result = await createQaInputCommands({ prepareFocus: async () => "trusted" })["qa-input"](f.send, {}, { action: "click", x: 20, y: 20 });
  assert.equal(result.via, "cdp-input");
  assert.deepEqual(f.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"]);
});
