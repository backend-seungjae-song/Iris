// iOS 시뮬레이터 ASCII 밖 글자 입력. 사용처: MCP 앱 도구(app.mjs)·QA 모바일(server/qa-mobile.js)
//
// 키 입력(ios-hid.mjs)은 US 자판 ASCII 만 보냄. 시뮬레이터 붙여넣기판에 넣고
// Cmd+V 를 보낸 뒤, iOS 가 띄우는 붙여넣기 허용 확인을 누름. 입력값이 붙여넣기판에 남지 않게 마지막에 비움.
import { execFile } from "node:child_process";
import { idbPath } from "./idb-path.mjs";
import { createIosHid } from "./ios-hid.mjs";

export const needsPaste = (text) => /[^\x20-\x7e]/.test(String(text));

// 붙여넣기 허용 확인 버튼의 중심. 시뮬레이터 언어에 따라 이름이 다름
const ALLOW_LABELS = new Set(["붙여넣기 허용", "Allow Paste"]);
export function allowPastePoint(tree) {
  const button = (Array.isArray(tree) ? tree : []).find((el) => ALLOW_LABELS.has(String(el?.AXLabel || "")) && el.frame);
  return button ? { x: Math.round(button.frame.x + button.frame.width / 2), y: Math.round(button.frame.y + button.frame.height / 2) } : null;
}

const exec = (file, args, { input, timeout = 15000 } = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    // 오류 메시지는 명령 전체라 입력값이 섞일 수 있어 쓰지 않음
    if (error) reject(new Error(`${file.split("/").pop()} 실행에 실패했습니다.`)); else resolve(stdout);
  });
  if (input != null) child.stdin.end(input);
});

const simPbcopy = (udid, value) => exec("xcrun", ["simctl", "pbcopy", udid], { input: value });
const describeTree = async (udid) => JSON.parse(await exec(idbPath() || "idb", ["ui", "describe-all", "--udid", udid], { timeout: 30000 }));
// Cmd+V 와 허용 버튼 탭은 사람 터치와 같은 도우미 경로로(ios-hid.mjs)
const hid = createIosHid({ readTree: describeTree });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 허용 창이 닫힌 뒤 약 3.5초 동안 앱 접근성 트리가 요소 1개로 비어 있었음(앱 화면에는 결과 표시). 다시 읽힐 때까지 최대 8초
async function readable(udid, describe, wait) {
  for (let i = 0; i < 32; i++) {
    const tree = await describe(udid);
    if (Array.isArray(tree) && tree.length > 1) return;
    await wait(250);
  }
}

export async function pasteIosText(udid, text, { pbcopy = simPbcopy, cmdV = (u) => hid.paste(u), describe = describeTree, tap = (u, x, y) => hid.tap(u, x, y), wait = sleep } = {}) {
  await pbcopy(udid, String(text));
  try {
    await cmdV(udid);
    // 확인 창은 앱 설정이 "허용"이면 뜨지 않음. 약 3초 안에 안 뜨면 붙여넣기가 끝난 것으로 봄
    for (let i = 0; i < 12; i++) {
      const point = allowPastePoint(await describe(udid));
      if (point) {
        // 창이 뜨자마자 누르면 무시되고, 창이 닫힌 뒤 같은 자리의 자동완성 후보가 눌린 사례 있음. 0.8초 기다린 뒤 누르고, 남아 있으면 다시 누름
        for (let attempt = 0; attempt < 3; attempt++) {
          await wait(800);
          const current = allowPastePoint(await describe(udid));
          if (!current) { await readable(udid, describe, wait); return { allowed: true }; }
          await tap(udid, current.x, current.y);
        }
        await wait(800);
        if (allowPastePoint(await describe(udid))) throw new Error("붙여넣기 허용 창을 닫지 못했습니다.");
        await readable(udid, describe, wait);
        return { allowed: true };
      }
      await wait(250);
    }
    return { allowed: false };
  } finally {
    await pbcopy(udid, "").catch(() => {});
  }
}
