import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { MAX_APP_TARGETS, appDeviceTargetId } from "./mcp-worker/app-target-contract.js";
import { createMobileReaction, validateMobileReaction, mobileRoleOf, mobileRoleMatches } from "./qa-mobile-reaction.js";
import { artifactDir } from "./artifacts-home.cjs";
import { adbPath } from "./adb-path.js";
import { androidScreenshotPng } from "./android-screencap.js";
import { idbPath } from "../bin/mcp/idb-path.mjs";
import { refreshIdbCompanion } from "../bin/mcp/idb-companion.mjs";
import { needsPaste, pasteIosText } from "../bin/mcp/idb-paste.mjs";
import { createIosHid } from "../bin/mcp/ios-hid.mjs";
import { parseUiautomator } from "../bin/mcp/app.mjs";
import { writeMarks } from "../bin/mcp/report.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ios = (device) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BUTTONS = new Set(["HOME", "BACK", "LOCK", "SIDE_BUTTON", "SIRI", "ENTER", "TAB", "BACKSPACE"]);
const ANDROID_KEYS = { HOME: 3, BACK: 4, LOCK: 26, SIDE_BUTTON: 26, ENTER: 66, TAB: 61, BACKSPACE: 67 };
const IOS_KEYS = { ENTER: 40, TAB: 43, BACKSPACE: 42 };
const INPUT = new Set(["tap", "swipe", "type", "key"]);
const ALLOWED = {
  targets: [], target: ["device", "clear", "additional"], picks: [], tap: ["device", "x", "y", "expect", "expectedTarget"],
  swipe: ["device", "x1", "y1", "x2", "y2", "duration", "expect", "expectedTarget"], type: ["device", "text", "expect", "expectedTarget", "x", "y"],
  key: ["device", "key", "keycode", "expect", "expectedTarget", "x", "y"], snapshot: ["device"], screenshot: ["device", "stable"], observe: ["device"],
  expect: ["device", "mode", "label", "type", "text"],
  reaction_start: ["device", "expect", "action"], reaction_end: ["device", "id", "reactionId", "delivered"], target_resolve: ["device", "target", "obstacles"], background_observe: ["device", "duration"], reaction_drain:["device","id"], reaction_focus:["device","id","x","y","expectedTarget"],
};
const nameOf = (element) => String(element.AXLabel || element.title || element.AXValue || "").trim();
// label·type 에 맞는 요소가 없으면 관찰값이 빈 문자열이라 원인이 안 보임. 조건과 text 를 담은 요소를 사유에 적음
export function unmatchedReason(args, matches, elements) {
  if (matches.length || (!args.label && !args.type)) return "접근성 트리가 기대 조건과 다릅니다.";
  const filter = [args.label != null && `label 「${args.label}」`, args.type && `type ${args.type}`].filter(Boolean).join("·");
  const holders = args.text ? elements.filter(element => `${element.label}\n${element.value}`.includes(args.text)).slice(0, 3)
    .map(element => `[${element.type}] ${element.label}`) : [];
  return `${filter}에 맞는 요소가 없습니다(label 은 요소의 접근성 이름과 글자 그대로 같아야 함).`
    + (holders.length ? ` text 를 담은 요소: ${holders.join(", ")}` : "");
}
// 못 찾은 대상과 이름 첫 줄이 겹치는 요소 최대 3개. 자동으로 고르지 않고 이유에만 보여 줌
function nearTargets(elements, target) {
  const want = String(target.name ?? target.text ?? "").split("\n")[0].trim();
  if (!want) return [];
  return elements.filter(el => { const first = nameOf(el).split("\n")[0].trim(); return first && (first.includes(want) || want.includes(first)); })
    .slice(0, 3).map(el => ({role:mobileRoleOf(el), name:nameOf(el)}));
}
const visible = (element) => element.frame?.width > 0 && element.frame?.height > 0 && element.type !== "Application";
const fail = (message) => { throw new Error(message); };

