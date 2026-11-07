import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// NOTICE_SRC·NOTICE_CSS: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ NOTICE_SRC: "/js/core/notice-center.js", NOTICE_CSS: "/css/19-terminal.css" });

test("알림 하나가 바뀌어도 이미 보이던 카드는 등장 애니메이션·펼친 상세·포커스를 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const n = await import("/js/core/notice-center.js");
    n.pushNotice({ id: "a", kind: "ask", title: "질문", body: "답해 주세요", detail: "긴 내용", onAnswer() { return false; } });
    const card = () => document.querySelector('.iris-notice[data-id="a"]');
    const firstAnimated = card().getAnimations().length > 0;
    card().querySelector(".iris-notice-detail").click();
    card().querySelector(".iris-notice-actions button").focus();
    n.pushNotice({ id: "b", kind: "ok", title: "다른 알림" });
    return {
      firstAnimated,
      replayed: card().getAnimations().length > 0,
      open: card().querySelector(".iris-notice-detail").classList.contains("expanded"),
      focused: document.activeElement === card().querySelector(".iris-notice-actions button"),
    };
  }), { body: `<link rel="stylesheet" href="/css/00-tokens.css"><link rel="stylesheet" href="/css/19-terminal.css">`, overrides });
  assert.equal(r.firstAnimated, true, "처음 뜰 때는 등장 애니메이션");
  assert.equal(r.replayed, false, "다른 알림이 와도 다시 재생하지 않음");
  assert.equal(r.open, true, "펼친 상세 유지");
  assert.equal(r.focused, true, "포커스 유지");
});
