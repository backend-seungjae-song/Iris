// 소유 범위: 현재 keymap 값을 편집기별 Monaco action으로 변환·재배정·해제.
// 제공 API: bindKeymapAction(editor, id, run)의 해제 함수와 shortcutLabel(id).
// 의존 대상: keymap 구독과 이미 로드된 전역 Monaco의 KeyCode·KeyMod.
// 유지 조건: addAction의 editorId 격리, Cmd·Ctrl 양쪽, 폐기 시 구독 해제, 지연 로딩 유지.
// 영향 범위: 편집기 표시 옵션과 마크다운 서식 단축키, 키 설정 화면.

import { bindingOf, formatBinding, subscribeKeymap } from "./keymap.js";

// 버튼에 표시할 단축키 문자열. 표에서 읽으므로 사용자가 키를 바꾸면 안내도 함께 바뀐다.
// 문자열을 여기 고정하면 화면에 표시된 키와 실제 동작하는 키가 달라진다.
export function shortcutLabel(id) {
  const binding = bindingOf(id);
  return binding ? formatBinding(binding) : "";
}

function keyCode(binding, monaco) {
  const code = binding.code || binding.key;
  const aliases = { ArrowUp: "UpArrow", ArrowDown: "DownArrow", ArrowLeft: "LeftArrow", ArrowRight: "RightArrow",
    " ": "Space", ";": "Semicolon", "=": "Equal", ",": "Comma", "-": "Minus", ".": "Period",
    "/": "Slash", "`": "Backquote", "[": "BracketLeft", "\\": "Backslash", "]": "BracketRight", "'": "Quote" };
  const name = /^[a-z]$/i.test(code) ? `Key${code.toUpperCase()}` : /^\d$/.test(code) ? `Digit${code}` : aliases[code] || code;
  return monaco.KeyCode[name];
}

export function bindKeymapAction(editor, id, run) {
  let action = null, disposed = false, disposal;
  const bind = () => {
    action?.dispose(); action = null;
    const monaco = globalThis.monaco || globalThis.window?.monaco;
    const binding = bindingOf(id);
    if (disposed || !monaco || !binding) return;
    const code = keyCode(binding, monaco);
    if (!code) return;
    const base = code | (binding.alt ? monaco.KeyMod.Alt : 0) | (binding.shift ? monaco.KeyMod.Shift : 0);
    const keybindings = binding.mod ? [base | monaco.KeyMod.CtrlCmd, base | monaco.KeyMod.WinCtrl] : [base];
    action = editor.addAction({ id: `iris.${id}`, label: id, keybindings, keybindingContext: "editorTextFocus", run: () => run(editor) });
  };
  const unsubscribe = subscribeKeymap(bind);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    action?.dispose(); unsubscribe(); disposal?.dispose();
  };
  disposal = editor.onDidDispose(dispose);
  bind();
  return dispose;
}
