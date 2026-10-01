import assert from "node:assert/strict";
import test from "node:test";

import { initCapability, panelHtml } from "../web/js/remote/boot.js";

function element() {
  const classes = new Set();
  return {
    dataset: {},
    textContent: "",
    disabled: false,
    hidden: false,
    addEventListener() {},
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
  };
}

test("Mac 화면은 켜짐·준비·오류 상태와 비활성 버튼을 표시한다", () => {
  const previousDocument = globalThis.document;
  const elements = new Map([
    ["remote-body", element()],
    ["remote-status", element()],
    ["remote-detail", element()],
    ["remote-action", element()],
    ["remote-dot", element()],
  ]);
  globalThis.document = { getElementById: (id) => elements.get(id) || null };
  try {
    const capability = initCapability({ wsSend() {} });
    capability.ws["remote.state"]({
      type: "remote.state", status: "on", pinConfigured: true,
      listener: { address: "100.64.1.2", port: 4292 },
    });
    assert.equal(elements.get("remote-detail").textContent, "외부 수신: 100.64.1.2:4292");
    capability.ws["remote.state"]({ type: "remote.state", status: "off", busy: true, pinConfigured: true });
    assert.equal(elements.get("remote-detail").textContent, "외부 수신을 준비하고 있습니다.");
    assert.equal(elements.get("remote-action").disabled, true);
    capability.ws["remote.state"]({
      type: "remote.state", status: "error", pinConfigured: true,
      error: { code: "tailscale-address-unavailable", message: "Tailscale IPv4 주소가 없습니다.", action: "enable" },
    });
    assert.equal(elements.get("remote-detail").textContent, "Tailscale IPv4 주소가 없습니다.");
    assert.equal(elements.get("remote-action").textContent, "다시 켜기");
    capability.ws["remote.state"]({
      type: "remote.state", status: "error", pinConfigured: true,
      error: { code: "registry-save-failed", message: "원격 설정을 저장하지 못했습니다.", action: "stop" },
    });
    assert.equal(elements.get("remote-action").textContent, "다시 중지");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Mac 화면은 QR 여백·6자리 입력·두 번 누르는 기기 삭제를 제공한다", () => {
  assert.match(panelHtml, /inputmode="numeric" maxlength="6"/);
  assert.match(panelHtml, /id="remote-pin" type="password" inputmode="numeric" minlength="6" maxlength="32"/);
  const previousDocument = globalThis.document;
  function richElement() {
    const handlers = new Map();
    return {
      ...element(),
      children: [],
      value: "",
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, handler) { handlers.set(type, handler); },
      click() { handlers.get("click")?.({ currentTarget: this }); },
    };
  }
  const ids = [
    "remote-body", "remote-status", "remote-detail", "remote-action", "remote-dot", "remote-feedback",
    "remote-pair-card", "remote-pair-scan", "remote-pair-code", "remote-pair-start", "remote-pair-device",
    "remote-code", "remote-code-confirm", "remote-countdown", "remote-devices", "remote-device-list",
    "remote-pair-cancel",
  ];
  const elements = new Map(ids.map((id) => [id, richElement()]));
  const draws = [];
  elements.set("remote-qr", {
    ...richElement(),
    getContext: () => ({
      fillStyle: "",
      fillRect(...args) { draws.push(args); },
    }),
  });
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: () => richElement(),
  };
  const sent = [];
  try {
    const capability = initCapability({ wsSend: (message) => sent.push(message) });
    capability.ws["remote.state"]({
      type: "remote.state", status: "on", busy: false, pinConfigured: true,
      listener: { address: "100.64.1.2", port: 4292 },
      pairing: { phase: "scan", qr: { size: 1, rows: ["1"] }, expiresAt: Date.now() + 120_000 },
      devices: [{ deviceId: "a".repeat(32), name: "Galaxy", addedAt: 1_000 }],
    });
    assert.deepEqual(draws.at(-1), [16, 16, 4, 4]);
    assert.equal(elements.get("remote-qr").width, 36);
    let remove = elements.get("remote-device-list").children[0].children[1];
    remove.click();
    assert.deepEqual(sent, []);
    remove = elements.get("remote-device-list").children[0].children[1];
    assert.equal(remove.textContent, "한 번 더 누르면 삭제");
    remove.click();
    assert.deepEqual(sent, [{ type: "remote.device.remove", deviceId: "a".repeat(32) }]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Mac 화면은 서버 문자열을 textContent로 표시하고 같은 저장소에 답을 보낸다", () => {
  const previousDocument = globalThis.document;
  function interactiveElement(tag = "div") {
    const handlers = new Map();
    return {
      ...element(), tag, children: [], value: "", checked: false,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, handler) { handlers.set(type, handler); },
      click() { handlers.get("click")?.({ currentTarget: this }); },
    };
  }
  const ids = [
    "remote-body", "remote-status", "remote-detail", "remote-action", "remote-feedback",
    "remote-requests", "remote-request-list", "remote-hook-status", "remote-hook-action",
  ];
  const elements = new Map(ids.map((id) => [id, interactiveElement()]));
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => interactiveElement(tag),
  };
  const sent = [];
  try {
    const capability = initCapability({ wsSend: (message) => sent.push(message) });
    capability.ws["remote.state"]({
      type: "remote.state", status: "on", busy: false, pinConfigured: true, questionHookInstalled: false,
      agents: [{ ref: "a".repeat(32), name: "<img src=x>", kind: "claude" }],
      requests: [{ ref: "b".repeat(32), agent: "a".repeat(32), kind: "claude-permission",
        body: { tool: "Bash", description: "<script>bad()</script>", input: "pwd" } }],
    });
    const card = elements.get("remote-request-list").children[0];
    assert.equal(card.children[0].textContent, "<img src=x> · 허용 요청");
    assert.match(card.children[1].textContent, /<script>bad\(\)<\/script>/);
    card.children[2].children[0].click();
    assert.deepEqual(sent.at(-1), { type: "remote.request.answer", request: "b".repeat(32),
      answer: { behavior: "allow" } });
    elements.get("remote-hook-action").click();
    assert.deepEqual(sent.at(-1), { type: "remote.question-hook.install" });
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Mac 화면은 일치하는 숫자 PIN만 보내고 입력값을 곧바로 지운다", () => {
  const previousDocument = globalThis.document;
  function inputElement() {
    const handlers = new Map();
    return {
      ...element(),
      value: "",
      addEventListener(type, handler) { handlers.set(type, handler); },
      submit() { handlers.get("submit")?.({ preventDefault() {} }); },
      input() { handlers.get("input")?.({ currentTarget: this }); },
    };
  }
  const elements = new Map([
    ["remote-pin-form", inputElement()],
    ["remote-pin", inputElement()],
    ["remote-pin-confirm", inputElement()],
    ["remote-pin-save", inputElement()],
    ["remote-feedback", inputElement()],
  ]);
  globalThis.document = { getElementById: (id) => elements.get(id) || null };
  const sent = [];
  try {
    initCapability({ wsSend: (message) => sent.push(message) });
    elements.get("remote-pin").value = "12ab3456";
    elements.get("remote-pin").input();
    assert.equal(elements.get("remote-pin").value, "123456");
    elements.get("remote-pin-confirm").value = "123456";
    elements.get("remote-pin-form").submit();
    assert.deepEqual(sent, [{ type: "remote.pin.set", pin: "123456", confirmation: "123456" }]);
    assert.equal(elements.get("remote-pin").value, "");
    assert.equal(elements.get("remote-pin-confirm").value, "");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Mac 화면은 PIN 기한 10·20·30·60분을 표시하고 변경 요청을 보낸다", () => {
  assert.match(panelHtml, /PIN 다시 확인/);
  for (const minutes of [10, 20, 30, 60]) {
    assert.match(panelHtml, new RegExp(`value="${minutes}"`));
  }
  const previousDocument = globalThis.document;
  const handlers = new Map();
  const select = {
    ...element(), value: "30",
    addEventListener(type, handler) { handlers.set(type, handler); },
    change() { handlers.get("change")?.({ currentTarget: this }); },
  };
  const elements = new Map([
    ["remote-body", element()], ["remote-status", element()], ["remote-detail", element()],
    ["remote-action", element()], ["remote-pin-idle", select],
  ]);
  globalThis.document = { getElementById: (id) => elements.get(id) || null };
  const sent = [];
  try {
    const capability = initCapability({ wsSend: (message) => sent.push(message) });
    capability.ws["remote.state"]({
      type: "remote.state", status: "on", pinConfigured: true, pinIdleMinutes: 20,
    });
    assert.equal(select.value, "20");
    select.value = "60";
    select.change();
    assert.deepEqual(sent.at(-1), { type: "remote.pin-idle.set", minutes: 60 });
  } finally {
    globalThis.document = previousDocument;
  }
});

test("PIN이 없으면 현재 안내 단계 안에서 저장하고 다음 단계로 넘어간다", () => {
  assert.equal((panelHtml.match(/id="remote-pin-form"/g) || []).length, 1);
  const previousDocument = globalThis.document;
  function node() {
    const handlers = new Map();
    return {
      ...element(), children: [], value: "",
      append(...values) { this.children.push(...values); },
      replaceChildren(...values) { this.children = values; },
      setAttribute() {},
      addEventListener(type, handler) { handlers.set(type, handler); },
      submit() { handlers.get("submit")?.({ preventDefault() {} }); },
    };
  }
  const ids = [
    "remote-body", "remote-status", "remote-detail", "remote-action", "remote-feedback",
    "remote-guide", "remote-steps", "remote-status-card", "remote-pin-card", "remote-pin-status",
    "remote-pin-form", "remote-pin", "remote-pin-confirm", "remote-pin-save",
  ];
  const elements = new Map(ids.map((id) => [id, node()]));
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: () => node(),
  };
  const sent = [];
  try {
    const capability = initCapability({ wsSend: (message) => sent.push(message) });
    capability.ws["remote.state"]({
      type: "remote.state", status: "off", busy: false, pinConfigured: false, devices: [],
    });
    let steps = elements.get("remote-steps").children;
    assert.equal(steps[0].dataset.state, "current");
    assert.ok(steps[0].children.includes(elements.get("remote-pin-form")));
    assert.equal(elements.get("remote-pin-card").hidden, true);

    elements.get("remote-pin").value = "123456";
    elements.get("remote-pin-confirm").value = "123456";
    elements.get("remote-pin-form").submit();
    assert.deepEqual(sent.at(-1), { type: "remote.pin.set", pin: "123456", confirmation: "123456" });

    capability.ws["remote.state"]({
      type: "remote.state", status: "off", busy: false, pinConfigured: true, devices: [],
    });
    steps = elements.get("remote-steps").children;
    assert.equal(steps[0].dataset.state, "done");
    assert.equal(steps[1].dataset.state, "current");
    assert.equal(elements.get("remote-pin-card").hidden, false);
    assert.ok(elements.get("remote-pin-card").children.includes(elements.get("remote-pin-form")));
  } finally {
    globalThis.document = previousDocument;
  }
});