function validate(command, args) {
  if (!Object.hasOwn(ALLOWED, command)) fail("허용되지 않은 모바일 QA 명령입니다.");
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("모바일 QA 인자는 객체여야 합니다.");
  for (const key of Object.keys(args)) if (!ALLOWED[command].includes(key)) fail(`허용되지 않은 모바일 QA 인자: ${key}`);
  if (args.device != null && (typeof args.device !== "string" || !args.device.trim())) fail("기기 식별자가 필요합니다.");
  if (args.stable != null && typeof args.stable !== "boolean") fail("stable은 참 또는 거짓이어야 합니다.");
  if (INPUT.has(command)) validateMobileReaction(args.expect);
  if (command === "reaction_start") {
    validateMobileReaction(args.expect);
    if (!args.action || typeof args.action !== "object" || Array.isArray(args.action)) fail("반응 관찰의 조작 설명이 필요합니다.");
    if (args.action.command === "wait") {
      if (!args.action.args || typeof args.action.args !== "object" || Array.isArray(args.action.args) || Object.keys(args.action.args).length) fail("wait 조작 인자는 빈 객체여야 합니다.");
    } else {
      if (!INPUT.has(args.action.command)) fail("반응 관찰에는 tap, swipe, type, key 또는 wait 조작이 필요합니다.");
      validate(args.action.command, {...args.action.args, device:args.device, expect:args.expect});
    }
  }
  if(command === "reaction_focus") {
    if(typeof args.id!=="string"||!args.id)fail("반응 관찰 식별자가 필요합니다.");
    validate("target_resolve",{device:args.device,target:args.expectedTarget});
  }
  if(["type","key"].includes(command)&&(args.x!=null)!==(args.y!=null))fail("포커스 좌표 x와 y가 함께 필요합니다.");
  if (command === "reaction_end") {
    if (args.delivered != null && typeof args.delivered !== "boolean") fail("delivered는 참 또는 거짓이어야 합니다.");
    for (const key of ["id", "reactionId"]) if (args[key] != null && typeof args[key] !== "string") fail("반응 관찰 식별자는 문자열이어야 합니다.");
  }
  for (const key of ["x", "y", "x1", "y1", "x2", "y2", "duration", "keycode"]) {
    if (args[key] != null && (typeof args[key] !== "number" || !Number.isFinite(args[key]) || args[key] < 0)) fail(`${key}: 0 이상의 숫자가 필요합니다.`);
  }
  for (const key of ["tap","reaction_focus"].includes(command) ? ["x", "y"] : command === "swipe" ? ["x1", "y1", "x2", "y2"] : []) {
    if (args[key] == null) fail(`${key}: 필수 인자입니다.`);
  }
  if (args.duration != null && (args.duration <= 0 || args.duration > 60)) fail("duration: 0초 초과 60초 이하가 필요합니다.");
  if (command === "type" && (typeof args.text !== "string" || args.text.length > 100000)) fail("입력할 문자열이 필요합니다(최대 100000자).");
  if (command === "key") {
    if ((args.key != null) === (args.keycode != null)) fail("key 또는 keycode 중 하나가 필요합니다.");
    if (args.key != null && !BUTTONS.has(args.key)) fail(`허용되지 않은 모바일 QA 키입니다: ${args.key}. 쓸 수 있는 key: ${[...BUTTONS].join(", ")} (iOS 는 BACK 없음). 그 밖의 키는 keycode`);
    if (args.keycode != null && (!Number.isSafeInteger(args.keycode) || args.keycode > 65535)) fail("유효한 키코드가 필요합니다.");
  }
  if (command === "target") {
    if (args.clear != null && typeof args.clear !== "boolean") fail("clear는 참 또는 거짓이어야 합니다.");
    if (args.additional != null && typeof args.additional !== "boolean") fail("additional은 참 또는 거짓이어야 합니다.");
    if (args.additional && args.clear) fail("additional과 clear를 함께 사용할 수 없습니다.");
    if (args.clear && args.device != null) fail("clear와 device를 함께 사용할 수 없습니다.");
  }
  if(command === "target_resolve"){
    if(args.obstacles!==undefined&&(!Array.isArray(args.obstacles)||args.obstacles.length>50||args.obstacles.some(c=>!c||typeof c!=="object"||Array.isArray(c)||!["sel","text","role","name"].some(key=>typeof c[key]==="string"&&c[key].trim())||Object.values(c).some(value=>typeof value!=="string"))))fail("obstacles: sel·text·role·name 문자열 조건 목록이 필요합니다.");
    const t=args.target;
    if(!t||typeof t!=="object"||Array.isArray(t)||Object.keys(t).some(key=>!["role","name","text","nth"].includes(key))||t.nth!=null&&!(Number.isInteger(t.nth)&&t.nth>=1)||!((typeof t.text==="string"&&t.text.trim()&&t.role==null&&t.name==null)||(typeof t.role==="string"&&t.role.trim()&&typeof t.name==="string"&&t.name.trim()&&t.text==null)))fail("대상의 role과 name 또는 text가 필요합니다.");
  }
  if (command === "expect") {
    if (!["exists", "absent", "contains", "equals"].includes(args.mode)) fail("허용되지 않은 모바일 판정 모드입니다.");
    for (const key of ["label", "type", "text"]) if (args[key] != null && typeof args[key] !== "string") fail(`${key}: 문자열이 필요합니다.`);
    if (["contains", "equals"].includes(args.mode) && typeof args.text !== "string") fail("판정할 text가 필요합니다.");
    if (["exists", "absent"].includes(args.mode) && !args.label?.trim() && !args.type?.trim() && !args.text?.trim()) fail("존재를 확인할 label, type 또는 text가 필요합니다.");
  }
}

// idb·adb 오류 출력 한 줄(argparse 는 usage 뒤에 error 줄). 입력 원문이 섞이지 않게 명령 이름·플래그·UDID 외 인자는 가림
const NATIVE_WORDS = new Set(["ui", "tap", "swipe", "text", "key", "button", "describe-all", "screenshot", "connect", "shell", "input", "keyevent", "exec-out", "screencap", "emu", "avd", "name"]);
export function nativeFailureMessage(kind, args, stderr) {
  const lines = String(stderr || "").split("\n").map(line => line.trim()).filter(Boolean);
  let line = lines.findLast(line => /error/i.test(line)) || lines[0];
  if (!line) return `${kind} 실행에 실패했습니다.`;
  const hidden = args.map(String).filter(arg => arg && !arg.startsWith("-") && !NATIVE_WORDS.has(arg) && !/^([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|emulator-\d+)$/i.test(arg))
    .sort((a, b) => b.length - a.length);
  for (const value of hidden) line = line.replace(new RegExp(`(?<![\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`, "g"), "[입력값]");
  return `${kind} 실행에 실패했습니다: ${line.slice(0, 200)}`;
}

function runNative(kind, args, { binary = false, timeoutMs = 30000 } = {}) {
  const executable = kind === "idb" ? idbPath() : adbPath();
  if (!executable) return Promise.reject(new Error(`${kind}를 찾지 못했습니다.`));
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: binary ? "buffer" : "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      // execFile 오류 메시지는 명령 전체(입력 원문 포함)라 쓰지 않음
      if (error) reject(new Error(nativeFailureMessage(kind, args, Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr)));
      else resolve(stdout);
    });
  });
}

