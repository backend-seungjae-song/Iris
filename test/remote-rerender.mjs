import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// REMOTE_SRC: 고치기 전 판의 remote/boot.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ REMOTE_SRC: "/js/remote/boot.js" });

test("원격 화면은 같은 상태가 다시 와도 고르던 답·직접 입력·PIN 입력 포커스를 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const remote = await import("/js/remote/boot.js");
    document.body.insertAdjacentHTML("beforeend", remote.panelHtml);
    const { ws } = remote.initCapability({ wsSend() {} });
    const agent = "a".repeat(32), ref = "b".repeat(32);
    const question = { ref, agent, kind: "question", body: { questions: [{ question: "어느 쪽?", options: [{ label: "왼쪽" }, { label: "오른쪽" }] }] } };
    const state = (extra) => ({ type: "remote.state", status: "on", busy: false, pinConfigured: true, questionHookInstalled: true,
      agents: [{ ref: agent, name: "codex", kind: "codex" }], requests: [question], ...extra });
    ws["remote.state"](state());
    const card = document.querySelector("#remote-request-list .remote-request");
    const radio = card.querySelector('input[value="오른쪽"]'); radio.checked = true;
    const text = [...card.querySelectorAll("input")].find((x) => x.type !== "radio" && x.type !== "checkbox");
    if (text) text.value = "직접 쓴 답";
    ws["remote.state"](state());
    const again = document.querySelector("#remote-request-list .remote-request");
    // 설정 전(PIN 없음) 안내에서 PIN 칸에 입력하는 중 상태가 다시 옴
    ws["remote.state"](state({ status: "off", pinConfigured: false, requests: [] }));
    const pin = document.getElementById("remote-pin");
    pin.focus(); pin.value = "12";
    ws["remote.state"](state({ status: "off", pinConfigured: false, requests: [] }));
    return {
      sameCard: again === card,
      checked: again.querySelector('input[value="오른쪽"]').checked,
      typed: text ? [...again.querySelectorAll("input")].find((x) => x.type !== "radio" && x.type !== "checkbox").value : "직접 쓴 답",
      pinFocused: document.activeElement === document.getElementById("remote-pin"),
      pinValue: document.getElementById("remote-pin").value,
    };
  }), { overrides });
  assert.equal(r.sameCard, true, "같은 요청은 같은 카드");
  assert.equal(r.checked, true, "고르던 답 유지");
  assert.equal(r.typed, "직접 쓴 답", "직접 입력 유지");
  assert.equal(r.pinFocused, true, "PIN 입력 포커스 유지");
  assert.equal(r.pinValue, "12", "PIN 입력값 유지");
});