test("PIN 때문에 멈춘 이전 사용자는 알림에서 원격 화면을 연다", () => {
  const previousDocument = globalThis.document;
  const elements = new Map([
    ["remote-body", element()], ["remote-status", element()], ["remote-detail", element()],
    ["remote-action", element()], ["remote-feedback", element()],
  ]);
  let opened = 0;
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => selector.includes('data-rail="remote"') ? { click() { opened++; } } : null,
  };
  let notice;
  let nativeNotice;
  let activated;
  try {
    const capability = initCapability({
      wsSend() {},
      showNotice(value) { notice = value; },
      acHost: {
        notify(value) { nativeNotice = value; },
        onNoticeActivated(callback) { activated = callback; },
      },
    });
    capability.ws["remote.state"]({
      type: "remote.state", status: "off", busy: false, pinConfigured: false,
      pausedForPin: true, devices: [],
    });
    assert.equal(notice.title, "휴대폰 원격 제어가 멈췄습니다");
    assert.equal(notice.body, "접속 PIN을 정하면 다시 켜집니다.");
    notice.action.run();
    activated({ id: nativeNotice.id });
    assert.equal(opened, 2);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("원격 화면을 열지 않아도 연결 뒤 PIN 중단 상태를 요청한다", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
  };
  const sent = [];
  try {
    initCapability({
      wsIsOpen: () => true,
      wsSend(message) { sent.push(message); },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(sent, [{ type: "remote.status" }]);
  } finally {
    globalThis.document = previousDocument;
  }
});
