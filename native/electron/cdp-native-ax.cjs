// macOS가 그리는 네이티브 창·시트의 AX 조회와 입력.
//
// 소유 범위
//   실행 파일에서 구한 System Events 프로세스 이름, AX 행 구분자, osascript 실행과 응답 해석.
// 제공 API
//   axDescribe() · axClick(button) · axKey(key).
// 의존 대상
//   node:path, node:child_process의 execFile, macOS osascript와 System Events 접근성 권한.
// 유지 조건
//   프로세스 이름은 process.execPath의 basename이어야 하고, 제어문자 구분자와 버튼 이름의
//   따옴표·역슬래시 제거를 보존한다. native key는 escape와 enter만 허용한다.
// 영향 범위
//   공급자는 Electron 실행 파일명·macOS AX 트리·접근성 권한이고, 양방향 소비자는
//   cdp-control.cjs의 nativewin/nativeclick/nativekey 명령과 CLI·MCP 도구·QA observe 흐름이다.

const path = require("node:path");
const { execFile } = require("node:child_process");

// CDP는 Chromium이 그리는 것만 다룬다. 파일 열기·저장 패널, 권한 시트, 인쇄 창은 OS가 그리므로
// CDP로는 존재조차 보이지 않는다. 접근성 API로 보고 누른다.
// 값 구분자는 화면에 나올 수 없는 제어문자를 쓴다. 버튼 이름에 쉼표가 들어가도 깨지지 않는다.
// System Events가 보는 프로세스 이름은 실행 파일 이름이다. 설치본은 `Iris`, 개발 회차는
// `Electron`이라 상수로 고정하면 한쪽이 동작하지 않는다. 실제로 `"Electron"`이 고정돼 있어 설치된
// 앱에서는 이 경로가 언제나 "앱 프로세스를 찾지 못했습니다"였다(확인 결과).
const AX_APP = path.basename(process.execPath);
const AX_SEP = "\u001f", AX_ROW = "\u001e";
function osa(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: String(stderr || err.message || err).trim().slice(0, 300) });
      resolve({ ok: true, out: String(stdout || "").trim() });
    });
  });
}
// 창과 시트를 훑어 이름·버튼·문구를 낸다. 시트가 있으면 그것이 현재 사용자 조작을 막고 있다.
async function axDescribe() {
  const script = `set AXSEP to (ASCII character 31)
set AXROW to (ASCII character 30)
set outp to ""
tell application "System Events"
  if not (exists process "${AX_APP}") then return "NOPROC"
  tell process "${AX_APP}"
    repeat with w in windows
      set wn to ""
      try
        set wn to name of w
      end try
      set sheetCount to 0
      try
        set sheetCount to count of sheets of w
      end try
      set btns to ""
      set txts to ""
      set axKind to "window"
      set axTarg to w
      if sheetCount > 0 then
        set axTarg to sheet 1 of w
        set axKind to "sheet"
      end if
      try
        repeat with b in (every button of axTarg)
          try
            -- 신호등 버튼처럼 이름이 없는 것은 description으로 대신한다. 둘 다 없으면 건너뛴다.
            set bn to ""
            try
              set bn to (name of b) as text
            end try
            if bn is "" or bn is "missing value" then
              try
                set bn to (description of b) as text
              end try
            end if
            if bn is not "" and bn is not "missing value" then set btns to btns & bn & ", "
          end try
        end repeat
      end try
      try
        repeat with s in (every static text of axTarg)
          try
            set txts to txts & (value of s) & " "
          end try
        end repeat
      end try
      set outp to outp & axKind & AXSEP & wn & AXSEP & btns & AXSEP & txts & AXROW
    end repeat
  end tell
end tell
return outp`;
  const r = await osa(script);
  if (!r.ok) return { ok: false, error: "접근성 접근 실패 — 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 이 앱을 허용해야 합니다. (" + r.error + ")" };
  if (r.out === "NOPROC") return { ok: false, error: "앱 프로세스를 찾지 못했습니다." };
  const rows = r.out.split(AX_ROW).map((s) => s.trim()).filter(Boolean).map((row) => {
    const [kind, name, buttons, texts] = row.split(AX_SEP);
    return {
      kind, name: (name || "").trim(),
      buttons: (buttons || "").split(",").map((s) => s.trim()).filter(Boolean),
      text: (texts || "").trim().slice(0, 400),
    };
  });
  const blocking = rows.filter((x) => x.kind === "sheet");
  return {
    ok: true, windows: rows, blocking,
    note: blocking.length
      ? "시트가 떠 있습니다 — 사람이 누를 때까지 그 창의 조작이 막힙니다. nativeclick 으로 버튼을 누르세요."
      : "지금 막고 있는 네이티브 시트는 없습니다.",
  };
}
async function axClick(button) {
  // 이름을 그대로 AppleScript 문자열에 넣으므로 따옴표·역슬래시를 막는다.
  const safe = button.replace(/[\\"]/g, "");
  const script = `tell application "System Events"
  if not (exists process "${AX_APP}") then return "NOPROC"
  tell process "${AX_APP}"
    repeat with w in windows
      try
        if (count of sheets of w) > 0 then
          click button "${safe}" of sheet 1 of w
          return "OK-sheet"
        end if
      end try
    end repeat
    repeat with w in windows
      try
        click button "${safe}" of w
        return "OK-window"
      end try
    end repeat
  end tell
end tell
return "NOTFOUND"`;
  const r = await osa(script);
  if (!r.ok) return { ok: false, error: "접근성 접근 실패 — " + r.error };
  if (r.out === "NOPROC") return { ok: false, error: "앱 프로세스를 찾지 못했습니다." };
  if (r.out === "NOTFOUND") return { ok: false, error: `"${button}" 버튼을 찾지 못했습니다. nativewin으로 이름을 확인하세요.` };
  return { ok: true, clicked: button, where: r.out };
}

async function axKey(key) {
  const which = String(key || "escape").toLowerCase();
  const code = which === "enter" || which === "return" ? 36 : which === "escape" || which === "esc" ? 53 : null;
  if (code == null) return { error: "escape 또는 enter만 보낼 수 있습니다." };
  const r = await osa(`tell application "System Events" to tell process "${AX_APP}" to key code ${code}`);
  return r.ok ? { ok: true, key: which } : { ok: false, error: r.error };
}

module.exports = { axDescribe, axClick, axKey };
