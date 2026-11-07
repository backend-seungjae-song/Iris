import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// MEMO_ADMIN_SRC: 고치기 전 판의 panel/memo-admin.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ MEMO_ADMIN_SRC: "/js/panel/memo-admin.js" });

test("메모 방송으로 관리 화면이 다시 그려져도 편집기 칸·스크롤·삭제된 메모 펼침을 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const store = await import("/js/panel/memo-store.js");
    const memo = await import("/js/panel/memo.js");
    const admin = await import("/js/panel/memo-admin.js");
    const $ = (s) => document.querySelector(s);
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const deps = { $, esc, wsSend() {}, showToast() {}, copyText() {}, memoReqId: () => "r", MEMO_MODE: false,
      orderedSpaces: () => [{ id: "s1", label: "하나" }, { id: "s2", label: "둘" }], spk: (x) => x };
    store.initMemoStore({ ...deps, getSpaces: () => [], getSelectedSpaceId: () => "s1", wsIsOpen: () => true,
      snapshotState: { advanceEditRevision: (n) => n + 1 } });
    memo.initMemo({ ...deps, blog() {}, bindAgentKeys() {}, acHost: {} });
    admin.initMemoAdmin(deps);
    document.body.insertAdjacentHTML("beforeend", admin.panelHtml);
    // 삭제된 메모 3개와 보관본 여러 날이 있어 두 칸 모두 스크롤 가능
    const day = (i) => ({ date: `2026-01-${String(i).padStart(2, "0")}`, text: "본문 ".repeat(40), rev: 1, blocks: [] });
    admin.setMemoArchives({ s1: Array.from({ length: 60 }, (_, i) => day(i + 1)) });
    store.setMemoNotes({ localByKey: { s1: { order: ["a", "b", "c"], notes: Object.fromEntries(["a", "b", "c"].map((id) => [id, { id, name: id, text: "", deletedAt: 1 }])) } } });
    document.body.style.cssText = "height:300px"; $("#mm-body").style.cssText = "height:300px;overflow:auto";
    admin.mmRefresh();
    // 편집기 칸 안의 편집기(Monaco 대신 표지 노드)·스크롤·펼침
    const slot = () => $("#mm-slot");
    const host = document.createElement("div"); host.className = "memo-editor-host"; slot().appendChild(host);
    const slotBefore = slot();
    document.head.insertAdjacentHTML("beforeend", "<style>.mm-scroll{height:100px;overflow:auto}</style>");
    document.querySelectorAll(".mm-scroll")[1].scrollTop = 120;
    $(".mm-deleted").open = true;
    // 노트가 바뀌어(미리보기 문구) 마크업이 달라지는 방송
    store.setMemoNotes({ localByKey: { s1: { order: ["a", "b", "c"], notes: Object.fromEntries(["a", "b", "c"].map((id) => [id, { id, name: id + "!", text: "", deletedAt: 1 }])) } } });
    admin.mmRefresh();
    const out = {
      sameSlot: slot() === slotBefore, hostKept: slot().contains(host),
      scroll: document.querySelectorAll(".mm-scroll")[1].scrollTop, deletedOpen: $(".mm-deleted").open,
      changed: document.querySelector(".mm-deleted .mm-nm").textContent,
    };
    // 같은 내용 방송은 DOM 을 건드리지 않음
    const col = $(".mm-main"); admin.mmRefresh();
    out.identicalKeepsNodes = $(".mm-main") === col;
    return out;
  }), { body: `<link rel="stylesheet" href="/css/00-tokens.css">`, overrides });
  assert.equal(r.changed, "a!", "내용이 바뀐 방송은 실제로 반영");
  assert.equal(r.sameSlot, true, "편집기 칸 노드 유지");
  assert.equal(r.hostKept, true, "편집기 호스트 유지");
  assert.equal(r.scroll, 120, "보관본 스크롤 유지");
  assert.equal(r.deletedOpen, true, "삭제된 메모 펼침 유지");
  assert.equal(r.identicalKeepsNodes, true, "같은 내용이면 다시 만들지 않음");
});
