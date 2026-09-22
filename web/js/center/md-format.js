// 소유 범위: 텍스트 편집기의 서식 편집, 자체 툴바·단축키와 부착 수명.
// 제공 API: initCapability, formatEditor, mdformat.barHtml·mdformat.click 훅.
// 의존 대상: editor-hosts, monaco-keys, keymap과 hooks, 호스트의 editor·barEl.
// 유지 조건: 원문·현재 모델만 수정하고, executeEdits 한 번을 undo stop 둘로 감싼다.
// 영향 범위: 파일·메모 도크·페이지·창의 선택 영역과 마크다운 미리보기.

import { subscribeEditorHosts } from "../core/editor-hosts.js";
import { bindKeymapAction } from "../core/monaco-keys.js";
import { bindingOf, formatBinding, subscribeKeymap } from "../core/keymap.js";
import { provide } from "../core/hooks.js";

// 버튼 표시. 굵게·기울임·취소선은 글자 자체가 그 서식을 나타내므로 글자로 두고(스타일은 CSS 가
// 적용한다), 나머지는 선 아이콘이다. 이름은 title 이 담당한다. 글자 라벨을 여덟 개 늘어놓으면
// 막대가 글자로 가득 차 서로 구별되지 않는다.
const svg = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
const FORMATS = [
  { name: "bold", label: "굵게", text: "B", marker: "**", key: "md-bold" },
  { name: "italic", label: "기울임", text: "I", marker: "*", key: "md-italic" },
  { name: "strike", label: "취소선", text: "S", marker: "~~", key: "md-strike" },
  { name: "code", label: "코드", marker: "`", key: "md-code",
    icon: svg('<path d="m6 4-4 4 4 4"/><path d="m10 4 4 4-4 4"/>') },
  { name: "codeblock", label: "코드 블록", fence: "```", key: "md-codeblock",
    icon: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.6"/>'
      + '<path d="m6.2 6.4-1.7 1.7 1.7 1.7"/><path d="m9.8 6.4 1.7 1.7-1.7 1.7"/>') },
  { name: "list", label: "목록", prefix: "- ", key: "md-list",
    icon: svg('<path d="M6 4h8M6 8h8M6 12h8"/><circle cx="2.75" cy="4" r=".9"/>'
      + '<circle cx="2.75" cy="8" r=".9"/><circle cx="2.75" cy="12" r=".9"/>') },
  { name: "check", label: "체크 목록", prefix: "- [ ] ", key: "md-check",
    icon: svg('<path d="M7.5 4h7M7.5 12h7"/><path d="m1.5 4.2 1.4 1.4 2.4-2.6"/>'
      + '<rect x="1.5" y="10.5" width="3.5" height="3.5" rx=".8"/>') },
  { name: "quote", label: "인용", prefix: "> ", key: "md-quote",
    icon: svg('<path d="M3 3.5v9"/><path d="M6.5 5.5h7.5M6.5 8h7.5M6.5 10.5h5"/>') },
  { name: "link", label: "링크", key: "md-link",
    icon: svg('<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2.2-2.2a2.8 2.8 0 0 0-4-4L8 4"/>'
      + '<path d="M9.2 6.8a2.8 2.8 0 0 0-4 0L3 9a2.8 2.8 0 0 0 4 4L8 12"/>') },
];
const attached = new Map();
let initialized = false;

// 서식 여덟 개는 마크다운 호스트에만 붙는다. `**굵게**` 는 .md 밖에서는 텍스트를 망가뜨리기만
// 한다. 미니맵·줄바꿈은 이 막대가 아니라 text-editor 의 보기 옵션이라 모든 파일에 그대로 남는다.
// 호스트가 markdown 을 선언하지 않으면 붙지 않으며, 선언 여부는 아래 검사가 확인한다.
//   bin/smoke/sections/editor-controls.mjs 「편집기 호스트는 마크다운 여부를 밝힌다」
function usable(host) {
  return !!(host?.editable && host?.markdown && host.barEl?.isConnected
    && !host.barEl.closest("[hidden]") && host.editor.getModel());
}

