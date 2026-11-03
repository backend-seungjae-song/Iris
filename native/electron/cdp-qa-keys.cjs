// QA 채널의 키 입력. CDP Input.dispatchKeyEvent 인자 구성
// macOS 편집 단축키와 Chromium 편집 명령의 대응표. Playwright 1.57 macEditingCommands(Apache-2.0) 원본 그대로
const MAC_EDITING_COMMANDS = {
  "Backspace": "deleteBackward:",
  "Enter": "insertNewline:",
  "NumpadEnter": "insertNewline:",
  "Escape": "cancelOperation:",
  "ArrowUp": "moveUp:",
  "ArrowDown": "moveDown:",
  "ArrowLeft": "moveLeft:",
  "ArrowRight": "moveRight:",
  "F5": "complete:",
  "Delete": "deleteForward:",
  "Home": "scrollToBeginningOfDocument:",
  "End": "scrollToEndOfDocument:",
  "PageUp": "scrollPageUp:",
  "PageDown": "scrollPageDown:",
  "Shift+Backspace": "deleteBackward:",
  "Shift+Enter": "insertNewline:",
  "Shift+NumpadEnter": "insertNewline:",
  "Shift+Escape": "cancelOperation:",
  "Shift+ArrowUp": "moveUpAndModifySelection:",
  "Shift+ArrowDown": "moveDownAndModifySelection:",
  "Shift+ArrowLeft": "moveLeftAndModifySelection:",
  "Shift+ArrowRight": "moveRightAndModifySelection:",
  "Shift+F5": "complete:",
  "Shift+Delete": "deleteForward:",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+End": "moveToEndOfDocumentAndModifySelection:",
  "Shift+PageUp": "pageUpAndModifySelection:",
  "Shift+PageDown": "pageDownAndModifySelection:",
  "Shift+Numpad5": "delete:",
  "Control+Tab": "selectNextKeyView:",
  "Control+Enter": "insertLineBreak:",
  "Control+NumpadEnter": "insertLineBreak:",
  "Control+Quote": "insertSingleQuoteIgnoringSubstitution:",
  "Control+KeyA": "moveToBeginningOfParagraph:",
  "Control+KeyB": "moveBackward:",
  "Control+KeyD": "deleteForward:",
  "Control+KeyE": "moveToEndOfParagraph:",
  "Control+KeyF": "moveForward:",
  "Control+KeyH": "deleteBackward:",
  "Control+KeyK": "deleteToEndOfParagraph:",
  "Control+KeyL": "centerSelectionInVisibleArea:",
  "Control+KeyN": "moveDown:",
  "Control+KeyO": ["insertNewlineIgnoringFieldEditor:","moveBackward:"],
  "Control+KeyP": "moveUp:",
  "Control+KeyT": "transpose:",
  "Control+KeyV": "pageDown:",
  "Control+KeyY": "yank:",
  "Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Control+ArrowUp": "scrollPageUp:",
  "Control+ArrowDown": "scrollPageDown:",
  "Control+ArrowLeft": "moveToLeftEndOfLine:",
  "Control+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Control+Enter": "insertLineBreak:",
  "Shift+Control+NumpadEnter": "insertLineBreak:",
  "Shift+Control+Tab": "selectPreviousKeyView:",
  "Shift+Control+Quote": "insertDoubleQuoteIgnoringSubstitution:",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection:",
  "Shift+Control+KeyB": "moveBackwardAndModifySelection:",
  "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection:",
  "Shift+Control+KeyF": "moveForwardAndModifySelection:",
  "Shift+Control+KeyN": "moveDownAndModifySelection:",
  "Shift+Control+KeyP": "moveUpAndModifySelection:",
  "Shift+Control+KeyV": "pageDownAndModifySelection:",
  "Shift+Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Shift+Control+ArrowUp": "scrollPageUp:",
  "Shift+Control+ArrowDown": "scrollPageDown:",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Alt+Backspace": "deleteWordBackward:",
  "Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Alt+Escape": "complete:",
  "Alt+ArrowUp": ["moveBackward:","moveToBeginningOfParagraph:"],
  "Alt+ArrowDown": ["moveForward:","moveToEndOfParagraph:"],
  "Alt+ArrowLeft": "moveWordLeft:",
  "Alt+ArrowRight": "moveWordRight:",
  "Alt+Delete": "deleteWordForward:",
  "Alt+PageUp": "pageUp:",
  "Alt+PageDown": "pageDown:",
  "Shift+Alt+Backspace": "deleteWordBackward:",
  "Shift+Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+Escape": "complete:",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection:",
  "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection:",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection:",
  "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection:",
  "Shift+Alt+Delete": "deleteWordForward:",
  "Shift+Alt+PageUp": "pageUp:",
  "Shift+Alt+PageDown": "pageDown:",
  "Control+Alt+KeyB": "moveWordBackward:",
  "Control+Alt+KeyF": "moveWordForward:",
  "Control+Alt+Backspace": "deleteWordBackward:",
  "Shift+Control+Alt+KeyB": "moveWordBackwardAndModifySelection:",
  "Shift+Control+Alt+KeyF": "moveWordForwardAndModifySelection:",
  "Shift+Control+Alt+Backspace": "deleteWordBackward:",
  "Meta+NumpadSubtract": "cancel:",
  "Meta+Backspace": "deleteToBeginningOfLine:",
  "Meta+ArrowUp": "moveToBeginningOfDocument:",
  "Meta+ArrowDown": "moveToEndOfDocument:",
  "Meta+ArrowLeft": "moveToLeftEndOfLine:",
  "Meta+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Meta+NumpadSubtract": "cancel:",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine:",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Meta+KeyA": "selectAll:",
  "Meta+KeyC": "copy:",
  "Meta+KeyX": "cut:",
  "Meta+KeyV": "paste:",
  "Meta+KeyZ": "undo:",
  "Shift+Meta+KeyZ": "redo:",
};