// iOS idb 명령 전 이전 부팅에 묶인 companion 교체(bin/mcp/idb-companion.mjs)
// iOS 입력은 사람 터치와 같은 serve-sim 도우미로(bin/mcp/ios-hid.mjs). idb 입력 명령은 사람 터치를 막는다
function nativeBackend(run, refresh = (udid) => refreshIdbCompanion(udid).catch(() => false), paste = pasteIosText,
  hid = createIosHid({ readTree: async (udid) => { await refresh(udid); return JSON.parse(String(await run("idb", ["ui", "describe-all", "--udid", udid]))); } })) {
  return {
    verify: async (device) => {
      if (!device.targetId.startsWith("avd:")) return;
      const result = String(await run("adb", ["-s", device.udid, "emu", "avd", "name"])).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (result[0] !== device.targetId.slice(4) || !result.slice(1).includes("OK")) fail("등록된 AVD와 현재 Android 기기가 다릅니다.");
    },
    tree: async (device, { timeoutMs = 30000 } = {}) => {
      if (!ios(device.udid)) {
        const xml = String(await run("adb", ["-s", device.udid, "exec-out", "uiautomator", "dump", "/dev/tty"], {timeoutMs}));
        if (!xml.includes("<hierarchy")) fail("Android 접근성 트리를 읽지 못했습니다.");
        const tree=parseUiautomator(xml),stack=[];let index=1;
        for(const match of xml.matchAll(/<\/node\s*>|<node\b[^>]*>/g)){const token=match[0];if(token.startsWith("</")){stack.pop();continue;}const current=index++;if(tree[current]){tree[current].parentIndex=stack.at(-1)??0;(tree[stack.at(-1)??0].children??=[]).push(tree[current]);}if(!token.endsWith("/>"))stack.push(current);}
        return tree;
      }
      let tree;
      await refresh(device.udid);
      const text = String(await run("idb", ["ui", "describe-all", "--udid", device.udid], {timeoutMs}));
      try { tree = JSON.parse(text); } catch { fail("iOS 접근성 트리를 해석하지 못했습니다."); }
      if (!Array.isArray(tree)) fail("iOS 접근성 트리를 읽지 못했습니다.");
      return tree;
    },
    screenshot: async (device, file, { timeoutMs = 30000 } = {}) => {
      if (ios(device.udid)) { await refresh(device.udid); await run("idb", ["screenshot", "--udid", device.udid, file], { timeoutMs }); }
      else {
        const output = await run("adb", ["-s", device.udid, "exec-out", "screencap", "-p"], { binary: true, timeoutMs });
        fs.writeFileSync(file, androidScreenshotPng(output), { flag: "wx" });
      }
    },
    input: async (device, command, args) => {
      const u = device.udid;
      const isIos = ios(u);
      if (isIos) {
        if (command === "tap") return hid.tap(u, args.x, args.y);
        if (command === "swipe") return hid.swipe(u, { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, duration: args.duration ?? 0.3 });
        if (command === "type") { if (needsPaste(args.text)) { await refresh(u); await paste(u, args.text); return; } return hid.type(u, args.text); }
        if (command === "key") {
          if (args.key === "BACK") fail("이 플랫폼에서 지원하지 않는 키입니다.");
          const keycode = args.keycode ?? IOS_KEYS[args.key];
          return keycode != null ? hid.key(u, keycode) : hid.button(u, args.key);
        }
        return;
      }
      let words;
      // adb 좌표는 정수만 받음. 대상 이름으로 푼 좌표는 소수
      if (command === "tap") words = ["tap", String(Math.round(args.x)), String(Math.round(args.y))];
      if (command === "swipe") words = ["swipe", ...[args.x1, args.y1, args.x2, args.y2].map(value => String(Math.round(value))), String(Math.round((args.duration ?? 0.3) * 1000))];
      if (command === "type") {
        if (/[^\x20-\x7e]/.test(args.text)) fail("Android 입력은 영문·숫자·기호만 지원합니다(adb input text 제약).");
        words = ["text", args.text.replace(/[\\'"\x60$&|;<>()*?!#~\[\]{}^]/g, "\\$&").replace(/ /g, "%s")];
      }
      if (command === "key") {
        const keycode = args.keycode ?? ANDROID_KEYS[args.key];
        if (keycode == null) fail("이 플랫폼에서 지원하지 않는 키입니다.");
        words = ["keyevent", String(keycode)];
      }
      await run("adb", ["-s", u, "shell", "input", ...words]);
    },
  };
}

// 연결할 기기가 없을 때 세션이 qa_app_target 으로 고를 수 있는 열린 기기 목록. 다른 세션 소유 탭과 다른 세션 등록 기기는 제외
export function noDeviceMessage(session, { tabs, assignments }) {
  const taken = new Set(Object.entries(assignments).filter(([owner]) => owner !== session).flatMap(([, devices]) => devices));
  const choices = [], held = [];
  for (const tab of tabs) {
    let targetId;
    try { targetId = appDeviceTargetId(tab); } catch { continue; }
    if (!tab.tab) continue;
    const label = `${tab.name || "이름 없음"}(${targetId}${tab.space ? `, 스페이스 ${tab.space}` : ""})`;
    // 막힌 이유가 다른 세션의 탭·등록이면 그 세션을 밝힌다. 그 세션이 app_target clear 로 놓아야 쓸 수 있다
    const holder = tab.owner && tab.owner !== session ? tab.owner
      : taken.has(targetId) ? Object.entries(assignments).find(([owner, devices]) => owner !== session && devices.includes(targetId))?.[0] : null;
    if (holder) held.push(`${label} — ${holder} 세션이 사용 중`);
    else choices.push(label);
  }
  return "이 세션에 할당된 열린 Iris 에뮬레이터 기기가 없습니다. "
    + (choices.length ? `qa_app_target device로 연결할 수 있는 열린 기기: ${choices.join(", ")}. ` : "연결할 수 있는 열린 기기가 없습니다. ")
    + (held.length ? `다른 세션이 쓰는 기기: ${held.join(", ")}. 그 세션이 app_target clear로 놓아야 쓸 수 있습니다. ` : "")
    + "꺼진 기기는 qa_app_target device에 기기 ID를 넣으면 켭니다.";
}

// 기기 조회·추가·사용자 선택의 Iris 에뮬레이터 탭 경로
const sameProcessTargets = (() => {
  let adapter;
  const get = async () => adapter ||= import("./mcp-worker/same-process-app-targets.js");
  return {
    read: async () => (await get()).readSameProcessAppTargets(),
    set: async (session, devices) => (await get()).setSameProcessAppTargets(session, devices),
  };
})();

export function createQaMobile({ listDevices, readTargets = sameProcessTargets.read, setTargets = sameProcessTargets.set,
  openDevice, readPicks, run = runNative, paste, hid, backend = nativeBackend(run, undefined, paste, hid), authorize = async () => {},
  shotsDir = artifactDir("shots"), reactionOptions = {}, activity } = {}) {
  if (typeof listDevices !== "function") fail("Iris 에뮬레이터 탭 조회 함수가 필요합니다.");
  // 공유 탭 등록의 직렬화
  let queue = Promise.resolve();
  const reactions = new Map();
  const observationReleases = new Map();
  const reactionKey = (session, device) => session + "\0" + device.targetId;
  const releaseObservation = key => {
    observationReleases.get(key)?.();
    observationReleases.delete(key);
  };
  const state = async (session) => {
    const response = await listDevices(session);
    if (!response?.ok || !Array.isArray(response.data?.tabs)) fail(response?.error || "열린 Iris 에뮬레이터 탭을 확인하지 못했습니다.");
    const assignments = await readTargets();
    if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) fail("기기 등록을 읽지 못했습니다.");
    if (Object.entries(assignments).some(([owner, devices]) => !ID.test(owner) || !Array.isArray(devices) || devices.some(id => typeof id !== "string" || !ID.test(id)))) fail("저장된 기기 등록이 올바르지 않습니다.");
    return { tabs: structuredClone(response.data.tabs), assignments: structuredClone(assignments) };
  };
  const available = (session, tab, { tabs, assignments }) => {
    let targetId;
    try { targetId = appDeviceTargetId(tab); } catch { return false; }
    // 이 세션이 등록한 기기는 소유자 없는 탭이면 스페이스와 관계없이 사용. 앱 재시작 뒤 탭 소유자가 비어 이어받기가 막힌 사례
    const registered = Array.isArray(assignments[session]) && assignments[session].includes(targetId);
    if (!ID.test(String(tab.udid || "")) || !tab.tab || !(tab.mine === true || tab.owner === session || !tab.owner && registered)) return false;
    if (tabs.some(other => other.udid === tab.udid && other.owner && other.owner !== session)) return false;
    return !Object.entries(assignments).some(([owner, devices]) => owner !== session && Array.isArray(devices) && devices.includes(targetId));
  };
  const select = async (session, want, registering = false, opened = false) => {
    const current = await state(session);
    const registered = current.assignments[session] || [];
    if (!Array.isArray(registered)) fail("세션 기기 등록이 올바르지 않습니다.");
    const eligible = current.tabs.filter(tab => available(session, tab, current));
    let candidates;
    if (want) candidates = eligible.filter(tab => tab.udid === want || appDeviceTargetId(tab) === want || tab.name === want);
    else candidates = eligible.filter(tab => registered.length ? registered.includes(appDeviceTargetId(tab)) : tab.owner === session);
    // 탭 외 기기의 세션 탭 생성 및 닫힌 등록 기기의 교체 금지
    if (!candidates.length && !opened && typeof openDevice === "function" && (want ? registering : !registered.length)) {
      const response = await openDevice(session, want ? { device: want.startsWith("avd:") ? want.slice(4) : want } : {});
      if (!response?.ok || !response.data?.udid) fail(response?.error || "Iris 에뮬레이터 탭을 열지 못했습니다.");
      return select(session, response.data.udid, registering, true);
    }
    if (candidates.length !== 1) fail(candidates.length ? "기기가 여러 대 일치합니다. 정확한 기기 식별자를 지정하세요." : noDeviceMessage(session, current));
    const tab = candidates[0];
    const device = { ...tab, targetId: appDeviceTargetId(tab), platform: ios(tab.udid) ? "ios" : "android" };
    if (!registering && !registered.includes(device.targetId) && tab.owner !== session) fail("먼저 target으로 이 세션에 기기를 할당하세요.");
    const authorization = await authorize(session, device);
    if (authorization === false || authorization?.ok === false) fail("모바일 QA 기기 소유권이 없습니다.");
    await backend.verify(device);
    return device;
  };
  const shot = async (session, device, timeoutMs = 30000) => {
    const current = await select(session, device.targetId);
    if (current.udid !== device.udid) fail("캡처 중 기기의 실행 식별자가 바뀌었습니다.");
    fs.mkdirSync(shotsDir, { recursive: true });
    const file = path.join(shotsDir, `qa-mobile-${crypto.randomUUID()}.png`);
    try {
      await backend.screenshot(device, file, { timeoutMs });
      const bytes = fs.readFileSync(file);
      if (bytes.length < 24 || !bytes.subarray(0, PNG.length).equals(PNG)) fail("PNG 화면을 저장하지 못했습니다.");
      return file;
    } catch (error) {
      try { fs.unlinkSync(file); } catch {}
      throw error;
    }
  };
  const metadata = (device, file) => {
    const bytes = fs.readFileSync(file);
    return { device:device.udid, targetId:device.targetId, tab:device.tab, captureTarget:{type:"device",id:device.targetId}, url:"app://" + device.targetId,
      viewport:{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),unit:"image-pixels"} };
  };
  const capture = async (session, device, timeoutMs = 5000) => {
    const take = async timeoutMs => {
      const file = await shot(session, device, timeoutMs);
      try {
        const current = await select(session, device.targetId);
        if (current.udid !== device.udid) fail("캡처 뒤 기기의 실행 식별자가 바뀌었습니다.");
        return { path:file, ...metadata(device, file) };
      } catch (error) {
        try { fs.unlinkSync(file); } catch {}
        throw error;
      }
    };
    return { ...await take(timeoutMs), stability:{waitedMs:0,stable:false,remaining:["not-requested"]} };
  };
  const flush = async (session, {close=false}={}) => {
    const observations=[];
    for(const [key,watch] of reactions)if(key.startsWith(session+"\0")&&(watch.idle||close)){
      try{observations.push(await watch.drain());}catch(error){observations.push({id:watch.id,reactionId:watch.id,error:String(error.message)});}finally{if(close){await watch.stop();await watch.done;reactions.delete(key);releaseObservation(key);}}
    }
    return {moments:[],observations};
  };
  const saveTargets = async (session, devices) => {
    const saved = await setTargets(session, devices);
    if (saved === false || saved?.ok === false) fail(saved?.error || "기기 등록을 저장하지 못했습니다.");
  };
  const additional = async (session, args) => {
    if (typeof openDevice !== "function") fail("Iris 에뮬레이터 탭 추가 함수가 필요합니다.");
    const current = await state(session), retained = [...(current.assignments[session] || [])];
    for (const tab of current.tabs.filter(tab => tab.owner === session)) {
      if (!available(session, tab, current)) fail("소유 기기의 할당이 다른 세션과 충돌합니다.");
      const device = await select(session, appDeviceTargetId(tab), true, true);
      if (!retained.includes(device.targetId)) retained.push(device.targetId);
    }
    if (retained.length >= MAX_APP_TARGETS) fail(`등록·소유 기기는 최대 ${MAX_APP_TARGETS}대입니다.`);
    if (!args.device && retained.length > 1) fail("원본 기기가 여러 대입니다. device를 지정하세요.");
    const sourceId = args.device || retained[0];
    const source = sourceId ? await select(session, sourceId, true, true) : null;
    const response = await openDevice(session, { additional: true,
      ...(source ? { device: source.targetId.startsWith("avd:") ? source.targetId.slice(4) : source.targetId } : {}) });
    if (!response?.ok) fail(response?.error || "Iris 에뮬레이터 탭을 추가하지 못했습니다.");
    const after = await state(session);
    if (JSON.stringify(after.assignments[session] || []) !== JSON.stringify(current.assignments[session] || [])) fail("기기 추가 중 세션의 등록이 바뀌었습니다.");
    const tab = after.tabs.find(tab => tab.udid === response.data?.udid && tab.owner === session && available(session, tab, after));
    if (!tab) fail("추가한 기기의 세션 소유 탭을 확인하지 못했습니다.");
    const device = await select(session, appDeviceTargetId(tab), true, true);
    if (retained.includes(device.targetId)) fail("기존 기기가 응답되어 추가 기기를 등록하지 못했습니다.");
    for (const id of retained) {
      if (Object.entries(after.assignments).some(([owner, devices]) => owner !== session && devices.includes(id))) fail("기기 추가 중 기존 기기의 소유권이 바뀌었습니다.");
      if (after.tabs.some(tab => {
        try { return appDeviceTargetId(tab) === id; } catch { return false; }
      })) await select(session, id, true, true);
    }
    const registered = [...retained, device.targetId];
    await saveTargets(session, registered);
    return { device: device.udid, targetId: device.targetId, platform: device.platform, tab: device.tab, session, registered };
  };
  const perform = async (session, command, args, context) => {
    validate(command, args);
    if (typeof session !== "string" || !ID.test(session)) fail("세션 식별자가 필요합니다.");
    if (command === "picks") {
      if (typeof readPicks !== "function") fail("Iris 앱 선택 조회 함수가 필요합니다.");
      const response = await readPicks(session);
      if (!response?.ok || !Array.isArray(response.data?.picks)) fail(response?.error || "사용자의 앱 선택을 조회하지 못했습니다.");
      return response.data;
    }
    if (command === "targets" || command === "target" && !args.device && !args.clear && !args.additional) {
      const current = await state(session);
      return { session, registered: current.assignments[session] || [], devices: current.tabs.filter(tab => available(session, tab, current)).map(tab => ({ ...tab, targetId: appDeviceTargetId(tab) })) };
    }
    if (command === "target" && args.clear) {
      for (const [key, reaction] of reactions) if (key.startsWith(session + "\0")) {
        reaction.stop(); await reaction.done; reactions.delete(key); releaseObservation(key);
      }
      await saveTargets(session, []);
      return { session, registered: [], ...await flush(session) };
    }
    if (command === "target" && args.additional) return additional(session, args);
    // 관찰이 없으면 기기 선택 없이 빈 결과. 기기를 놓은 세션의 회차 종료가 기기 선택에서 막히던 사례
    if (command === "reaction_drain" && args.device && !reactions.has(reactionKey(session, {targetId:args.device}))) return {device:args.device, targetId:args.device, empty:true};
    const device = await select(session, args.device, command === "target");
    const identity = { device: device.udid, targetId: device.targetId, platform: device.platform, tab: device.tab };
    if (command === "reaction_drain") {const watch=reactions.get(reactionKey(session,device));if(!watch)return {...identity,empty:true};if(args.id&&args.id!==watch.id)fail("반응 관찰 식별자가 다릅니다.");return watch.drain();}
    if (["background_observe","reaction_start"].includes(command)) {const old=reactions.get(reactionKey(session,device));if(old&&!old.idle)fail("기기의 이전 반응 관찰을 먼저 끝내세요.");if(old?.idle){await old.stop();await old.done;reactions.delete(reactionKey(session,device));releaseObservation(reactionKey(session,device));}}
    if (command === "background_observe") {
      const duration = 1000;
      const before = await backend.tree(device);
      const watch = createMobileReaction({ ...reactionOptions, before, background:true,retainIdle:true,expect:{effects:[],within:duration}, action:{command:"background",args:{}}, identity,
        readTree:async ({timeoutMs}) => backend.tree(device,{timeoutMs}), capture:async ({timeoutMs,tree,marks,description}) => {
          const scene=await capture(session,device,timeoutMs); writeMarks(scene.path,marks,tree.find(element=>element.type==="Application")?.frame); return scene;
        }});
      const initial=await watch.initial(); if(!initial.shot){await watch.stop();await watch.done;fail(initial.shotError||"배경 관찰 전 화면을 저장하지 못했습니다.");} watch.arm(); watch.delivered(); const result=await watch.finish();
      const key = reactionKey(session,device);
      reactions.set(key,watch);
      if (activity) observationReleases.set(key, activity.hold("observations", key, { session, device: device.targetId, reactionId: watch.id }));
      return {...identity, ...result, backgroundMs:duration, initial};
    }
    if (command === "target_resolve") {
      const tree = await backend.tree(device); if (!Array.isArray(tree)) fail("접근성 트리를 확인하지 못했습니다.");
      const target=args.target, elements=tree.filter(visible),hits=elements.filter(el=>target.text!=null?nameOf(el).includes(target.text)||String(el.AXValue||"").includes(target.text):mobileRoleMatches(el,target.role)&&nameOf(el)===target.name);
      const nth=Number.isInteger(target.nth)&&target.nth>=1?target.nth:null;
      if(nth?!hits[nth-1]:hits.length!==1)return {...identity,found:false,...(hits.length&&!nth?{ambiguous:true,count:hits.length}:{}),...(nth?{count:hits.length}:{}),...(hits.length?{}:{near:nearTargets(elements,target)})};
      const found=nth?hits[nth-1]:hits[0],x=found.frame.x+found.frame.width/2,y=found.frame.y+found.frame.height/2;
      const ancestors=new Set(),visit=el=>{for(const child of el.children||[]){const node=typeof child==="object"?child:tree.find(node=>[node.id,node.AXIdentifier,node.resourceId].includes(child));if(node===found||node&&visit(node))return true;}return false;};
      for(const el of elements)if(el!==found&&(visit(el)||found.parent===el||found.parentIndex===tree.indexOf(el)||found.parentId!=null&&[el.id,el.AXIdentifier,el.resourceId].includes(found.parentId)))ancestors.add(el);
      // idb 트리는 부모·자식 정보 없이 앞에서부터 그리는 순서로 평평하게 옴. 대상보다 앞에 있고 대상 영역을 다 감싸는 요소는
      // 부모(카드 버튼 안의 하트 등)이거나 아래에 그려진 것이라 가림이 아님. 뒤에 오는 막·대화상자는 그대로 가림
      const order=tree.indexOf(found), inside=(outer,inner)=>outer.frame.x<=inner.frame.x&&outer.frame.y<=inner.frame.y
        &&outer.frame.x+outer.frame.width>=inner.frame.x+inner.frame.width&&outer.frame.y+outer.frame.height>=inner.frame.y+inner.frame.height;
      for(const el of elements)if(el!==found&&tree.indexOf(el)<order&&inside(el,found))ancestors.add(el);
      // 큰 컨테이너는 자식의 중심을 포함하므로 가림 후보에서 제외한다.
      let blocker=elements.find(el=>el!==found&&!ancestors.has(el)&&!/^view|layout|window|scrollview|other|group$/i.test(String(el.type))&&el.frame.x<=x&&el.frame.x+el.frame.width>=x&&el.frame.y<=y&&el.frame.y+el.frame.height>=y&&/overlay|dialog|sheet|button/i.test(String(el.type)));
      const sel=el=>el.resourceId||el.AXIdentifier||null;
      // 터치를 가로채는 투명 영역은 접근성 트리에 없음. 등록된 방해 화면이 보이면 가림으로 판정
      const registered=(args.obstacles||[]).filter(c=>["sel","text","role","name"].some(key=>c[key]!==undefined));
      const obstacle=!blocker&&elements.find(el=>el!==found&&!ancestors.has(el)&&registered.some(c=>(c.sel===undefined||sel(el)===c.sel)&&(c.role===undefined||mobileRoleMatches(el,c.role))&&(c.name===undefined||nameOf(el)===c.name)&&(c.text===undefined||String(el.AXValue??nameOf(el)).includes(c.text))));
      if(obstacle)blocker=obstacle;
      return {...identity,found:true,x,y,target:{role:mobileRoleOf(found),name:nameOf(found),text:String(found.AXValue??nameOf(found))},occluded:!!blocker,blocker:blocker?{sel:sel(blocker),role:mobileRoleOf(blocker),name:nameOf(blocker),text:String(blocker.AXValue??nameOf(blocker)),at:Date.now()}:null};
    }

    const key = reactionKey(session, device), reaction = reactions.get(key);
    if (command === "reaction_start") {
      if (reaction) fail("기기의 이전 반응 관찰을 먼저 끝내세요.");
      const before = await backend.tree(device);
      if (!Array.isArray(before)) fail("반응 관찰 전 접근성 트리를 확인하지 못했습니다.");
      const watch = createMobileReaction({ ...reactionOptions, retainIdle:true, before, expect:args.expect, action:args.action, identity,
        readTree:async ({timeoutMs}) => {
          const current = await select(session, device.targetId);
          if (current.udid !== device.udid) fail("반응 관찰 중 기기의 실행 식별자가 바뀌었습니다.");
          return backend.tree(device, {timeoutMs});
        }, capture:async ({timeoutMs,tree,marks,description}) => {
          const scene = await capture(session, device, timeoutMs);
          writeMarks(scene.path, marks, tree.find(element => element.type === "Application")?.frame);
          fs.writeFileSync(scene.path + ".caption.txt", description);
          return scene;
        } });
      const initial = await watch.initial();
      if (!initial.shot) { watch.stop(); await watch.done; fail(initial.shotError || "반응 관찰 전 화면을 저장하지 못했습니다."); }
      const premise = watch.premise();
      if (premise.length) { watch.stop(); await watch.done; fail(`기대 전제 불성립(조작 안 보냄): ${premise.join(" / ")}`); }
      reactions.set(key, watch);
      if (activity) observationReleases.set(key, activity.hold("observations", key, { session, device: device.targetId, reactionId: watch.id }));
      if(args.action.command === "wait"){watch.arm();watch.delivered();}
      return { ...identity, reactionId:watch.id, scene:initial, scenes:[initial] };
    }
    if(command === "reaction_focus") {
      if(!reaction || reaction.idle || reaction.id!==args.id)fail("기기의 반응 관찰을 찾지 못했습니다.");
      const declared=reaction.action;
      if(!["type","key"].includes(declared.command)||reaction.focusUsed||reaction.mainUsed||reaction.armed)fail("선언한 입력의 포커스 조작은 한 번만 전달할 수 있습니다.");
      if(args.x!==declared.args.x||args.y!==declared.args.y||!isDeepStrictEqual(args.expectedTarget,declared.args.expectedTarget))fail("선언한 입력의 포커스 대상과 다릅니다.");
      const resolved=await perform(session,"target_resolve",{device:device.targetId,target:args.expectedTarget},context);
      if(!resolved.found||resolved.occluded||Math.abs(resolved.x-args.x)>1||Math.abs(resolved.y-args.y)>1)fail("모바일 포커스 대상이 바뀌었거나 가려졌습니다.");
      reaction.focusUsed=true;reaction.arm();
      try{await backend.input(device,"tap",{x:args.x,y:args.y});}catch(error){reaction.delivered(false);throw error;}
      return {...identity,native:true,inputAccepted:true,reactionId:reaction.id,focus:true};
    }
    if (command === "reaction_end") {
      if (!reaction) fail("기기의 반응 관찰을 찾지 못했습니다.");
      if ((args.id ?? args.reactionId) != null && (args.id ?? args.reactionId) !== reaction.id) fail("반응 관찰 식별자가 다릅니다.");
      try { return await reaction.finish(args.delivered); }
      finally { if(!reaction.idle){reactions.delete(key);releaseObservation(key);} }
    }
    if (command === "target") {
      await saveTargets(session, [device.targetId]);
      return { ...identity, session, registered: [device.targetId] };
    }
    if (INPUT.has(command)) {
      if (reaction && !reaction.idle) {
        if(reaction.mainUsed)fail("선언한 모바일 입력은 한 번만 전달할 수 있습니다.");
        if (reaction.action.command !== command) fail("선언한 모바일 조작과 전달한 조작이 다릅니다.");
        if (!isDeepStrictEqual(validateMobileReaction(args.expect), reaction.expect)) fail("관찰 시작 때 선언한 기대 효과와 다릅니다.");
        const physical = Object.fromEntries(Object.entries(args).filter(([name]) => !["device", "expect"].includes(name)));
        if (!isDeepStrictEqual(physical, reaction.action.args)) fail("선언한 모바일 조작 인자와 전달한 인자가 다릅니다.");
        if(args.expectedTarget){const resolved=await perform(session,"target_resolve",{device:device.targetId,target:args.expectedTarget},context);if(!resolved.found||resolved.occluded)fail("모바일 조작 대상이 바뀌었거나 가려졌습니다.");if(command==="tap"&&(Math.abs(resolved.x-args.x)>1||Math.abs(resolved.y-args.y)>1))fail("모바일 조작 대상의 위치가 바뀌었습니다.");}
        reaction.mainUsed=true;
        if(!reaction.armed)reaction.arm();
        const paste = device.platform === "ios" && command === "type" && needsPaste(args.text);
        if (paste) reaction.pause();
        try { await backend.input(device, command, args); if (paste) reaction.resume(); reaction.delivered(); }
        catch (error) { if (paste) reaction.resume(); reaction.delivered(false); throw error; }
        return { ...identity, native:true, inputAccepted:true, reactionId:reaction.id,
          backend:device.platform === "ios" ? "idb" : "adb",
          input:{kind:command === "type" ? "text" : command === "key" ? "key" : "none",
            ...(command === "type" ? {length:args.text.length} : {})} };
      }
      const started = await perform(session, "reaction_start", {device:device.targetId, expect:args.expect,
        action:{command, args:Object.fromEntries(Object.entries(args).filter(([key]) => !["device", "expect"].includes(key)))}}, context);
      let data, inputError;
      try { data = await perform(session, command, args, context); }
      catch (error) { inputError = error; }
      const result = await perform(session, "reaction_end", {device:device.targetId, reactionId:started.reactionId, delivered:!inputError}, context);
      if (inputError) throw inputError;
      return {...data, reaction:result};
    }
    if (command === "screenshot") return { ...identity, ...await capture(session, device) };
    const tree = await backend.tree(device);
    if (!Array.isArray(tree)) fail("접근성 트리를 확인하지 못했습니다.");
    const elements = tree.filter(visible).map(element => ({ type: String(element.type || ""), label: nameOf(element),
      value: String(element.AXValue ?? ""), frame: element.frame, enabled: element.enabled !== false }));
    const snapshot = elements.map(element => `[${element.type}] ${element.label}${element.value && element.value !== element.label ? ` = ${element.value}` : ""}`).join("\n");
    const data = { ...identity, app: nameOf(tree.find(element => element.type === "Application") || {}), elements, snapshot };
    if (command === "snapshot") return data;
    if (command === "observe") {
      const scene = await capture(session, device);
      return { ...data, ...scene, shot:scene.path, alerts:elements.filter(element => /Alert|Sheet|Dialog/i.test(element.type)).map(element => element.label) };
    }
    const matches = elements.filter(element => (!args.label || element.label === args.label) && (!args.type || element.type.toLowerCase() === args.type.toLowerCase()));
    const texts = matches.map(element => element.value || element.label);
    const matched = args.text != null ? texts.filter(text => text === args.text).length : matches.length;
    const pass = args.mode === "exists" ? matched > 0 : args.mode === "absent" ? matched === 0
      : args.mode === "contains" ? texts.some(text => text.includes(args.text)) : texts.length === 1 && texts[0] === args.text;
    let scene = {}, shotError = null;
    try { scene = await capture(session, device); } catch (error) { shotError = error.message; }
    return { ...identity, ...scene, pass: pass && !!scene.path, matched, observed: texts.join("\n"), shot: scene.path || null, shotError, expected: args,
      reason: shotError || (pass ? null : unmatchedReason(args, matches, elements)) };
  };
  return { flush, close:session=>flush(session,{close:true}), activeObservations: () => [...reactions.entries()].filter(([, reaction]) => !reaction.idle).map(([key, reaction]) => ({ key, id: reaction.id })), execute(session, command, args = {}, context = {}) {
    const inputArgs = structuredClone(args), inputContext = structuredClone(context);
    const invoke = () => perform(session, command, inputArgs, inputContext);
    const taskId = `${session}:${command}:${crypto.randomUUID()}`;
    const task = queue.catch(() => {}).then(() => activity ? activity.run("mobile", taskId, invoke, { detail: { session, command } }) : invoke());
    queue = task;
    return task.then(data => {
      return { ok: true, data };
    }, error => ({ ok: false, error: String(error.message) }));
  } };
}