export function formatEditor(host, name) {
  if (!usable(host)) return false;
  const editor = host.editor, model = editor.getModel();
  const monaco = globalThis.monaco || globalThis.window?.monaco;
  if (!monaco || editor.getOption(monaco.editor.EditorOption.readOnly)) return false;
  const format = FORMATS.find((item) => item.name === name);
  const selections = editor.getSelections();
  if (!format || !selections?.length) return false;
  const value = model.getValue();
  const plans = [];
  const selected = selections.map((selection) => ({
    start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()),
    backwards: selection.getDirection() === monaco.SelectionDirection.RTL,
  }));
  if (format.prefix) {
    const lines = new Set();
    for (const selection of selections) {
      const last = selection.endLineNumber - (selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? 1 : 0);
      for (let line = selection.startLineNumber; line <= last; line++) lines.add(line);
    }
    const rows = [...lines].sort((left, right) => left - right).map((line) => {
      const text = model.getLineContent(line), indent = /^[\t ]*/.exec(text)[0];
      return { start: model.getOffsetAt({ lineNumber: line, column: indent.length + 1 }), body: text.slice(indent.length) };
    });
    const remove = rows.every((row) => row.body.startsWith(format.prefix));
    const allTasks = rows.every((row) => /^- \[[ xX]\] /.test(row.body));
    const allChecked = rows.every((row) => /^- \[[xX]\] /.test(row.body));
    for (const row of rows) {
      let length = remove ? format.prefix.length : 0, text = remove ? "" : format.prefix;
      if (name === "check") {
        length = /^- \[[ xX]\] /.test(row.body) ? 6 : row.body.startsWith("- ") ? 2 : 0;
        text = allTasks && !allChecked ? "- [x] " : "- [ ] ";
      }
      plans.push({ start: row.start, end: row.start + length, text });
    }
  } else if (format.fence) {
    // 울타리는 고른 줄 위아래에 한 줄씩 넣는다. 이미 감싸여 있으면 그 두 줄을 제거한다.
    // 판정은 바로 위·아래 줄만 보며, 그 줄이 이 블록의 울타리다.
    const lineCount = value.split("\n").length;
    const lineStart = (line) => model.getOffsetAt({ lineNumber: line, column: 1 });
    const lineEnd = (line) => lineStart(line) + model.getLineContent(line).length;
    for (const [index, selection] of selections.entries()) {
      const first = selection.startLineNumber;
      const last = selection.endLineNumber
        - (selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? 1 : 0);
      const fenced = first > 1 && last < lineCount
        && model.getLineContent(first - 1).trim().startsWith(format.fence)
        && model.getLineContent(last + 1).trim().startsWith(format.fence);
      const head = fenced ? { start: lineStart(first - 1), end: lineStart(first), text: "" }
        : { start: lineStart(first), end: lineStart(first), text: format.fence + "\n" };
      const tail = fenced ? { start: lineEnd(last), end: lineEnd(last + 1), text: "" }
        : { start: lineEnd(last), end: lineEnd(last), text: "\n" + format.fence };
      const anchor = { ...head, index, from: selected[index].start - head.end + head.text.length,
        to: selected[index].end - head.end + head.text.length };
      // 빈 줄 하나면 두 울타리의 위치가 같아 순서가 정해지지 않으므로 한 번에 넣는다.
      if (!fenced && head.start === tail.start) {
        plans.push({ ...anchor, text: format.fence + "\n\n" + format.fence, from: format.fence.length + 1, to: format.fence.length + 1 });
      } else {
        plans.push(anchor, tail);
      }
    }
  } else {
    for (const [index, selection] of selected.entries()) {
      let { start, end } = selection;
      const text = value.slice(start, end), marker = format.marker;
      let replacement, from, to;
      if (name === "link") {
        replacement = `[${text}](url)`; from = text.length + 3; to = from + 3;
      } else if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
        replacement = text.slice(marker.length, -marker.length); from = 0; to = replacement.length;
      } else if (start !== end && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker) {
        start -= marker.length; end += marker.length; replacement = text; from = 0; to = text.length;
      } else {
        replacement = marker + text + marker; from = marker.length; to = from + text.length;
      }
      plans.push({ start, end, text: replacement, index, from, to });
    }
  }
  plans.sort((left, right) => left.start - right.start || left.end - right.end);
  if (plans.some((plan, index) => index && plan.start < plans[index - 1].end)) return false;
  const offsetAfter = (offset) => {
    let delta = 0;
    for (const plan of plans) {
      if (offset < plan.start) break;
      if (offset <= plan.end) return plan.start + delta + plan.text.length;
      delta += plan.text.length - (plan.end - plan.start);
    }
    return offset + delta;
  };
  const targets = selected.map((selection) => ({ ...selection, start: offsetAfter(selection.start), end: offsetAfter(selection.end) }));
  let delta = 0;
  for (const plan of plans) {
    if (plan.index !== undefined) {
      targets[plan.index].start = plan.start + delta + plan.from;
      targets[plan.index].end = plan.start + delta + plan.to;
    }
    delta += plan.text.length - (plan.end - plan.start);
  }
  const edits = plans.map((plan) => {
    const start = model.getPositionAt(plan.start), end = model.getPositionAt(plan.end);
    return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: plan.text };
  });
  editor.pushUndoStop();
  try {
    editor.executeEdits("iris.mdformat", edits, () => targets.map((target) => {
      const start = model.getPositionAt(target.backwards ? target.end : target.start);
      const end = model.getPositionAt(target.backwards ? target.start : target.end);
      return new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column);
    }));
  } finally { editor.pushUndoStop(); }
  editor.focus();
  return true;
}

