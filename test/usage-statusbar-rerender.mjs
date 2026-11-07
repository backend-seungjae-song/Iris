import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// USAGE_SRC: 고치기 전 판의 statusbar/usage.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ USAGE_SRC: "/js/statusbar/usage.js" });

test("사용량 상태가 다시 와도 열린 화면의 초점·새로고침 아이콘 애니메이션을 유지하고 자동 확인에는 띠를 흐리지 않음", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const usage = await import("/js/statusbar/usage.js");
    document.body.insertAdjacentHTML("beforeend", `<div id="statusbar"></div>`);
    const sent = [];
    const cap = usage.initCapability({ $: (s) => document.querySelector(s), wsSend: (m) => sent.push(m.type) });
    const now = Date.now() + 30 * 60e3; // 남은 시간 표기가 경계에 걸리지 않게 고정
    const state = (fetching) => ({ type: "usage.state", updatedAt: Date.now(), fetching,
      providers: [{ provider: "codex", planType: "plus", session: { usedPercent: 40, windowMinutes: 300, resetsAt: now + 3600e3 },
        weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: now + 86400e3 } }] });
    cap.ws["usage.state"](state(false));
    document.querySelector(".usg-trigger").click();
    const panel = document.querySelector(".usg-panel");
    const modeBtn = panel.querySelector(".usg-switch-btn");
    modeBtn.focus();
    // 자동 확인: 서버가 fetching 을 켰다 끔
    cap.ws["usage.state"](state(true));
    const autoDim = !!document.querySelector(".usg-seg.loading");
    const spinner = panel.querySelector(".usg-refresh");
    const spinning = spinner.classList.contains("spin");
    const anim = spinner.querySelector("svg").getAnimations().length > 0;
    cap.ws["usage.state"](state(true));
    const out = {
      segs: document.querySelectorAll(".usg-seg").length, autoDim, spinning, anim,
      sameIcon: panel.querySelector(".usg-refresh") === spinner,
      sameButton: panel.querySelector(".usg-switch-btn") === modeBtn,
      focused: document.activeElement === panel.querySelector(".usg-switch-btn"),
    };
    cap.ws["usage.state"](state(false));
    out.spinStops = !panel.querySelector(".usg-refresh").classList.contains("spin");
    // 사람이 누른 확인에는 흐리게
    spinner.click();
    cap.ws["usage.state"](state(true));
    out.manualDim = !!document.querySelector(".usg-seg.loading");
    out.asked = sent.includes("usage.refresh");
    return out;
  }), { body: `<link rel="stylesheet" href="/css/00-tokens.css"><link rel="stylesheet" href="/css/28-usage.css">`, overrides });
  assert.ok(r.segs > 0, "상태바 값 그림");
  assert.equal(r.autoDim, false, "자동 확인에는 띠를 흐리지 않음");
  assert.equal(r.spinning, true, "확인 중 아이콘은 돎");
  assert.equal(r.sameIcon, true, "같은 내용이면 새로고침 아이콘을 다시 만들지 않음(애니메이션 유지)");
  assert.equal(r.sameButton, true, "같은 내용이면 전환 단추를 다시 만들지 않음");
  assert.equal(r.focused, true, "초점 유지");
  assert.equal(r.spinStops, true, "확인이 끝나면 아이콘이 멈춤");
  assert.equal(r.manualDim, true, "사람이 요청한 확인에는 띠를 흐리게 함");
  assert.equal(r.asked, true);
});
