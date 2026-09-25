// 채팅 턴을 HTML 로 그린다. 모든 글자는 escape 한 뒤에 넣는다(기록 파일은 이 앱이 보증하지 않는 입력).
//
// 소유 범위
//   턴·도구 묶음·생각 줄·diff 의 마크업과, 펼침 상태 표(open 집합)를 읽어 그리는 규칙.
//
// 제공 API
//   initView({ esc, mdToHtml }) · renderTurn(turn, agentKind, expanded) · turnSignature(turn, expanded).
//
// 의존 대상
//   agentchat/fold.js 의 순수 함수. esc·mdToHtml 은 boot 가 init 에서 넘긴다.
//
// 영향 범위
//   agentchat/boot.js 만 부른다. 현재 목록 확인: node bin/importers.mjs web/js/agentchat/view.js

import { diffFromCall, formatInput, pairTools, previewInput, summarizeRun } from "./fold.js";
import { agentMark } from "../core/glyphs.js";

let esc = (s) => String(s);
let md = (s) => esc(s);
const RESULT_MAX = 4000;

export function initView(deps) {
  esc = deps.esc;
  md = deps.mdToHtml;
}

const ICON = {
  chev: `<svg class="i achat-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
};

// 마크다운 처리기가 만든 링크 중 웹 주소가 아닌 것은 주소를 떼어 누를 수 없게 한다.
// javascript: 같은 주소가 기록에 들어 있으면 그대로 실행된다.
function safeMd(text) {
  return md(text).replace(/<a href="([^"]*)"/g, (m, href) => (/^https?:\/\//i.test(href.replace(/&amp;/g, "&")) ? m : "<a"));
}

function whoLabel(role, agentKind) {
  if (role === "user") return "나";
  if (role === "system") return "알림";
  return agentKind === "codex" ? "Codex" : agentKind === "claude" ? "Claude" : "에이전트";
}

function renderTools(seg, open) {
  const sum = summarizeRun(seg.blocks);
  const isOpen = open.has(seg.key);
  const pairs = pairTools(seg.blocks);
  const failed = pairs.some((p) => p.result?.isError);
  let body = "";
  if (isOpen) {
    body = `<div class="achat-tool-list">${pairs.map((p, i) => renderToolItem(p, `${seg.key}#${i}`, open)).join("")}</div>`;
  }
  return `<div class="achat-tools${isOpen ? " open" : ""}${failed ? " failed" : ""}">`
    + `<button class="achat-tools-head" type="button" data-achat-toggle="${esc(seg.key)}" aria-expanded="${isOpen}">`
    + `${ICON.chev}<span class="achat-tools-n">${sum.count}×</span><span class="achat-tools-sum">${esc(sum.text)}</span></button>`
    + body + `</div>`;
}

function renderToolItem(pair, key, open) {
  const call = pair.call, result = pair.result;
  const name = call ? call.name : "결과";
  const isOpen = open.has(key);
  const state = !result ? " pending" : result.isError ? " err" : "";
  let detail = "";
  if (isOpen) {
    const diff = diffFromCall(call);
    const parts = [];
    if (diff) {
      parts.push(`<pre class="achat-diff">${diff.map((l) => `<span class="achat-d-${l.kind}">${esc(l.text) || " "}</span>`).join("\n")}</pre>`);
    } else if (call) {
      const input = formatInput(call.input);
      if (input) parts.push(`<pre class="achat-pre">${esc(input)}</pre>`);
    }
    if (result) {
      const out = result.output.length > RESULT_MAX ? `${result.output.slice(0, RESULT_MAX)}…` : result.output;
      parts.push(`<pre class="achat-pre achat-result${result.isError ? " err" : ""}">${esc(out || "(빈 결과)")}</pre>`);
    } else parts.push(`<div class="achat-note">결과를 기다리는 중</div>`);
    detail = `<div class="achat-tool-detail">${parts.join("")}</div>`;
  }
  return `<div class="achat-tool${isOpen ? " open" : ""}${state}">`
    + `<button class="achat-tool-head" type="button" data-achat-toggle="${esc(key)}" aria-expanded="${isOpen}">`
    + `${ICON.chev}<span class="achat-tool-name">${esc(name)}</span><span class="achat-tool-arg">${esc(call ? previewInput(call.input) : previewInput(result?.output))}</span></button>`
    + detail + `</div>`;
}

function renderReasoning(seg, open) {
  const isOpen = open.has(seg.key);
  const first = seg.text.replace(/\s+/g, " ").trim();
  return `<div class="achat-reason${isOpen ? " open" : ""}">`
    + `<button class="achat-reason-head" type="button" data-achat-toggle="${esc(seg.key)}" aria-expanded="${isOpen}">`
    + `${ICON.chev}<span class="achat-reason-k">생각</span><span class="achat-reason-sum">${esc(first.slice(0, 120))}</span></button>`
    + (isOpen ? `<div class="achat-reason-body">${esc(seg.text)}</div>` : "")
    + `</div>`;
}

function renderSegment(seg, open) {
  if (seg.kind === "text") return `<div class="achat-md">${safeMd(seg.text)}</div>`;
  if (seg.kind === "tools") return renderTools(seg, open);
  if (seg.kind === "reasoning") return renderReasoning(seg, open);
  if (seg.kind === "image") return `<div class="achat-note">이미지 첨부</div>`;
  return "";
}

// 턴 하나. 같은 턴을 매번 다시 파싱하지 않도록 boot 가 결과를 캐시한다.
export function renderTurn(turn, agentKind, open) {
  const role = turn.role === "user" ? "user" : turn.role === "system" ? "system" : "agent";
  if (role === "system") {
    return `<div class="achat-turn system"><span>${esc(turn.segments.map((s) => s.text || "").join(" "))}</span></div>`;
  }
  return `<div class="achat-turn ${role}" data-turn="${esc(turn.key)}">`
    + `<div class="achat-who">${role === "agent" ? agentMark(agentKind) : ""}${esc(whoLabel(turn.role, agentKind))}</div>`
    + turn.segments.map((s) => renderSegment(s, open)).join("")
    + `</div>`;
}

export function turnSignature(turn, open) {
  let sig = `${turn.role}|${turn.segments.length}`;
  for (const s of turn.segments) {
    sig += `|${s.kind}:${s.text ? s.text.length : 0}:${s.blocks ? s.blocks.length : 0}:${open.has(s.key) ? 1 : 0}`;
    if (s.blocks && open.has(s.key)) {
      for (let i = 0; i < s.blocks.length; i++) if (open.has(`${s.key}#${i}`)) sig += `#${i}`;
      sig += `r${s.blocks.filter((b) => b.type === "tool-result").length}`;
    }
  }
  return sig;
}