// 마우스를 올렸을 때 뜨는 안내로, 이름과 현재 단축키를 보여준다. 아이콘만으로는 어떤 서식인지
// 알 수 없다. 단축키는 키맵 표에서 읽으므로 사용자가 바꾸면 안내도 함께 바뀐다.
function tipOf(format) {
  const shortcut = format.key ? formatBinding(bindingOf(format.key)) : "";
  return `${format.label}${shortcut ? "  " + shortcut : ""}`;
}
function barHtml() {
  return '<span data-mdformat-bar role="toolbar" aria-label="마크다운 서식">' + FORMATS.map((format) => {
    const tip = tipOf(format).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const face = format.icon || `<span class="mdf-ch">${format.text}</span>`;
    return `<button type="button" class="etool" data-mdformat="${format.name}" data-tip="${tip}" aria-label="${format.label}">${face}</button>`;
  }).join("") + "</span>";
}

function click(target, id) {
  const entry = attached.get(id), button = target?.closest?.("[data-mdformat]");
  if (!entry || !button || !entry.toolbar.contains(button)) return false;
  formatEditor(entry.host, button.dataset.mdformat);
  return true;
}

function detach(id) {
  const entry = attached.get(id);
  if (!entry) return;
  attached.delete(id);
  for (const dispose of entry.disposables) dispose();
  entry.toolbar.remove();
}

function attach(host, event) {
  const entry = attached.get(host.id);
  if (event === "remove" || !usable(host)) { detach(host.id); return; }
  if (entry && entry.host.editor === host.editor && entry.toolbar.parentElement === host.barEl) {
    entry.host = host;
    return;
  }
  detach(host.id);
  let toolbar = host.barEl.querySelector("[data-mdformat-bar]");
  if (!toolbar) { host.barEl.insertAdjacentHTML("beforeend", barHtml()); toolbar = host.barEl.querySelector("[data-mdformat-bar]"); }
  const next = { host, toolbar, disposables: [] };
  attached.set(host.id, next);
  const preserveSelection = (event) => { if (event.target.closest("[data-mdformat]")) event.preventDefault(); };
  const onClick = (event) => {
    if (!click(event.target, host.id)) return;
    event.preventDefault(); event.stopPropagation();
  };
  toolbar.addEventListener("mousedown", preserveSelection);
  toolbar.addEventListener("click", onClick);
  next.disposables.push(() => toolbar.removeEventListener("mousedown", preserveSelection), () => toolbar.removeEventListener("click", onClick));
  for (const format of FORMATS.filter((item) => item.key)) {
    next.disposables.push(bindKeymapAction(host.editor, format.key, () => formatEditor(next.host, format.name)));
  }
}

export function initCapability() {
  if (initialized) return {};
  initialized = true;
  provide("mdformat.barHtml", (host) => host?.editable && host?.markdown ? barHtml() : "");
  provide("mdformat.click", click);
  subscribeEditorHosts(attach);
  subscribeKeymap(() => {
    for (const { toolbar } of attached.values()) {
      for (const format of FORMATS.filter((item) => item.key)) {
        const button = toolbar.querySelector(`[data-mdformat="${format.name}"]`);
        if (button) button.dataset.tip = tipOf(format);
      }
    }
  });
  return {};
}