// 셋째 값은 키가 만드는 글자. Chrome 의 폼 Enter 제출·버튼 Space 누름은 글자가 있는 keyDown 에서만 일어남. 2차 인증 폼이 Enter 로 제출되지 않던 사례
const KEY_CODES = {
  Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
  ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: ["Space", 32, " "],
};
function macCommands(code, modifiers, platform = process.platform) {
  if (platform !== "darwin") return [];
  const names = [[8, "Shift"], [2, "Control"], [1, "Alt"], [4, "Meta"]].filter(([bit]) => modifiers & bit).map(([, name]) => name);
  const found = MAC_EDITING_COMMANDS[[...names, code].join("+")] || [];
  return (Array.isArray(found) ? found : [found]).filter(command => !command.startsWith("insert")).map(command => command.slice(0, -1));
}
async function dispatchKey(send, raw) {
  const parts = String(raw || "").split("+");
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = { Alt: 1, Option: 1, Ctrl: 2, Control: 2, Meta: 4, Command: 4, Shift: 8 }[part];
    if (!bit) throw new Error("지원하지 않는 QA 키 조합입니다");
    modifiers |= bit;
  }
  const key = parts.at(-1);
  const spec = KEY_CODES[key];
  if (!spec && !/^[\x20-\x7e]$/.test(key || "")) throw new Error("지원하지 않는 QA 키입니다");
  const code = spec?.[0] || (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /[0-9]/.test(key) ? "Digit" + key : key);
  const virtualKey = spec?.[1] || key.toUpperCase().charCodeAt(0);
  // 수식키가 있어도 글자를 함께 보내고 macOS 편집 명령을 붙임(Playwright 방식). 글자도 명령도 없는 Cmd 키는 앱 메뉴 첫 항목(정보)을 실행
  // Ctrl·Alt·Cmd와 누른 영문자는 Shift가 없으면 소문자
  const typed = modifiers & 7 && /^[a-z]$/i.test(key) ? (modifiers & 8 ? key.toUpperCase() : key.toLowerCase()) : key;
  const text = spec ? spec[2] || "" : typed;
  const common = { key: key === "Space" ? " " : typed, code, windowsVirtualKeyCode: virtualKey, modifiers };
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...common, commands: macCommands(code, modifiers),
    ...(text ? { text, unmodifiedText: text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

module.exports = { dispatchKey, macCommands };
