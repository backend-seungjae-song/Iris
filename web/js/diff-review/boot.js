// 소유 범위: diff 줄 의견, 저장·해결·삭제, 대상 선택과 초안 전달 화면.
// 제공 API: initCapability(ctx), diffreview.render 훅.
// 의존 대상: 공용 hook·dropdown, 모델과 주입받은 스페이스·세션 조회/전송.
// 유지 조건: 의견은 명시적으로 해결하며 전송 성공도 해결로 바꾸지 않는다.
// 영향 범위: sourcecontrol diff의 확장 영역. 기능을 끄면 원래 diff만 남는다.
import { provide } from "../core/hooks.js";
import { createDropdown } from "../core/dropdown.js";
import { featureHidden } from "../core/features.js";
import { createReviewStore, reviewKey, reviewDraft } from "./model.js";

const STORE_KEY = "iris.diffreview.v1";
let ctx, frame, store, dialog, chooser, pending = null, previousFocus;
const edits = new Map();
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store.documents())); }
  catch { ctx.showToast("의견을 저장하지 못했습니다. 창을 닫기 전에 복사하세요", { level: "err" }); }
}
const uid = () => crypto.randomUUID();
function button(text, action, className = "", variant = "cc-btn-txt") {
  const el = document.createElement("button"); el.type = "button";
  el.className = `cc-btn ${variant} ${className}`.trim(); el.textContent = text; el.onclick = action; return el;
}
function eligible(spaceId) {
  return ctx.getLastAgents().filter((a) => a.workspaceId === spaceId && a.paneId && a.terminalId
    && /^(claude|codex)$/i.test(a.agent || "") && a.status !== "working");
}
function clean(view) { view.querySelectorAll("[data-diffreview]").forEach((el) => el.remove()); }
function paint(next = frame) {
  if (!next?.view?.isConnected) return;
  frame = next;
  const { view, toolbar, lines, tab, rows, spaceId } = frame;
  clean(view);
  if (featureHidden().has("diffreview") || typeof tab.patch !== "string") return;
  const key = reviewKey(tab, spaceId);
  const notes = store.current(key, tab.patch);
  const unresolved = notes.filter((n) => !n.resolved);
  const bar = document.createElement("span"); bar.className = "dr-toolbar"; bar.dataset.diffreview = "";
  const count = document.createElement("span"); count.className = "dr-count";
  count.textContent = `의견 ${unresolved.length}`; count.hidden = !notes.length;
  const send = button("에이전트에게 전달", () => openSend(frame, unresolved), "dr-send", "cc-btn-pri");
  send.disabled = !unresolved.length || !!pending || !ctx.getIsLocal();
  if (!ctx.getIsLocal()) send.title = "원격 연결에서는 쓸 수 없습니다";
  bar.append(count, send); toolbar?.append(bar);
  const stale = store.stale(key, tab.patch);
  if (stale.length) {
    const box = document.createElement("details"); box.className = "dr-stale"; box.dataset.diffreview = "";
    const title = document.createElement("summary"); title.textContent = `diff가 바뀌기 전에 단 의견 ${stale.length}개. 줄 위치를 확인하세요`; box.append(title);
    for (const note of stale) box.append(noteCard(note, key));
    toolbar?.after(box);
  }
  for (const [draftKey, draft] of edits) if (draftKey.startsWith(key + ":") && draft.patch !== tab.patch) {
    const box = document.createElement("span"); box.className = "dr-note"; box.dataset.diffreview = "";
    const text = document.createElement("span"); text.className = "dr-note-text";
    text.textContent = `diff가 바뀌기 전에 쓰던 의견입니다. 줄 위치를 확인하세요\n${draft.text}`;
    box.append(text, button("복사", () => ctx.copyText(draft.text)),
      button("지우기", () => { edits.delete(draftKey); paint(); })); toolbar?.after(box);
  }
  lines.forEach((line, index) => {
    const row = rows[index]; if (!row || !(row.o || row.n) || !/^[ +\-]/.test(row.text)) return;
    const add = button("+", () => editLine(frame, row, line, index), "dr-line-action");
    add.dataset.diffreview = ""; add.setAttribute("aria-label", `${row.cls === "del" ? "변경 전" : "변경 후"} ${row.cls === "del" ? row.o : row.n}행 의견 추가`);
    line.append(add);
    const side = row.cls === "del" ? "old" : "new", number = Number(side === "old" ? row.o : row.n);
    for (const note of notes.filter((n) => n.side === side && n.line === number)) line.after(noteCard(note, key));
    if (edits.get(key + ":" + index)?.patch === tab.patch) editLine(frame, row, line, index, false);
  });
}
function noteCard(note, key) {
  const card = document.createElement("span"); card.className = "dr-note"; card.dataset.diffreview = "";
  card.dataset.state = note.resolved ? "resolved" : note.sent ? "sent" : "open";
  const body = document.createElement("span"); body.className = "dr-note-text"; body.textContent = note.text;
  const location = document.createElement("span"); location.className = "dr-note-location";
  location.textContent = `${note.side === "old" ? "변경 전" : "변경 후"} ${note.line}행${note.excerpt?.trim() ? ` · ${note.excerpt}` : ""}`;
  const state = document.createElement("span"); state.className = "dr-note-state";
  state.textContent = note.resolved ? "해결됨" : note.sent ? "전달됨" : "미해결";
  const head = document.createElement("span"); head.className = "dr-note-head";
  head.append(location, state, button(note.resolved ? "다시 열기" : "해결", () => { note.resolved = !note.resolved; persist(); paint(); }),
    button("삭제", () => { store.remove(key, note.id); persist(); paint(); }));
  card.append(head, body);
  return card;
}
function editLine(current, row, line, index, focus = true) {
  const key = reviewKey(current.tab, current.spaceId) + ":" + index;
  const capturedPatch = current.tab.patch;
  if (edits.has(key) && edits.get(key).patch !== capturedPatch) {
    ctx.showToast("diff가 바뀌기 전에 쓰던 의견을 복사하거나 지운 뒤 새 의견을 추가하세요", { level: "info" }); return;
  }
  if (line.nextElementSibling?.dataset.editor === key) { if (focus) line.nextElementSibling.querySelector("textarea").focus(); return; }
  const form = document.createElement("span"); form.className = "dr-editor"; form.dataset.diffreview = ""; form.dataset.editor = key;
  const input = document.createElement("textarea"); input.className = "cc-input dr-input"; input.maxLength = 4000;
  input.setAttribute("aria-label", "줄 의견"); input.placeholder = "의견을 입력하세요"; input.value = edits.get(key)?.text || "";
  edits.set(key, { patch: capturedPatch, text: input.value });
  input.oninput = () => edits.set(key, { patch: capturedPatch, text: input.value });
  const cancel = () => { edits.delete(key); form.remove(); line.querySelector(".dr-line-action")?.focus(); };
  const foot = document.createElement("span"); foot.className = "dr-editor-foot";
  foot.append(button("취소", cancel), button("저장", () => {
    try {
      if (current.tab.patch !== capturedPatch) throw new Error("diff가 바뀌었습니다. 의견의 줄 위치를 확인하세요");
      store.add(current.tab, current.spaceId, row, input.value, uid()); edits.delete(key); persist(); paint();
    }
    catch (error) { ctx.showToast("의견을 저장하지 못했습니다", { level: "err", detail: String(error.message) }); }
  }, "", ""));
  form.append(input, foot);
  input.onkeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } };
  line.after(form); if (focus) input.focus();
}
function closeSend() {
  if (pending) return;
  chooser?.destroy(); chooser = null; dialog?.close(); dialog?.remove(); dialog = null;
  if (previousFocus?.isConnected) previousFocus.focus();
}
function openSend(current, notes) {
  if (dialog || !ctx.getIsLocal()) return;
  const capturedPatch = current.tab.patch;
  previousFocus = document.activeElement;
  dialog = document.createElement("dialog"); dialog.className = "dr-send-dialog"; dialog.setAttribute("aria-label", "diff 의견 전달");
  const title = document.createElement("h3"); title.textContent = `의견 ${notes.length}개를 보낼 에이전트`;
  const preview = document.createElement("textarea"); preview.className = "cc-input dr-preview"; preview.readOnly = true;
  preview.setAttribute("aria-label", "전달할 내용"); preview.value = reviewDraft(current.tab, notes);
  const status = document.createElement("p"); status.className = "dr-delivery-status"; status.setAttribute("role", "status");
  const agents = eligible(current.spaceId);
  let target = agents[0]?.paneId || "";
  chooser = createDropdown({ items: agents.map((a) => ({ value: a.paneId, label: a.tabLabel || a.agent, sub: a.cwd || "" })),
    value: target, ariaLabel: "같은 스페이스의 에이전트", onChange: (value) => { target = value; } });
  const submit = button("입력창에 넣기", () => {
    if (current.tab.patch !== capturedPatch) {
      status.textContent = "diff가 바뀌었습니다. 창을 닫고 의견의 줄 위치를 확인하세요";
      submit.disabled = true; return;
    }
    const agent = eligible(current.spaceId).find((a) => a.paneId === target);
    if (!agent || !ctx.wsIsOpen()) { status.textContent = "서버 연결과 에이전트 상태를 확인하세요"; return; }
    if (pending) return;
    const requestId = uid();
    submit.disabled = true; status.textContent = "입력창에 넣는 중…";
    const timer = setTimeout(() => {
      if (pending?.requestId !== requestId) return;
      pending = null; status.textContent = "입력됐는지 확인하지 못했습니다. 터미널을 확인한 뒤 다시 시도하세요"; submit.disabled = false; paint();
    }, 15000);
    pending = { requestId, notes: [...notes], timer, status, submit };
    try { ctx.wsSend({ type: "diffreview.draft", requestId, paneId: agent.paneId, terminalId: agent.terminalId, spaceId: current.spaceId, text: preview.value }); }
    catch {
      clearTimeout(timer); pending = null; submit.disabled = false;
      status.textContent = "연결이 끊겼습니다. 터미널을 확인한 뒤 다시 시도하세요";
    }
    paint();
  }, "", "cc-btn-pri");
  submit.disabled = !agents.length;
  chooser.el.hidden = !agents.length;
  status.textContent = agents.length ? "에이전트 입력창에 넣기만 합니다. 보내려면 Enter를 누르세요." : "이 스페이스에 Claude나 Codex 에이전트가 없습니다";
  const actions = document.createElement("div"); actions.className = "dr-send-actions";
  actions.append(button("닫기", closeSend), submit);
  dialog.append(title, chooser.el, preview, status, actions);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeSend(); });
  document.body.append(dialog); dialog.showModal();
}
export function initCapability(context) {
  ctx = context;
  let saved; try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { saved = []; }
  store = createReviewStore(saved);
  provide("diffreview.render", paint);
  return { ws: { "diffreview-draft": (message) => {
    if (!pending || pending.requestId !== message.requestId) return;
    const request = pending; pending = null; clearTimeout(request.timer); request.submit.disabled = false;
    if (message.ok) {
      request.notes.forEach((note) => { note.sent = true; }); persist();
      request.status.textContent = "입력창에 넣었습니다. 확인한 뒤 Enter를 누르세요.";
      request.submit.disabled = true;
    } else request.status.textContent = message.error?.message || "입력창에 넣지 못했습니다";
    paint();
  } } };
}
