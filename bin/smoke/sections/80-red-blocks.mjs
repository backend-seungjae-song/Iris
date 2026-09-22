// 소유 범위: Block 0–4 RED와 후속 edge-case·coverage 회귀 검사.
// 제공 API: 원래 RED 블록 자리에서 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 계수·읽기·소스 슬라이서, sources의 이름 붙은 소스 문자열.
// 유지 조건: 검사 이름·순서·문구, RED 도우미 판정, full smoke 출력과 DOCX-only 무출력.
// 영향 범위: 러너가 동적 import로 이 run을 부르며 core의 fnBody/b4Function 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/80-red-blocks.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";

import { b4Function, check, fnBody, read, readAll } from "../core.mjs";
import {
  centerTabs, contextMenu, dock, docxEditor, fsIpcSource, keynav, main, mainJs, pick, viewerBoot, viewerKinds,
  pickHost, sheetActions, sheetEdit, sheetEvents, sheetMode, sheetModel, sheetRender, sheetTabState, tabClose, textEditor, tree,
  web, webviewFactory,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
  // ── Block 0 RED: sheet.write 배선과 tab I/O 상관관계 ────────────────────────
  console.log("\n[Block 0 RED] sheet.write 배선과 tab I/O 상관관계");
  check("[T-B0-1] sheet.write가 handleSheetWrite로 dispatch됨", () =>
    /else if \(msg\.type === "sheet\.write"\) handleSheetWrite\(ws, msg\);/.test(read("server/index.js")));

  check("[T-B0-2] 4개 I/O handler 성공 응답이 correlation envelope를 echo함", () => {
    const fsHandlers = read("server/fs-handlers.js"), sheetHandlers = read("server/sheet-handlers.js");
    const fields = ["requestId", "space", "tabId", "reason"];
    const hasEcho = (part) => fields.every((field) => new RegExp(field + "\\s*:\\s*msg\\." + field + "\\b").test(part));
    const handlers = [
      [fsHandlers, "export async function handleFsRead", "// fs.write", /const content =/, /\bcontent\b/],
      [sheetHandlers, "export async function handleSheetRead", "// sheet.write", /const data =/, /\bdata\b/],
      [sheetHandlers + "\n// end sheet handlers", "export async function handleSheetWrite", "// end sheet handlers", /await writeSheet\(p, edits\)/, /\bsaved\b/],
      [fsHandlers, "export async function handleFsWrite", "// fs.op", /fs\.writeFileSync\(p, msg\.content, "utf8"\)/, /type:\s*"file-saved"|\bok\s*:\s*true/],
    ];
    return handlers.every(([src, start, end, write, success]) => {
      const from = src.indexOf(start), to = src.indexOf(end, from);
      if (from < 0 || to < 0) return false;
      const body = src.slice(from, to);
      const writeAt = body.search(write), catchAt = body.lastIndexOf("catch (e)");
      if (writeAt < 0 || catchAt < writeAt) return false;
      const reply = [...body.slice(0, writeAt).matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=/g)]
        .find((m) => hasEcho(body.slice(m.index, m.index + 700)));
      const response = body.slice(writeAt, catchAt);
      return success.test(response) && (hasEcho(response)
        || (!!reply && new RegExp("\\b" + reply[1] + "\\s*\\(").test(response)));
    });
  });

  check("[T-B0-3] fs.write와 sheet.write가 같은 path-keyed write queue를 공유함", () => {
    const owner = read("server/path-io.js"), fsHandlers = read("server/fs-handlers.js"), sheetHandlers = read("server/sheet-handlers.js");
    const queue = owner.match(/const\s+([A-Za-z_$][\w$]*(?:write[\w$]*queue|queue[\w$]*write)[\w$]*)\s*=\s*new Map\s*\(\s*\)/i);
    if (!queue) return false;
    const q = queue[1];
    const queueFn = [...owner.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].find((m) => {
      const body = owner.slice(m.index, m.index + 2600);
      return new RegExp("\\b" + q + "\\.get\\(").test(body) && new RegExp("\\b" + q + "\\.set\\(").test(body);
    });
    if (!queueFn) return false;
    const name = queueFn[1];
    const importRe = new RegExp("import\\s*\\{[^}]*\\b" + name + "\\b[^}]*\\}\\s*from\\s*[\"']\\./path-io\\.js[\"']");
    const sheet = sliceFrom(sheetHandlers, "export async function handleSheetWrite", sheetHandlers.length, "[T-B0-3] fs.write와 sheet.write가 같은 path-keyed write queue를 공유함");
    const text = sliceBetween(fsHandlers, "export async function handleFsWrite", "// fs.op", "[T-B0-3] fs.write와 sheet.write가 같은 path-keyed write queue를 공유함");
    const call = new RegExp("\\b" + name + "\\(\\s*p\\s*,");
    return importRe.test(sheetHandlers) && importRe.test(fsHandlers) && call.test(sheet) && call.test(text);
  });

  check("[T-B0-4] 4개 I/O handler 조기 검증 오류도 correlation envelope를 echo함", () => {
    const fsHandlers = read("server/fs-handlers.js"), sheetHandlers = read("server/sheet-handlers.js");
    const fields = ["requestId", "space", "tabId", "reason"];
    const hasEcho = (part) => fields.every((field) => new RegExp(field + "\\s*:\\s*msg\\." + field + "\\b").test(part));
    const starts = [[fsHandlers, "export async function handleFsRead"], [sheetHandlers, "export async function handleSheetRead"],
      [sheetHandlers, "export async function handleSheetWrite"], [fsHandlers, "export async function handleFsWrite"]];
    return starts.every(([src, start]) => {
      const from = src.indexOf(start), tryAt = src.indexOf("try {", from);
      if (from < 0 || tryAt < 0) return false;
      const early = src.slice(from, tryAt);
      const direct = [...early.matchAll(/JSON\.stringify\(\{[\s\S]{0,700}?\}\)\)/g)]
        .some((m) => /\berror\s*:/.test(m[0]) && hasEcho(m[0]));
      const reply = [...early.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=/g)]
        .find((m) => hasEcho(early.slice(m.index, m.index + 700)));
      const viaReply = !!reply && new RegExp("\\b" + reply[1] + "\\s*\\(\\s*\\{[\\s\\S]{0,180}?\\berror\\s*:").test(early);
      return direct || viaReply;
    });
  });

  check("[T-B0-5] 4개 I/O handler catch 오류도 correlation envelope를 echo함", () => {
    const fsHandlers = read("server/fs-handlers.js"), sheetHandlers = read("server/sheet-handlers.js");
    const fields = ["requestId", "space", "tabId", "reason"];
    const hasEcho = (part) => fields.every((field) => new RegExp(field + "\\s*:\\s*msg\\." + field + "\\b").test(part));
    const bounds = [
      [fsHandlers, "export async function handleFsRead", "// fs.write"],
      [sheetHandlers, "export async function handleSheetRead", "// sheet.write"],
      [sheetHandlers + "\n// end sheet handlers", "export async function handleSheetWrite", "// end sheet handlers"],
      [fsHandlers, "export async function handleFsWrite", "// fs.op"],
    ];
    return bounds.every(([src, start, end]) => {
      const from = src.indexOf(start), to = src.indexOf(end, from);
      if (from < 0 || to < 0) return false;
      const body = src.slice(from, to), catchAt = body.lastIndexOf("catch (e)");
      if (catchAt < 0) return false;
      const caught = body.slice(catchAt);
      if (/\berror\s*:/.test(caught) && hasEcho(caught)) return true;
      const reply = [...body.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=/g)]
        .find((m) => hasEcho(body.slice(m.index, m.index + 700)));
      return !!reply && /\berror\s*:/.test(caught)
        && new RegExp("\\b" + reply[1] + "\\s*\\(").test(caught);
    });
  });

  check("[T-B0-6] sendTabIo가 non-OPEN socket 전송을 즉시 reject함", () => {
    const src = centerTabs;
    const from = Math.max(src.indexOf("function sendTabIo"), src.indexOf("const sendTabIo"));
    if (from < 0) return false;
    const body = src.slice(from, from + 2800);
    return /(?:ws|socket)\.readyState\s*!==?\s*(?:WebSocket\.OPEN|1)/.test(body)
      && /(?:Promise\.reject\s*\(|\breject\s*\()/.test(body);
  });

  check("[T-B0-7] socket generation onclose가 해당 generation in-flight만 reject함", () => {
    const src = centerTabs + "\n" + mainJs;
    const sendAt = Math.max(src.indexOf("function sendTabIo"), src.indexOf("const sendTabIo"));
    if (sendAt < 0) return false;
    const send = src.slice(sendAt, sendAt + 3200);
    if (!/(?:generation\s*:|\b(?:ws|socket)Generation\b|getWsGeneration\s*\(\))/.test(send)) return false;
    const closeAt = src.indexOf("function handleWsClose", sendAt);
    if (closeAt < 0) return false;
    const close = src.slice(closeAt, closeAt + 2400);
    const direct = /\.generation\s*[!=]==?\s*(?:generation|wsGeneration|socketGeneration)/.test(close)
      && /\breject\s*\(/.test(close);
    const delegated = close.match(/\b([A-Za-z_$][\w$]*(?:fail|close|reject)[\w$]*(?:io|pending)[\w$]*)\s*\(\s*(?:generation|wsGeneration|socketGeneration)\b/i);
    if (direct) return true;
    if (!delegated) return false;
    const helperAt = src.search(new RegExp("function\\s+" + delegated[1] + "\\s*\\(|const\\s+" + delegated[1] + "\\s*="));
    const helper = helperAt < 0 ? "" : src.slice(helperAt, helperAt + 2400);
    return /\.generation\s*[!=]==?\s*(?:generation|wsGeneration|socketGeneration)/.test(helper)
      && /\breject\s*\(/.test(helper);
  });

  check("[T-B0-8] sendTabIo ACK timeout이 30초 후 reject 경로로 수렴함", () => {
    const src = centerTabs;
    const from = Math.max(src.indexOf("function sendTabIo"), src.indexOf("const sendTabIo"));
    if (from < 0 || !/const\s+TAB_IO_TIMEOUT_MS\s*=\s*30000\s*;/.test(src)) return false;
    const body = src.slice(from, from + 3600);
    return /setTimeout\([\s\S]{0,500}(?:reject|fail|settle|finish|terminal)[\w$]*\s*\([\s\S]{0,240}TAB_IO_TIMEOUT_MS/i.test(body);
  });

  check("[T-B0-9] request registry에 없는 late ACK는 응답 handler가 조기 반환함", () => {
    const src = centerTabs + "\n" + mainJs;
    const sendAt = Math.max(src.indexOf("function sendTabIo"), src.indexOf("const sendTabIo"));
    if (sendAt < 0) return false;
    const send = src.slice(sendAt, sendAt + 3600);
    const registry = send.match(/\b([A-Za-z_$][\w$]*)\.set\(\s*requestId\b/);
    if (!registry) return false;
    const messageAt = src.indexOf("function dispatchWs", sendAt);
    if (messageAt < 0) return false;
    const response = src.slice(messageAt, messageAt + 14000);
    const get = new RegExp("(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + registry[1]
      + "\\.get\\(\\s*m\\.requestId\\s*\\);\\s*if\\s*\\(\\s*!\\1\\s*\\)\\s*(?:\\{\\s*)?return\\b");
    return get.test(response);
  });

  check("[T-B0-10] path-keyed watch registry가 닫힌 탭 참조만 제거하고 남은 탭을 보존함", () => {
    const src = centerTabs;
    const maps = [...src.matchAll(/const\s+([A-Za-z_$][\w$]*watch[\w$]*)\s*=\s*new Map\s*\(\s*\)/gi)];
    return maps.some((m) => {
      const name = m[1];
      const pathKeyed = new RegExp("\\b" + name + "\\.(?:get|set)\\(\\s*(?:t\\.)?path\\b").test(src);
      const removal = new RegExp("(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + name
        + "\\.get\\([^)]*path[^)]*\\)[\\s\\S]{0,1200}?\\1\\.(?:tabs|tabIds|refs)\\.delete\\([^)]*(?:tabId|tabKey|t\\.id)[^)]*\\)"
        + "[\\s\\S]{0,300}?if\\s*\\(\\s*!\\1\\.(?:tabs|tabIds|refs)\\.size\\s*\\)[\\s\\S]{0,160}?"
        + name + "\\.delete\\([^)]*path[^)]*\\)");
      return pathKeyed && removal.test(src);
    });
  });

  check("[T-B0-11] path write queue가 finally에서 항목을 정리해 다음 write를 진행시킴", () => {
    const src = read("server/path-io.js");
    const queue = src.match(/const\s+([A-Za-z_$][\w$]*(?:write[\w$]*queue|queue[\w$]*write)[\w$]*)\s*=\s*new Map\s*\(\s*\)/i);
    if (!queue) return false;
    const q = queue[1];
    return [...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].some((m) => {
      const body = src.slice(m.index, m.index + 2800);
      return new RegExp("\\b" + q + "\\.get\\(").test(body)
        && new RegExp("\\b" + q + "\\.set\\(").test(body)
        && /\.finally\s*\(/.test(body)
        && new RegExp("\\b" + q + "\\.delete\\(").test(body)
        && (/\.catch\s*\([\s\S]{0,180}?\)\s*\.then\s*\(/.test(body)
          || /\.finally\s*\(\s*(?:task|run|next|job)\b/.test(body)
          || /\.finally\s*\(\s*\(\)\s*=>[\s\S]{0,400}?\b(?:shift|next|run)\b/.test(body));
    });
  });

  check("[EC-B0-1] 3개 이상 write에서도 완료된 항목이 최신 queue tail을 지우지 않음", () => {
    const src = read("server/path-io.js");
    const queue = src.match(/const\s+([A-Za-z_$][\w$]*(?:write[\w$]*queue|queue[\w$]*write)[\w$]*)\s*=\s*new Map\s*\(\s*\)/i);
    if (!queue) return false;
    const q = queue[1];
    return [...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].some((m) => {
      const body = src.slice(m.index, m.index + 3200);
      if (!new RegExp("\\b" + q + "\\.get\\(").test(body)
        || !new RegExp("\\b" + q + "\\.set\\(").test(body)) return false;
      const guardedTailDelete = new RegExp(
        "if\\s*\\(\\s*" + q + "\\.get\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*===\\s*([A-Za-z_$][\\w$]*)\\s*\\)"
        + "\\s*\\{?[\\s\\S]{0,220}?" + q + "\\.delete\\(\\s*\\1\\s*\\)"
      );
      const drainedEntryDelete = new RegExp(
        "if\\s*\\(\\s*!([A-Za-z_$][\\w$]*)\\.(?:jobs|items|tasks|queue)\\.(?:length|size)"
        + "[\\s\\S]{0,180}?" + q + "\\.delete\\("
      );
      return guardedTailDelete.test(body) || drainedEntryDelete.test(body);
    });
  });

  check("[EC-B0-2] 같은 path의 read가 앞선 write 뒤 동일 FIFO에 진입함", () => {
    const owner = read("server/path-io.js"), fsHandlers = read("server/fs-handlers.js"), sheetHandlers = read("server/sheet-handlers.js");
    const queue = owner.match(/const\s+([A-Za-z_$][\w$]*(?:write[\w$]*queue|queue[\w$]*write)[\w$]*)\s*=\s*new Map\s*\(\s*\)/i);
    if (!queue) return false;
    const q = queue[1];
    const queueFn = [...owner.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].find((m) => {
      const body = owner.slice(m.index, m.index + 3200);
      return new RegExp("\\b" + q + "\\.get\\(").test(body)
        && new RegExp("\\b" + q + "\\.set\\(").test(body);
    });
    if (!queueFn) return false;
    const importRe = new RegExp("import\\s*\\{[^}]*\\b" + queueFn[1] + "\\b[^}]*\\}\\s*from\\s*[\"']\\./path-io\\.js[\"']");
    const call = new RegExp("\\b" + queueFn[1] + "\\(\\s*p\\s*,");
    const reads = [
      [fsHandlers, "export async function handleFsRead", "// fs.write"],
      [sheetHandlers, "export async function handleSheetRead", "// sheet.write"],
    ];
    return importRe.test(fsHandlers) && importRe.test(sheetHandlers) && reads.every(([src, start, end]) => {
      const from = src.indexOf(start), to = src.indexOf(end, from);
      return from >= 0 && to > from && call.test(src.slice(from, to));
    });
  });

  check("[EC-B0-3] stale ACK는 같은 requestId의 새 socket generation을 settle하지 않음", () => {
    const src = centerTabs + "\n" + mainJs;
    const sendAt = Math.max(src.indexOf("function sendTabIo"), src.indexOf("const sendTabIo"));
    if (sendAt < 0) return false;
    const send = src.slice(sendAt, sendAt + 4200);
    const registry = send.match(/\b([A-Za-z_$][\w$]*)\.set\(\s*requestId\b/);
    if (!registry) return false;
    const messageAt = src.indexOf("function dispatchWs", sendAt);
    if (messageAt < 0) return false;
    const response = src.slice(messageAt, messageAt + 16000);
    const entry = response.match(new RegExp(
      "(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + registry[1]
      + "\\.get\\(\\s*m\\.requestId\\s*\\)"
    ));
    if (!entry) return false;
    const generation = "(?:generation|wsGeneration|socketGeneration)";
    return new RegExp(
      "if\\s*\\(\\s*" + entry[1] + "\\.generation\\s*!==?\\s*" + generation
      + "\\s*\\)\\s*(?:\\{\\s*)?return\\b"
    ).test(response);
  });

  check("[EC-B0-4] OPEN 검사 뒤 ws.send 동기 예외도 terminal cleanup으로 수렴함", () => {
    const src = centerTabs;
    const sendAt = Math.max(src.indexOf("function sendTabIo"), src.indexOf("const sendTabIo"));
    if (sendAt < 0) return false;
    const send = src.slice(sendAt, sendAt + 5200);
    const registry = send.match(/\b([A-Za-z_$][\w$]*)\.set\(\s*requestId\b/);
    if (!registry) return false;
    const caught = send.match(/try\s*\{[\s\S]{0,900}?\.(?:send)\s*\([\s\S]{0,500}?\)\s*;?\s*\}\s*catch\s*\([^)]*\)\s*\{?([\s\S]{0,500}?)(?:\}|\n\s*\);)/);
    if (!caught) return false;
    const terminal = caught[1].match(/\b((?:fail|settle|finish|terminal)[A-Za-z_$][\w$]*)\s*\(/i);
    if (!terminal) return false;
    const helperAt = src.search(new RegExp("function\\s+" + terminal[1] + "\\s*\\(|const\\s+" + terminal[1] + "\\s*="));
    if (helperAt < 0) return false;
    const helper = src.slice(helperAt, helperAt + 3200);
    return new RegExp("\\b" + registry[1] + "\\.delete\\(").test(helper)
      && /clearTimeout\s*\(/.test(helper)
      && /\.reject\s*\(|\breject\s*\(/.test(helper);
  });

  // ── Block 1 RED: 표 저장 계약과 outgoing fileview 소유권 ─────────────────
  console.log("\n[Block 1 RED] 표 저장 계약과 outgoing fileview 소유권");
  check("[T-B1-1] _svMergeEdit은 시트별 ranges와 generation을 보존하는 Map임", () => {
    const src = sheetActions;
    const merge = sliceBetween(src, "function svMerge(", "function svZoom(", "[T-B1-1] _svMergeEdit은 시트별 ranges와 generation을 보존하는 Map임");
    const mapInit = /_svMergeEdit\s*(?::|=)\s*(?:[^;\n]{0,100}(?:\|\||\?\?)\s*)?new Map\s*\(/.test(src);
    const set = merge.match(/_svMergeEdit\.set\(\s*sh\.name\s*,\s*\{([\s\S]{0,500}?)\}\s*\)/);
    return mapInit && !!set && /\branges\s*:/.test(set[1]) && /\bgeneration\s*:/.test(set[1]);
  });

  check("[T-B1-2] svPending은 시트별 병합 Map size를 포함함", () => {
    const src = sheetEdit;
    const from = src.indexOf("function svPending("), to = src.indexOf("function svSave(", from);
    const body = from >= 0 && to > from ? src.slice(from, to) : "";
    return /_svMergeEdit\s*\?\s*t\._svMergeEdit\.size|t\._svMergeEdit\?\.size|_svMergeEdit\.size/.test(body);
  });

  check("[T-B1-3] writeWorkbook은 기존 병합을 전부 해제한 뒤 snapshot 병합을 적용함", () => {
    const src = read("server/sheet.js");
    const from = src.indexOf("export async function writeWorkbook("), to = src.indexOf("export function writeSeparated(", from);
    const body = from >= 0 && to > from ? src.slice(from, to) : "";
    const mergeBranch = body.search(/if\s*\(\s*e\.merge\s*\)/);
    const existing = body.search(/(?:ws\.model\s*&&\s*ws\.model\.merges|ws\.model\?\.merges|ws\.model\.merges)/);
    const unmerge = body.indexOf(".unMergeCells(");
    const apply = body.indexOf(".mergeCells(");
    return mergeBranch >= 0 && existing > mergeBranch && unmerge > existing && apply > unmerge;
  });

  check("[T-B1-4] handleSheetWrite는 merge를 layout·cell과 분리해 먼저 검증함", () => {
    const src = read("server/sheet-handlers.js");
    const from = src.indexOf("export async function handleSheetWrite(");
    const body = from >= 0 ? src.slice(from) : "";
    const mergeAt = body.search(/if\s*\(\s*e\.merge\s*\)/), layoutAt = body.search(/if\s*\(\s*e\.layout\s*\)/);
    const cellAt = body.search(/Number\.isInteger\(\s*e\.r\s*\)/);
    const branch = mergeAt >= 0 ? body.slice(mergeAt, layoutAt > mergeAt ? layoutAt : cellAt) : "";
    return mergeAt >= 0 && layoutAt > mergeAt && cellAt > layoutAt
      && /Array\.isArray\(\s*e\.merge\.ranges\s*\)/.test(branch) && /continue\s*;/.test(branch);
  });

  check("[T-B1-5] CSV·TSV 병합은 UI에서 disabled이고 서버도 형식 helper로 거부함", () => {
    const ui = sheetRender;
    const mergeDisabled = /SHEET_TEXT_RE\.test\(\s*t\.path\s*\)/.test(ui)
      && /(?:k|act)\s*===?\s*["']merge(?:-kind)?["']/.test(ui)
      && /disabled|\bdis\b/.test(ui);
    const sheet = read("server/sheet.js"), server = read("server/sheet-handlers.js");
    const helper = /export\s+(?:const|function)\s+supportsSheetMerges\b/.test(sheet)
      && /supportsSheetMerges/.test(server.slice(0, 1800));
    const handlerAt = server.indexOf("export async function handleSheetWrite(");
    const handler = handlerAt >= 0 ? server.slice(handlerAt) : "";
    return mergeDisabled && helper && /e\.merge[\s\S]{0,800}supportsSheetMerges\(\s*p\s*\)/.test(handler);
  });

  check("[T-B1-6] 저장 ACK는 전송 generation snapshot에 해당하는 edit만 제거함", () => {
    const saveAt = sheetEdit.indexOf("function svSave("), saveTo = sheetEdit.indexOf("function svRangeBox(", saveAt);
    const save = saveAt >= 0 && saveTo > saveAt ? sheetEdit.slice(saveAt, saveTo) : "";
    const ack = fnBody(viewerBoot, "handleSheetSavedMessage");
    return /\b(?:generation|snapshot)\b/.test(save)
      && /_svSaving\s*=\s*\{/.test(save)
      && /_svDirty\.delete\s*\(/.test(ack)
      && /(?:generation|snapshot)/.test(ack)
      && !/_svDirty\s*=\s*new Map\s*\(\s*\)/.test(ack);
  });

  check("[T-B1-7] 오류 ACK는 저장 entry를 식별하되 marker·edit을 비우지 않음", () => {
    const saveAt = sheetEdit.indexOf("function svSave("), saveTo = sheetEdit.indexOf("function svRangeBox(", saveAt);
    const save = saveAt >= 0 && saveTo > saveAt ? sheetEdit.slice(saveAt, saveTo) : "";
    const ack = fnBody(viewerBoot, "handleSheetSavedMessage");
    const error = ack.match(/if\s*\(\s*m\.error\s*\)\s*\{([\s\S]{0,1000}?)\bcontinue\s*;/);
    return /_svSaving\s*=\s*\{[\s\S]{0,800}(?:generation|snapshot)/.test(save)
      && !!error
      && !/_svDirty\s*=|_svDirty\.clear\s*\(|_svDirty\.delete\s*\(|_svLayout\s*=|_svMergeEdit\s*=|_svMergeEdit\.clear\s*\(|_svMergeEdit\.delete\s*\(/.test(error[1]);
  });

  // 정리와 새 시트 적용은 뷰어가 담당하며 순서를 지켜야 한다. 빠져나가는 탭의
  // 편집기를 먼저 커밋한 뒤에 새 시트 번호를 적용한다. 순서가 반대면 아직 커밋하지 않은 편집이
  // 이미 바뀐 시트 번호로 판정되어 그대로 버려진다. 앱 셸의 순서와 뷰어의 커밋을 함께 검사한다.
  check("[T-B1-8] 내려간 뒤에 올라온다 — 선커밋 후에만 nextSheetIdx를 적용함", () => {
    const owner = /(?:let|const)\s+renderedFileOwner\b/.test(centerTabs);
    const body = b4Function(centerTabs, "withFileViewTransition");
    const capture = body.search(/(?:const|let)\s+\w+\s*=\s*renderedFileOwner\b/);
    const leave = body.search(/callHook\(\s*"viewer\.leaveTab"/);
    const enter = body.search(/callHook\(\s*"viewer\.enterTab"/);
    const commit = /svCloseEdit\(\s*t\s*,\s*true\s*\)/.test(b4Function(sheetEdit, "svLeaveTab"));
    const applyIdx = /\.sheetIdx\s*=\s*opts\.nextSheetIdx/.test(b4Function(sheetEdit, "svEnterTab"));
    return owner && capture >= 0 && leave > capture && enter > leave && commit && applyIdx;
  });

  check("[T-B1-9] 경계는 detached·다른 시트 editor를 판별해 미커밋 폐기함", () => {
    const editAt = sheetEdit.indexOf("function svEdit("), editTo = sheetEdit.indexOf("function svCloseEdit(", editAt);
    const edit = editAt >= 0 && editTo > editAt ? sheetEdit.slice(editAt, editTo) : "";
    // 판별은 앱 셸이 아니라 시트가 담당한다. 편집기를 만든 쪽만 어떤 편집기가 자기 것인지 안다.
    const body = b4Function(sheetEdit, "svLeaveTab");
    return /_svEd\s*=\s*\{[\s\S]{0,200}\bsi\s*:/.test(edit)
      && /\.isConnected\b/.test(body)
      && /fileview\.contains\s*\(/.test(body)
      && /\.si\s*===?\s*\([^)]*\.sheetIdx\s*\|\|\s*0\)/.test(body)
      && /_svEd\s*=\s*null/.test(body)
      // 주석은 판정 대상이 아니다. 이전 위치를 설명한 머리말의 단어가 걸리지 않도록 주석을 먼저 제거한다.
      && !/_sv|docx/.test(b4Function(centerTabs, "withFileViewTransition")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, ""));
  });

  check("[T-B1-10] close-dialog 취소 handler는 fileview 전환 경계를 호출하지 않음", () => {
    // closeDialog 매칭을 lazy 로 "cancel" 직전까지만 끊으면 그 뒤를 다시 검색하는 두 번째
    // 정규식에 남는 내용이 없다. 그래서 anchor 는 lazy 로 찾되 그 뒤에
    // 별도 구간을 더해 판정 대상 텍스트를 분리한다.
    if (!/withFileViewTransition/.test(centerTabs)) return false;
    const anchor = tabClose.match(/(?:function\s+\w*(?:close|unsaved)\w*|const\s+\w*(?:close|unsaved)\w*\s*=)[\s\S]{0,5000}?(?:case\s+["']cancel["']|===?\s*["']cancel["']|data-(?:act|ans)=["']cancel["'])/i);
    if (!anchor) return false;
    const tail = tabClose.slice(anchor.index, anchor.index + anchor[0].length + 700);
    const cancel = tail.match(/(?:case\s+["']cancel["']|===?\s*["']cancel["']|data-(?:act|ans)=["']cancel["'])[\s\S]{0,700}?(?:return|break|\}\s*\))/i);
    return !!cancel && !/withFileViewTransition\s*\(/.test(cancel[0]);
  });

  check("[T-B1-11] Monaco loader onerror는 owner·token 일치 guard 뒤 공통 경계로 렌더함", () => {
    const at = textEditor.indexOf("sc.onerror ="), end = textEditor.indexOf("document.head.appendChild(sc)", at);
    const body = at >= 0 && end > at ? textEditor.slice(at, end) : "";
    const guard = body.search(/if\s*\([^)]*owner[^)]*(?:!==?|===?)[^)]*(?:renderedFileOwner|getRenderedFileOwner\s*\(\))[^)]*\)/);
    const token = body.search(/if\s*\([^)]*token[^)]*(?:!==?|===?)[^)]*(?:renderedFileToken|renderToken|fileViewToken|getRenderedFileToken\s*\(\))[^)]*\)/);
    const transition = body.indexOf("withFileViewTransition(");
    const mutate = Math.max(body.indexOf("fileview.innerHTML"), body.indexOf("renderError"));
    return guard >= 0 && token >= 0 && transition > guard && transition > token && mutate > transition;
  });

  check("[T-B1-12] sheet 저장 성공 처리는 renderTabs를 명시적으로 호출함", () => {
    const body = fnBody(viewerBoot, "handleSheetSavedMessage");
    const error = body.indexOf("if (m.error)"), render = body.indexOf("renderTabs()");
    return error >= 0 && render > error;
  });

  check("[EC-B1-1] sheet 저장 중 같은 파일 rename·move는 path queue 뒤에 직렬화됨", () => {
    const src = read("server/fs-handlers.js");
    const from = src.indexOf("export async function handleFsOp("), to = src.indexOf("export function handleFsTree(", from);
    const body = from >= 0 && to > from ? src.slice(from, to) : "";
    const renameAt = body.indexOf('op === "rename"'), moveAt = body.indexOf('op === "move"');
    const rename = renameAt >= 0 ? body.slice(renameAt, moveAt > renameAt ? moveAt : renameAt + 2200) : "";
    const move = moveAt >= 0 ? body.slice(moveAt, moveAt + 2600) : "";
    const queuedRename = /enqueuePathIo\(\s*(?:absSrc\b|src\b|path\.resolve\(\s*src\s*\))/.test(rename)
      && rename.indexOf("enqueuePathIo(") < rename.indexOf("fs.renameSync(");
    const queuedMove = /enqueuePathIo\(\s*(?:absSrc|src)\b/.test(move)
      && move.indexOf("enqueuePathIo(") < move.indexOf("fs.renameSync(");
    return queuedRename && queuedMove;
  });

  check("[EC-B1-2] workbook 저장은 임시 파일 완성 뒤 원본을 atomic replace함", () => {
    const src = read("server/sheet.js");
    const from = src.indexOf("export async function writeWorkbook("), to = src.indexOf("export function writeSeparated(", from);
    const body = from >= 0 && to > from ? src.slice(from, to) : "";
    const delegated = body.match(/\b(atomic[A-Za-z_$]*Write[A-Za-z_$]*)\s*\(\s*filePath\b/);
    const write = body.match(/wb\.xlsx\.writeFile\(\s*([A-Za-z_$][\w$]*)\s*\)/);
    if (!write || write[1] === "filePath") return false;
    const temp = write[1];
    let atomic = body;
    if (delegated) {
      const helperAt = src.search(new RegExp("(?:function\\s+" + delegated[1] + "\\s*\\(|(?:const|let)\\s+" + delegated[1] + "\\s*=)"));
      if (helperAt < 0) return false;
      atomic += "\n" + src.slice(helperAt, helperAt + 3200);
    }
    const stagedInDir = /(?:dirname|mkdtemp|temp)[A-Za-z_$]*\s*\(/i.test(atomic);
    const replace = /(?:rename|replace)[A-Za-z_$]*\s*\(/.test(atomic);
    const cleanup = /(?:unlink|rm)[A-Za-z_$]*\s*\(/.test(atomic);
    return stagedInDir && replace && cleanup;
  });

  // ── Block 2 RED: 공용 dirty 판정과 닫기·삭제·rename 안전 경계 ─────────────
  console.log("\n[Block 2 RED] 공용 dirty 판정과 닫기·삭제·rename 안전 경계");
  // 판정의 소유자가 바뀌었다. 네 종류는 그 필드를 만드는 시트가 판정하고, 앱 셸은 dirty 여부만
  // 묻는다. 그래서 양쪽을 함께 검사한다. 시트가 네 종류를 부수효과 없이 판정하는지, 앱 셸이
  // 그 필드 이름을 더는 참조하지 않는지 본다.
  check("[T-B2-1] 표의 4가지 dirty를 시트가 부수효과 없이 판정하고, 틀은 묻기만 함", () => {
    const body = b4Function(sheetEdit, "svTabDirty");
    if (!body) return false;
    const cell = /t\._svDirty(?:\?\.|\.)size|t\._svDirty\s*&&\s*t\._svDirty\.size/.test(body);
    const layout = /Object\.keys\(\s*t\._svLayout\s*\)\.length|Object\.keys\(\s*t\._svLayout\s*\|\|\s*\{\s*\}\s*\)\.length/.test(body);
    const merge = /t\._svMergeEdit(?:\?\.|\.)size|t\._svMergeEdit\s*&&\s*t\._svMergeEdit\.size/.test(body);
    const editor = /t\._svEd\b/.test(body);
    const mutates = /\b(?:svCloseEdit|renderTabs|showActiveTab|sendTabIo)\s*\(|t\.(?:_svDirty|_svLayout|_svMergeEdit|_svEd)\s*=|t\.(?:_svDirty|_svMergeEdit)\.(?:set|delete|clear)\s*\(|delete\s+t\._svLayout/.test(body);
    const frame = b4Function(tabClose, "isTabDirty");
    const asks = /callHook\(\s*"viewer\.tabDirty"/.test(frame) && !/_sv|docx/.test(frame);
    return cell && layout && merge && editor && /\breturn\b/.test(body) && !mutates && asks;
  });

  check("[T-B2-2] 6개 사용자 닫기 경로가 모두 closeTabs로 수렴함", () => {
    const clickAt = tabClose.indexOf('tabstrip.addEventListener("click"');
    const ctxAt = tabClose.indexOf('tabstrip.addEventListener("contextmenu"', clickAt);
    const dblAt = tabClose.indexOf('tabstrip.addEventListener("dblclick"', ctxAt);
    const click = clickAt >= 0 && ctxAt > clickAt ? tabClose.slice(clickAt, ctxAt) : "";
    const ctx = ctxAt >= 0 && dblAt > ctxAt ? tabClose.slice(ctxAt, dblAt) : "";
    const shortcutAt = dock.indexOf("if (window.acHost && window.acHost.onShortcut)");
    const shortcut = shortcutAt >= 0 ? dock.slice(shortcutAt, shortcutAt + 4200) : "";
    const keysAt = keynav.indexOf("// herdr 탭 단축키:");
    const keys = keysAt >= 0 ? keynav.slice(keysAt, keysAt + 5200) : "";
    const xClick = /(?:closest\(["']\.cclose["']\)|data-close)[\s\S]{0,260}?closeTabs\s*\(/.test(click);
    const menuClose = /label:\s*["']탭 닫기["'][\s\S]{0,260}?closeTabs\s*\(/.test(ctx);
    const menuOthers = /label:\s*["']다른 탭 모두 닫기["'][\s\S]{0,420}?closeTabs\s*\(/.test(ctx);
    // 「모두 닫기」는 closeAllTabs 를 거쳐 수렴한다. 한 단계 더 거칠 뿐 성질은 같으므로, 그
    // 함수가 실제로 closeTabs 를 호출하는지까지 검사한다. 확인하지 않으면 이름만 같은 경로도 통과한다.
    const allViaHelper = /label:\s*["']모두 닫기["'][\s\S]{0,320}?closeAllTabs\s*\(/.test(ctx)
      && /closeTabs\s*\(/.test(b4Function(tabClose, "closeAllTabs"));
    const menuAll = allViaHelper || /label:\s*["']모두 닫기["'][\s\S]{0,320}?closeTabs\s*\(/.test(ctx);
    const ctrlW = /e\.ctrlKey[\s\S]{0,240}?k\s*===?\s*["']w["'][\s\S]{0,320}?closeTabs\s*\(/.test(keys);
    const palette = /case\s+["']close-tab["']\s*:[\s\S]{0,180}?closeTabs\s*\(/.test(shortcut);
    return xClick && menuClose && menuOthers && menuAll && ctrlW && palette;
  });

  check("[T-B2-3] closeTabs 저장 선택은 ACK 뒤 성공하고 clean인 탭만 제거함", () => {
    const src = tabClose;
    const from = src.search(/(?:async\s+)?function\s+closeTabs\s*\(/);
    const next = from >= 0 ? src.indexOf("\nfunction ", from + 20) : -1;
    const body = from >= 0 ? src.slice(from, next > from ? next : from + 10000) : "";
    const dirty = body.search(/(?:filter|some)\s*\([\s\S]{0,180}?isTabDirty\s*\(/);
    const save = body.search(/(?:choice|answer|action|result)\s*===?\s*["']save["']|case\s+["']save["']/i);
    const awaitSave = save >= 0 ? body.slice(save).search(/await\s+(?:Promise\.(?:all|allSettled)\s*\(|[A-Za-z_$][\w$]*(?:save|Save)[\w$]*\s*\()/) : -1;
    const clean = save >= 0 && awaitSave >= 0 ? body.slice(save + awaitSave).search(/!\s*isTabDirty\s*\(/) : -1;
    const remove = save >= 0 && awaitSave >= 0 && clean >= 0 ? body.slice(save + awaitSave + clean).search(/removeTabsNow\s*\(/) : -1;
    return from >= 0 && dirty >= 0 && save >= 0 && awaitSave >= 0 && clean >= 0 && remove >= 0;
  });

  check("[T-B2-4] closeTabs 배치 저장 일부 실패는 성공한 탭만 선별 제거함", () => {
    const src = tabClose;
    const from = src.search(/(?:async\s+)?function\s+closeTabs\s*\(/);
    const next = from >= 0 ? src.indexOf("\nfunction ", from + 20) : -1;
    const body = from >= 0 ? src.slice(from, next > from ? next : from + 10000) : "";
    const save = body.search(/(?:choice|answer|action|result)\s*===?\s*["']save["']|case\s+["']save["']/i);
    const branch = save >= 0 ? body.slice(save) : "";
    const failureAware = /Promise\.allSettled\s*\(|\btry\s*\{[\s\S]{0,2500}?\bcatch\s*\(|\.(?:catch)\s*\(/.test(branch);
    const selective = /(?:successful|succeeded|closable|clean|saved)[A-Za-z_$]*\.(?:push|add)\s*\(|\.filter\s*\([\s\S]{0,500}?!\s*isTabDirty\s*\(/i.test(branch);
    const removal = branch.match(/removeTabsNow\s*\(\s*([A-Za-z_$][\w$]*)/);
    return save >= 0 && failureAware && selective && !!removal && !/^(?:targets?|dirty(?:Tabs?)?)$/i.test(removal[1]);
  });

  check("[T-B2-5] closeTabs 취소 분기는 제거·fileview 전환 없이 즉시 끝남", () => {
    const src = tabClose;
    const from = src.search(/(?:async\s+)?function\s+closeTabs\s*\(/);
    const next = from >= 0 ? src.indexOf("\nfunction ", from + 20) : -1;
    const body = from >= 0 ? src.slice(from, next > from ? next : from + 10000) : "";
    const at = body.search(/(?:choice|answer|action|result)\s*===?\s*["']cancel["']|case\s+["']cancel["']/i);
    const cancel = at >= 0 ? body.slice(at, at + 500) : "";
    const stop = cancel.search(/\b(?:return|break)\b/);
    const handler = stop >= 0 ? cancel.slice(0, stop + 20) : cancel;
    return at >= 0 && stop >= 0 && !/removeTabsNow\s*\(|withFileViewTransition\s*\(/.test(handler);
  });

  check("[T-B2-6] dirty 다이얼로그 coordinator는 중복 open을 막고 해제함", () => {
    const src = tabClose;
    const flag = src.match(/(?:let|const)\s+([A-Za-z_$][\w$]*(?:close|dirty|unsaved)[\w$]*(?:dialog|prompt|gate|inFlight|promise)[\w$]*)\s*=\s*(?:null|false)\b/i)
      || src.match(/(?:let|const)\s+([A-Za-z_$][\w$]*(?:dialog|prompt|gate)[\w$]*(?:close|dirty|unsaved)[\w$]*)\s*=\s*(?:null|false)\b/i);
    if (!flag) return false;
    const name = flag[1].replace(/[$]/g, "\\$");
    const guard = new RegExp("if\\s*\\(\\s*" + name + "\\s*\\)\\s*(?:\\{\\s*)?(?:return|throw)").test(src);
    const open = new RegExp(name + "\\s*=\\s*(?:true|new Promise|[A-Za-z_$][\\w$]*\\s*\\()").test(src);
    const close = new RegExp(name + "\\s*=\\s*(?:false|null)").test(src);
    return guard && open && close;
  });

  check("[T-B2-7] 삭제 메뉴는 영향 dirty 탭 이름을 나열하는 3버튼 preflight를 거침", () => {
    const src = contextMenu + "\n" + tabClose;
    const from = src.indexOf("function openFileCtx(");
    const to = src.indexOf("function showCtx(", from);
    const handler = from >= 0 && to > from ? src.slice(from, to) : "";
    const collects = /Object\.keys\(\s*tabsBySpace\s*\)|(?:collect|affected|tabsUnder)[A-Za-z_$]*\s*\(/i.test(handler);
    const preflight = /isTabDirty\s*\(|(?:dirty|unsaved)[A-Za-z_$]*(?:dialog|prompt|preflight)[A-Za-z_$]*\s*\(/i.test(handler);
    const names = /\.map\s*\([\s\S]{0,250}?\.(?:label|name)[\s\S]{0,180}?\.join\s*\(/.test(src);
    const buttons = /저장/.test(src) && /저장 안 함/.test(src) && /취소/.test(src);
    const trash = handler.indexOf("trashItem(");
    return /삭제\(휴지통\)/.test(handler) && collects && preflight && names && buttons && trash >= 0;
  });

  check("[T-B2-8] trash 실패 분기는 removeTabsNow 전에 반환해 탭을 보존함", () => {
    const src = contextMenu;
    const from = src.indexOf("function openFileCtx(");
    const to = src.indexOf("function showCtx(", from);
    const handler = from >= 0 && to > from ? src.slice(from, to) : "";
    const trash = handler.indexOf("trashItem(");
    const remove = handler.indexOf("removeTabsNow(", trash);
    const between = trash >= 0 && remove > trash ? handler.slice(trash, remove) : "";
    const failure = between.match(/if\s*\([^)]*(?:!\s*res(?:ult)?(?:\?\.|\.)?ok|res(?:ult)?(?:\?\.|\.)ok\s*===?\s*false|res(?:ult)?(?:\?\.|\.)error)[^)]*\)\s*\{?([\s\S]{0,700}?)\breturn\b/i);
    return trash >= 0 && remove > trash && !!failure && !/removeTabsNow\s*\(/.test(failure[1]);
  });

  check("[T-B2-9] retargetFileTabs는 old Monaco model을 dispose하고 새 URI model을 생성함", () => {
    const src = tabClose;
    const from = src.indexOf("function retargetFileTabs(");
    const to = src.indexOf("\nfunction ", from + 20);
    const body = from >= 0 ? src.slice(from, to > from ? to : from + 7000) : "";
    const oldModel = body.match(/(?:const|let)\s+([A-Za-z_$][\w$]*(?:model|oldModel)[\w$]*)\s*=\s*monacoModels\.get\(\s*([A-Za-z_$][\w$]*)\s*\)/i);
    if (!oldModel) return false;
    const model = oldModel[1], oldKey = oldModel[2];
    const captured = new RegExp("\\b" + model + "\\.getValue\\s*\\(").test(body);
    const disposed = new RegExp("\\b" + model + "\\.dispose\\s*\\(").test(body);
    const deleted = new RegExp("monacoModels\\.delete\\(\\s*" + oldKey + "\\s*\\)").test(body);
    const created = /monaco\.editor\.createModel\s*\([\s\S]{0,500}?monaco\.Uri\.file\s*\(\s*(?:np|newPath)\s*\)/.test(body);
    const viewAt = body.indexOf("monacoViewState.get(");
    const viewMove = viewAt >= 0 ? body.slice(viewAt, viewAt + 900) : "";
    const movedView = /monacoViewState\.set\s*\(/.test(viewMove) && /monacoViewState\.delete\s*\(/.test(viewMove);
    const reused = new RegExp("monacoModels\\.set\\([^,]+,\\s*" + model + "\\s*\\)").test(body);
    return captured && disposed && deleted && created && movedView && !reused;
  });

  check("[T-B2-10] renderTabs는 isTabDirty로 표 탭에도 미저장 동그라미를 그림", () => {
    const src = centerTabs;
    const from = src.indexOf("function renderTabs(");
    const to = src.indexOf("\nfunction ", from + 20);
    const body = from >= 0 ? src.slice(from, to > from ? to : from + 3500) : "";
    return /(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*isTabDirty\s*\(\s*t\s*\)/.test(body)
      && /class=["']cdirty["']/.test(body)
      && !/(?:const|let)\s+d\s*=\s*t\.draft\s*!=\s*null\s*&&\s*t\.draft\s*!==\s*t\.content/.test(body);
  });

  check("[T-B2-11] 탭 저장 in-flight 재요청은 같은 promise를 반환함", () => {
    const src = docxEditor;
    const functions = [...src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*(?:save|Save)[\w$]*)\s*\(\s*t\b/g)];
    return functions.some((m) => {
      const body = src.slice(m.index, m.index + 7000);
      const guard = body.match(/if\s*\(\s*t\.([A-Za-z_$][\w$]*(?:saving|inFlight|savePromise)[\w$]*)\s*\)\s*(?:\{\s*)?return\s+t\.\1\b/i);
      if (!guard) return false;
      const prop = guard[1].replace(/[$]/g, "\\$");
      const assign = new RegExp("t\\." + prop + "\\s*=\\s*(?:sendTabIo\\s*\\(|[A-Za-z_$][\\w$]*\\s*\\([^;]*\\)|new Promise\\s*\\(|[A-Za-z_$][\\w$]*\\s*;)").test(body)
        && /sendTabIo\s*\(|new Promise\s*\(/.test(body);
      const cleanup = new RegExp("(?:finally[\\s\\S]{0,500}?t\\." + prop + "\\s*=\\s*null|t\\." + prop + "\\s*=\\s*null[\\s\\S]{0,500}?finally)").test(body);
      return assign && cleanup;
    });
  });

  check("[T-B2-12] 외부 변경은 isTabDirty guard 뒤 같은 path의 모든 스페이스 탭에 fan-out됨", () => {
    const applyAt = centerTabs.indexOf("function applyExternalChange(");
    const applyTo = centerTabs.indexOf("function applySheetResponseData", applyAt + 20);
    const apply = applyAt >= 0 ? centerTabs.slice(applyAt, applyTo > applyAt ? applyTo : applyAt + 3000) : "";
    const response = fnBody(mainJs, "handleFileMessage");
    const fanout = /for\s*\(\s*const\s+sp\s+of\s+getTabSpaces\(\)\s*\)[\s\S]{0,1200}?getTabs\(sp\)[\s\S]{0,700}?applyExternalChange\s*\(/.test(response);
    return /(?:\bdirty\s*=\s*|if\s*\(\s*!?\s*)isTabDirty\s*\(\s*t\s*\)/.test(apply) && fanout;
  });

  check("[EC-B2-1] closeTabs는 snapshot 탭 identity를 재검증해 소실·ABA·중복 대상을 건너뜀", () => {
    const src = tabClose;
    const closeAt = src.search(/(?:async\s+)?function\s+closeTabs\s*\(/);
    const closeTo = closeAt >= 0 ? src.indexOf("\nfunction ", closeAt + 20) : -1;
    const close = closeAt >= 0 ? src.slice(closeAt, closeTo > closeAt ? closeTo : closeAt + 12000) : "";
    const removeAt = src.search(/function\s+removeTabsNow\s*\(/);
    const removeTo = removeAt >= 0 ? src.indexOf("\nfunction ", removeAt + 20) : -1;
    const remove = removeAt >= 0 ? src.slice(removeAt, removeTo > removeAt ? removeTo : removeAt + 8000) : "";
    const capturesInstance = /(?:tab|instance|ref)\s*:\s*(?:[A-Za-z_$][\w$]*|tabsBySpace\[[^\]]+\][\s\S]{0,160}?\.find\s*\()/.test(close);
    const identityGuard = /(?:current|live|resolved|found|tab)\s*===?\s*(?:target|snapshot|snap|item)\.(?:tab|instance|ref)|(?:target|snapshot|snap|item)\.(?:tab|instance|ref)\s*===?\s*(?:current|live|resolved|found|tab)/.test(src);
    const rechecksAfterWait = /\bawait\b[\s\S]{0,7000}?(?:resolve|live|valid|current)[A-Za-z_$]*Close[A-Za-z_$]*\s*\(|\bawait\b[\s\S]{0,7000}?(?:current|live|resolved|found|tab)\s*===?\s*(?:target|snapshot|snap|item)\.(?:tab|instance|ref)/i.test(close);
    const missingSafe = /if\s*\(\s*!\s*(?:current|live|resolved|found|tab)\s*\)\s*(?:\{\s*)?(?:continue|return)\b/.test(remove);
    const dedupes = /new\s+Set\s*\(/.test(remove) && /\.has\s*\(|\.add\s*\(/.test(remove);
    return capturesInstance && identityGuard && rechecksAfterWait && missingSafe && dedupes;
  });

  check("[EC-B2-2] 삭제 preflight는 대기 후 파일 identity를 재검증하고 변경·소실 시 중단함", () => {
    const src = contextMenu;
    const from = src.indexOf("function openFileCtx(");
    const to = src.indexOf("function showCtx(", from);
    const handler = from >= 0 && to > from ? src.slice(from, to) : "";
    const calls = [...handler.matchAll(/await\s+([A-Za-z_$][\w$]*(?:identity|fingerprint|version|stat)[\w$]*)\s*\(\s*absPath\s*\)/gi)];
    if (calls.length < 2 || calls[0][1] !== calls[1][1]) return false;
    const first = calls[0].index, second = calls[1].index;
    const wait = handler.slice(first, second);
    const after = handler.slice(second);
    const waitedForChoice = /await[\s\S]{0,2500}?(?:prompt|dialog|preflight|unsaved|choice|confirm)/i.test(wait);
    const trash = after.indexOf("trashItem(");
    const beforeTrash = trash >= 0 ? after.slice(0, trash) : "";
    const abortsChanged = /if\s*\([^)]*(?:identity|fingerprint|version|stat|changed|missing)[^)]*\)\s*\{?[\s\S]{0,500}?(?:showToast|alert)\s*\([\s\S]{0,300}?\breturn\b/i.test(beforeTrash);
    const all = src + "\n" + read("native/electron/preload.cjs") + "\n" + read("native/electron/main.cjs") + "\n" + readAll("server");
    const strongIdentity = /\b(?:ino|inode|etag|revision)\b/.test(all)
      && /\b(?:mtimeMs|ctimeMs|mtime|version)\b/.test(all)
      && /\b(?:size|length)\b/.test(all);
    return waitedForChoice && trash >= 0 && abortsChanged && strongIdentity;
  });

  check("[EC-B2-3] rename은 in-flight 저장 promise와 UI 소유권을 새 경로로 이관함", () => {
    const src = tabClose;
    const from = src.indexOf("function retargetFileTabs(");
    const to = src.indexOf("\nfunction ", from + 20);
    const body = from >= 0 ? src.slice(from, to > from ? to : from + 9000) : "";
    const registryMigration = /for\s*\([^)]*tabIoRegistry[^)]*\)/.test(body)
      && /(?:entry|pending|io)\.path\s*=\s*(?:np|newPath)/.test(body)
      && /(?:entry|pending|io)\.(?:tabId|owner)\s*=/.test(body);
    const preservesTabObject = /t\.path\s*=\s*(?:np|newPath)/.test(body)
      && !/tabsBySpace\[[^\]]+\]\[[^\]]+\]\s*=\s*\{/.test(body)
      && !/t\._(?:svSaving|saving)\s*=\s*(?:null|false)/.test(body);
    const saveSources = web + "\n" + src + "\n" + sheetEdit;
    const saveFns = [...saveSources.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*(?:save|Save)[\w$]*)\s*\(\s*t\b/g)];
    const requestOwnedCompletion = saveFns.some((m) => {
      const fn = saveSources.slice(m.index, m.index + 9000);
      return /t\._(?:svSaving|saving)\s*=\s*\{?[\s\S]{0,500}?(?:promise|pending|requestId)/.test(fn)
        && /(?:await\s+|\.then\s*\()\s*(?:pending|promise|t\._(?:svSaving|saving)(?:\.promise)?)/.test(fn)
        && /requestId/.test(fn);
    });
    return registryMigration && preservesTabObject && requestOwnedCompletion;
  });

  check("[EC-B2-4] 삭제 영향 탭 수집은 lexical 정규화와 symlink canonical identity를 함께 사용함", () => {
    const preload = read("native/electron/preload.cjs"), mainSrc = fsIpcSource;
    const src = contextMenu;
    const bridge = preload.match(/([A-Za-z_$][\w$]*(?:path|file)[\w$]*(?:info|identity|canonical)[\w$]*)\s*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*["']([^"']+)["']/i);
    if (!bridge) return false;
    const channel = bridge[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nativeIdentity = new RegExp("ipcMain\\.handle\\(\\s*[\"']" + channel).test(mainSrc)
      && /(?:realpathSync|realpath)\s*\(/.test(mainSrc)
      && /lstatSync|\.lstat\s*\(/.test(mainSrc);
    const deleteAt = src.indexOf("function openFileCtx(");
    const deleteTo = src.indexOf("function showCtx(", deleteAt);
    const handler = deleteAt >= 0 && deleteTo > deleteAt ? src.slice(deleteAt, deleteTo) : "";
    const usesBridge = new RegExp("acHost(?:\\?\\.)?" + bridge[1] + "\\s*\\(").test(handler);
    const normalized = /(?:normalize|normalized|lexical|resolved)[A-Za-z_$]*Path|path[A-Za-z_$]*Identity/i.test(handler);
    const canonicalBoundary = /(?:real|canonical)[A-Za-z_$]*Path[\s\S]{0,900}?(?:===?|startsWith)\s*\(/i.test(handler)
      || /(?:is|path)[A-Za-z_$]*(?:under|within|descendant)[A-Za-z_$]*\s*\([^)]*(?:real|canonical)/i.test(handler);
    return nativeIdentity && usesBridge && normalized && canonicalBoundary;
  });

  // EC-B2-5(같은 파일의 서로 다른 dirty 복제본 충돌 감지 UI)는 여기에 넣지 않는다. 협업 편집과
  // 버전 충돌 UI를 새로 정의하지 않기로 한 설계 확정 경계에 어긋나기 때문이다
  // (design/design.md "닫힌 위험과 남은 한계": 마지막에 도착해 성공한 write가 디스크 정본이고, 의미
  // 충돌은 기존 외부 변경 배너의 범위다).

  check("[EC-B2-6] 삭제 preflight는 대기 후 영향 탭 집합을 재수집해 새 dirty 탭을 보호함", () => {
    const src = contextMenu;
    const from = src.indexOf("function openFileCtx(");
    const to = src.indexOf("function showCtx(", from);
    const handler = from >= 0 && to > from ? src.slice(from, to) : "";
    const calls = [...handler.matchAll(/([A-Za-z_$][\w$]*(?:collect|affected|tabsUnder)[\w$]*)\s*\(\s*absPath\s*\)/gi)];
    if (calls.length < 2 || calls[0][1] !== calls[1][1]) return false;
    const between = handler.slice(calls[0].index, calls[1].index);
    const after = handler.slice(calls[1].index);
    const waitsForChoice = /await[\s\S]{0,3000}?(?:prompt|dialog|preflight|unsaved|choice|confirm)/i.test(between);
    const trash = after.indexOf("trashItem(");
    const beforeTrash = trash >= 0 ? after.slice(0, trash) : "";
    const checksFreshDirty = /isTabDirty\s*\(/.test(beforeTrash);
    const detectsSetChange = /(?:new|added|changed|same|equal|snapshot|tabId|instance)/i.test(beforeTrash)
      && /(?:showToast|alert|continue|return|prompt|dialog|preflight)/i.test(beforeTrash);
    return waitsForChoice && trash >= 0 && checksFreshDirty && detectsSetChange;
  });

  // ── Block 3 RED: 대상 탭 하나의 수정 사항 모두 취소 ──────────────────────
  console.log("\n[Block 3 RED] 대상 탭 하나의 수정 사항 모두 취소");
  function b3FunctionSlices(src) {
    const starts = [...src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)];
    return starts.map((match, index) => ({
      name: match[1],
      args: match[2],
      body: src.slice(match.index, starts[index + 1] ? starts[index + 1].index : src.length),
    }));
  }
  function b3Assert(value, message) { if (!value) throw new Error(message); }
  function b3Parts(src) {
    const functions = b3FunctionSlices(src);
    const flows = functions.filter((fn) => /reason\s*:\s*["']discard["']/.test(fn.body));
    const commits = functions.filter((fn) => {
      // 뷰어를 분리해 표 편집기 닫기를 훅 이름으로 호출한다. 앱 셸은 sheet 모듈을 참조하지 않는다.
      const closesEditor = /callHook\(\s*"viewer\.closeEdit"\s*,\s*[A-Za-z_$][\w$]*\s*,\s*false\s*\)/.test(fn.body);
      const resetsText = /\.content\s*=/.test(fn.body) && /\.draft\s*=\s*null\b/.test(fn.body);
      const resetsSheet = /\._svDirty\s*=\s*new\s+Map\s*\(\s*\)|\._svDirty\.clear\s*\(\s*\)/.test(fn.body)
        && /\._svLayout\s*=\s*\{\s*\}/.test(fn.body)
        && /\._svMergeEdit\s*=\s*new\s+Map\s*\(\s*\)|\._svMergeEdit\.clear\s*\(\s*\)/.test(fn.body);
      return closesEditor && (resetsText || resetsSheet);
    });
    return { functions, flows, commits };
  }

  check("[T-B3-1] 탭 메뉴의 모두 취소는 hasDiskSnapshot으로 활성화됨", () => {
    const src = tabClose;
    const from = src.indexOf('tabstrip.addEventListener("contextmenu"');
    const to = src.indexOf('tabstrip.addEventListener("dblclick"', from);
    const menu = from >= 0 && to > from ? src.slice(from, to) : "";
    b3Assert(/label\s*:\s*["']수정 사항 모두 취소["']/.test(menu), "모두 취소 메뉴 항목이 없음");
    b3Assert(/disabled\s*:\s*!\s*(?:t|tab|tabRef)\.hasDiskSnapshot\b/.test(menu), "disabled가 hasDiskSnapshot 기준이 아님");
    return true;
  });

  check("[T-B3-2] 텍스트 모두 취소는 fs.read 성공값과 빈 undo 상태를 적용함", () => {
    const src = tabClose, parts = b3Parts(src);
    const flow = parts.flows.find((fn) => /type\s*:\s*["']fs\.read["']/.test(fn.body));
    b3Assert(flow, "reason=discard인 fs.read 흐름이 없음");
    const commit = parts.commits.find((fn) => /\.content\s*=/.test(fn.body) && /\.draft\s*=\s*null\b/.test(fn.body));
    b3Assert(commit, "성공 commit의 content 교체·draft=null이 없음");
    // undo 를 비우는 일은 편집기가 소유한다. 같은 경로를 두 스페이스에서 열면 모델이 하나여서,
    // 여기서 직접 setValue 하면 그 변경 알림이 다른 활성 탭에 draft 를 기록한다.
    // 그래서 여기서는 그 함수를 호출하는지만 검사하고, 그 함수의 실제 동작은 편집기 쪽에서 검사한다.
    const editor = read("web/js/center/text-editor.js");
    const resetsUndo = (/monacoModels\.get\s*\(/.test(commit.body)
      && (/\.setValue\s*\(/.test(commit.body)
        || (/\.dispose\s*\(/.test(commit.body) && /monaco\.editor\.createModel\s*\(/.test(commit.body))))
      || (/resetModelTextExternally\s*\(/.test(commit.body)
        && /export function resetModelTextExternally/.test(editor)
        && /monacoModels\.get\(path\)/.test(editor)
        && /withoutDraft\(\(\) => model\.setValue\(text\)\)/.test(editor));
    b3Assert(resetsUndo, "Monaco model을 디스크 값으로 재설정해 undo를 비우는 패턴이 없음");
    return true;
  });

  check("[T-B3-3] 표 모두 취소는 sheet.read 값 적용 후 표 dirty 상태를 전부 비움", () => {
    const src = tabClose, parts = b3Parts(src);
    // 되돌릴 때 무엇을 다시 읽을지는 뷰어 종류가 정한다. 흐름이 그 종류를 호출하는지와
    // 그 종류가 실제로 sheet.read 를 반환하는지를 함께 검사한다.
    b3Assert(parts.flows.some((fn) => /kind\.read\(path\)/.test(fn.body) && /discardReads\(path\)/.test(fn.body))
      && /read: \(path\) => \(\{ type: "sheet\.read", path \}\)/.test(viewerKinds), "reason=discard인 sheet.read 흐름이 없음");
    // 필드를 비우는 것도 그 필드를 만드는 시트가 담당하고 앱 셸은 호출만 한다. 둘을 함께 검사한다.
    const commit = parts.commits.find((fn) => /callHook\(\s*"viewer\.resetAfterDiscard"/.test(fn.body));
    b3Assert(commit, "틀의 commit 이 뷰어에게 비우라고 하지 않음");
    b3Assert(!/_sv|sheetError/.test(commit.body), "틀의 commit 이 아직 표의 칸 이름을 안다");
    const reset = b4Function(sheetTabState, "svResetAfterDiscard");
    b3Assert(/\.sheet\s*=/.test(reset), "새 sheet 데이터를 적용하는 자리가 없음");
    // 네 개만 적어 두면 나머지를 지워도 검사가 통과한다. 그래서 목록을
    // 직접 나열하지 않는다. 시트가 탭에 쓰는 필드를 전부 수집해, 되돌릴 때 비우는 것과 의도적으로
    // 남기는 것으로 나눈다. 어느 쪽에도 없는 필드가 생기면 실패시키고 결정을 요구한다.
    // 남기는 쪽은 보기 상태다(스크롤·선택·확대·필터). 되돌리기는 내용을 되돌리는 것이지
    // 보고 있던 위치를 옮기는 것이 아니다. _svEd·_svFxEd 는 열린 편집기라 closeEdit 과
    // tearDownTab 이 정리한다. 여기서 또 비우면 그 두 곳의 동작을 검사할 수 없다.
    const KEEP = new Set(["_svEd", "_svFxEd", "_svBrush", "_svFilter", "_svGeneration", "_svHideMenu",
      "_svRO", "_svRT", "_svRanges", "_svRtl", "_svScroll", "_svSel", "_svShowFormulas",
      "_svTabClickAt", "_svTabClickIdx", "_svZoom"]);
    const written = new Set();
    for (const chunk of [sheetEdit, sheetActions, sheetEvents, sheetRender, sheetTabState, sheetModel]) {
      const bare = chunk.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of bare.matchAll(/\b(?:t|tab)\.(_sv[A-Za-z]+|sheetError)\s*=[^=]/g)) written.add(m[1]);
    }
    b3Assert(written.size >= 20, `시트가 쓰는 칸을 ${written.size} 개만 셌다 — 거르개가 말뭉치를 먹었다`);
    const missed = [...written].filter((f) => !KEEP.has(f) && !new RegExp(`\\bt\\.${f}\\s*=`).test(reset));
    b3Assert(!missed.length, `되돌릴 때 안 비우는 칸: ${missed.join(", ")} — 비우든지 KEEP 에 적고 왜인지 밝혀라`);
    return true;
  });

  check("[T-B3-4] 모두 취소 commit은 인자로 받은 대상 탭 하나만 갱신함", () => {
    const src = tabClose, parts = b3Parts(src);
    const commit = parts.commits.find((fn) => /^\s*(?:t|tab|tabRef)\b/.test(fn.args));
    b3Assert(commit, "단일 대상 탭 인자로 시작하는 discard commit이 없음");
    const traversesOtherTabs = /Object\.keys\(\s*tabsBySpace\s*\)|for\s*\([^)]*\btabsBySpace\b|curTabs\s*\(\s*\)\s*\.(?:forEach|map|filter)/.test(commit.body);
    b3Assert(!traversesOtherTabs, "commit이 tabsBySpace/curTabs를 순회해 다른 탭에 닿음");
    return true;
  });

  check("[T-B3-5] 모두 취소 read 실패는 상태 초기화 전에 조기 반환함", () => {
    const src = tabClose, parts = b3Parts(src);
    const guarded = parts.flows.some((fn) => {
      const awaited = fn.body.search(/\bawait\b/);
      const failure = fn.body.slice(Math.max(0, awaited)).search(/if\s*\([^)]*\.error\b[^)]*\)/);
      if (awaited < 0 || failure < 0) return false;
      const failureAt = awaited + failure;
      const branch = fn.body.slice(failureAt, failureAt + 700);
      const mutationBeforeGuard = fn.body.slice(awaited, failureAt).search(/svCloseEdit\s*\(|\.(?:draft|content|sheet|_svDirty|_svLayout|_svMergeEdit|_svEd)\s*=/);
      return /\breturn\b/.test(branch) && mutationBeforeGuard < 0;
    });
    b3Assert(guarded, "read error 분기가 상태 변경 전 return하지 않음");
    return true;
  });

  check("[T-B3-6] CSV/TSV 모두 취소는 fs.read와 sheet.read를 all-or-nothing으로 처리함", () => {
    const src = tabClose, parts = b3Parts(src);
    const flow = parts.flows.find((fn) => {
      const body = fn.body;
      // 텍스트와 데이터를 둘 다 읽어야 하는지는 뷰어 종류가 정한다(discardReads). 앱 셸은 그에 따라
      // 두 요청을 함께 보내고, 하나라도 실패하면 전체를 폐기한다.
      const dual = /discardReads\(path\)/.test(body)
        && /type\s*:\s*["']fs\.read["']/.test(body)
        && /kind\.read\(path\)/.test(body)
        && /text: SHEET_TEXT_RE\.test\(path\), data: true/.test(viewerKinds);
      const stagedTogether = /(?:Promise\.all|Promise\.allSettled)\s*\(/.test(body);
      const rejectsPartial = /(?:some|find)\s*\([^)]*\.error\b|\bif\s*\([^)]*(?:text|file|sheet|response|result)[^)]*\.error\b[^)]*\)/i.test(body);
      return dual && stagedTogether && rejectsPartial;
    });
    b3Assert(flow, "CSV/TSV dual read의 동시 staging·부분 실패 폐기 패턴이 없음");
    return true;
  });

  check("[T-B3-7] 모두 취소 read는 sendTabIo와 탭 identity 재검증으로 stale 응답을 거름", () => {
    const src = tabClose, parts = b3Parts(src);
    const flow = parts.flows.find((fn) => {
      const body = fn.body, awaited = body.search(/\bawait\b/);
      if (awaited < 0 || !/sendTabIo\s*\(/.test(body)) return false;
      const before = body.slice(0, awaited), after = body.slice(awaited);
      const capturesIdentity = /\b(?:space|sp)\b/.test(before) && /\btabId\b/.test(before)
        && /\bpath\b/.test(before) && /\btabRef\b|\btargetTab\b|\btarget\s*=\s*(?:t|tab)\b/.test(before);
      const rechecksIdentity = /getTabs\s*\(/.test(after) && /(?:find|some|includes)\s*\(/.test(after)
        && /===?\s*(?:tabRef|targetTab|target|t|tab)\b/.test(after) && /\.path\s*===?/.test(after);
      return capturesIdentity && rechecksIdentity;
    });
    b3Assert(flow, "sendTabIo 뒤 tab 참조·path identity 재검증이 없음");
    return true;
  });

  check("[T-B3-8] 모두 취소 commit은 file view와 탭을 각각 정확히 한 번 렌더함", () => {
    const src = tabClose, parts = b3Parts(src);
    const commit = parts.commits.find((fn) => {
      const fileRenders = fn.body.match(/\b(?:renderFileView|withFileViewTransition)\s*\(/g) || [];
      const tabRenders = fn.body.match(/\brenderTabs\s*\(\s*\)/g) || [];
      return fileRenders.length === 1 && tabRenders.length === 1;
    });
    b3Assert(commit, "commit의 file view/renderTabs 호출 횟수가 각각 1회가 아님");
    return true;
  });

  check("[EC-B3-1] 모두 취소 read 중 시작된 저장은 오래된 discard commit을 무효화함", () => {
    const src = tabClose, parts = b3Parts(src);
    const fingerprint = parts.functions.find((fn) => /discard/i.test(fn.name)
      && /(?:fingerprint|revision|stamp|state|version)/i.test(fn.name)
      && /\b(?:_saving|_svSaving|_saveInFlight)\b/.test(fn.body));
    b3Assert(fingerprint, "save in-flight 상태를 포함하는 discard fingerprint helper가 없음");
    const flow = parts.flows.find((fn) => {
      const escaped = fingerprint.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const calls = [...fn.body.matchAll(new RegExp("\\b" + escaped + "\\s*\\(", "g"))];
      if (calls.length < 2) return false;
      const awaited = fn.body.search(/\bawait\b/);
      if (awaited < 0 || calls[0].index > awaited || calls[1].index < awaited) return false;
      const recheck = fn.body.slice(calls[1].index, calls[1].index + 700);
      return /(?:!==?|===?)|(?:same|equal|match)/i.test(recheck) && /\breturn\b/.test(recheck);
    });
    b3Assert(flow, "discard가 await 전후 save 상태 fingerprint 변화 시 commit 전에 중단하지 않음");
    return true;
  });

  check("[EC-B3-2] 비활성 대상의 모두 취소 commit은 현재 file view 소유권을 바꾸지 않음", () => {
    const src = tabClose, parts = b3Parts(src);
    const commit = parts.commits.find((fn) => /\brenderFileView\s*\(/.test(fn.body));
    b3Assert(commit, "file view 갱신을 가진 discard commit이 없음");
    const renderAt = commit.body.search(/\brenderFileView\s*\(/);
    const beforeRender = commit.body.slice(0, renderAt);
    const activeIdentity = /\bcenterSpace\b/.test(beforeRender)
      && /getActiveTabId\s*\(/.test(beforeRender)
      && /getTabs\s*\(/.test(beforeRender)
      && /(?:find|some)\s*\(/.test(beforeRender)
      && /===?\s*(?:t|tab|tabRef|target|targetTab)\b/.test(beforeRender);
    const guardedRender = /if\s*\([\s\S]{0,900}\)\s*(?:\{\s*)?[\s\S]{0,350}\brenderFileView\s*\(/.test(beforeRender.slice(-1400) + commit.body.slice(renderAt, renderAt + 80));
    b3Assert(activeIdentity && guardedRender, "대상이 현재 center의 live active 탭일 때만 renderFileView하는 identity gate가 없음");
    return true;
  });

  check("[EC-B3-3] 모두 취소 read 대기 중 새 편집·모드 전환은 commit을 stale로 만듦", () => {
    const src = tabClose, parts = b3Parts(src);
    // fingerprint 는 둘로 나뉜다. 앱 셸은 자기 몫(draft·저장 중)만 담고 뷰어 몫은 뷰어에게
    // 묻는다. 담기는 내용이 빠지면 안 되므로 양쪽을 함께 검사한다.
    const snapshot = b4Function(sheetTabState, "svDiscardSnapshot");
    b3Assert(/\._svEd\b/.test(snapshot) && /\._svDirty\b/.test(snapshot)
      && /\._svLayout\b/.test(snapshot) && /\._svMergeEdit\b/.test(snapshot)
      && /\.sheetMode\b/.test(snapshot), "표 스냅숏이 편집·배치·병합·모드를 함께 담지 않음");
    const fingerprint = parts.functions.find((fn) => /discard/i.test(fn.name)
      && /(?:fingerprint|revision|stamp|state|version)/i.test(fn.name)
      && /\.draft\b/.test(fn.body)
      && /callHook\(\s*"viewer\.discardSnapshot"/.test(fn.body));
    b3Assert(fingerprint, "text 상태와 뷰어 스냅숏을 함께 캡처하는 discard fingerprint helper가 없음");
    const flow = parts.flows.find((fn) => {
      const escaped = fingerprint.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const calls = [...fn.body.matchAll(new RegExp("\\b" + escaped + "\\s*\\(", "g"))];
      if (calls.length < 2) return false;
      const awaited = fn.body.search(/\bawait\b/);
      if (awaited < 0 || calls[0].index > awaited || calls[1].index < awaited) return false;
      const recheck = fn.body.slice(calls[1].index, calls[1].index + 700);
      return /(?:!==?|===?)|(?:same|equal|match)/i.test(recheck) && /\breturn\b/.test(recheck);
    });
    b3Assert(flow, "discard가 await 뒤 새 편집·sheetMode 변화를 재검증해 commit 전에 중단하지 않음");
    // 스냅숏만 만들고 비교가 그중 일부만 확인하면, 비교하지 않는 필드가 달라져도 stale 로 판정되지 않는다
    // (비교를 return true 로 바꿔도 검사가 통과했다).
    // 목록을 직접 나열하지 않는다. 스냅숏이 실제로 만드는 필드를 수집해 비교가 그 이름을 모두 쓰는지 검사한다.
    const same = b4Function(sheetTabState, "svSameDiscardSnapshot");
    const keys = [...snapshot.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((m) => m[1]);
    b3Assert(keys.length >= 8, `스냅숏 칸을 ${keys.length} 개만 셌다 — 뽑기가 말뭉치를 먹었다`);
    const unseen = keys.filter((k) => !new RegExp(`\\b(?:a|b)\\.${k}\\b`).test(same));
    b3Assert(!unseen.length, `비교가 안 보는 스냅숏 칸: ${unseen.join(", ")}`);
    b3Assert(/callHook\(\s*"viewer\.sameDiscardSnapshot"/.test(src), "틀이 스냅숏 비교를 뷰어에 묻지 않음");
    return true;
  });

  // ── Block 4 RED: 표 셀 pick + 서버 gate ────────────────────────────────────
  console.log("\n[Block 4 RED] 표 셀 pick + 서버 gate");
  check("[T-B4-1] 브라우저 탭 0개여도 로드된 표 context면 pick mode를 켬", () => {
    const srv = read("server/browser-message-handlers.js");
    const toggle = b4Function(pick, "togglePickMode");
    const send = b4Function(mainJs, "wsSend");
    const context = b4Function(pick, "hasSheetContext");
    const pickAt = srv.indexOf('msg.type === "pick-mode"');
    const serverPick = pickAt >= 0 ? srv.slice(pickAt, pickAt + 900) : "";
    b3Assert(/type\s*:\s*["']pick-mode["'][\s\S]*?op\s*:\s*["']toggle["']/.test(toggle), "toggle이 기존 pick-mode 요청 경로를 쓰지 않음");
    // 요소 지목이 별도 기능으로 분리되어, 계산은 그 기능이 하고 앱 셸은 호출만 한다.
    b3Assert(/o\.type\s*===\s*["']pick-mode["'][\s\S]*?o\.op\s*===\s*["']toggle["'][\s\S]*?hasSheetContext\s*:\s*!!callHook\("pick\.sheetContext"\)/.test(send), "toggle 요청에 hasSheetContext 계산값이 없음");
    // 격자 선택자는 표가 소유하고 지목 쪽은 이름만 호출하므로, 양쪽을 함께 검사한다.
    const sheetRenderSrc = read("web/js/sheet/render.js");
    b3Assert(/callHook\(\s*"viewer\.activeSheetTab"\s*\)/.test(context)
      && /callHook\(\s*"viewer\.sheetGrid"\s*\)/.test(context)
      && /querySelector\("#sv-grid"\)/.test(sheetRenderSrc), "활성·로드된 sheet view 판정이 없음");
    b3Assert(/want\s*&&\s*tabCount\(\)\s*===\s*0\s*&&\s*!\s*msg\.hasSheetContext/.test(serverPick), "서버 gate가 sheet context를 허용하지 않음");
    b3Assert(/setPickModeState\s*\(\s*want\s*\)/.test(serverPick), "기존 전역 pick state 경로를 쓰지 않음");
    return true;
  });

  check("[T-B4-2] 표 셀 주소·값·경로를 noticeBlock으로 PTY 전달함", () => {
    const src = pickHost;
    const pick = b4Function(src, "pickCellAt");
    const deliver = b4Function(src, "deliverCellPick");
    const local = b4Function(src, "deliverCellPickLocal");
    const pointerAt = src.indexOf('document.addEventListener("pointerdown"');
    const pointer = pointerAt >= 0 ? src.slice(pointerAt, pointerAt + 1700) : "";
    b3Assert(/callHook\(\s*"viewer\.sheetCellAt"/.test(pick)
      && /#sv-grid td\.sv-c/.test(read("web/js/sheet/render.js")), "표 셀 selector가 없음");
    for (const field of ["r", "c", "addr", "text", "tabId", "path"])
      b3Assert(new RegExp("\\b" + field + "\\b").test(pick), `pickCellAt 반환값에 ${field}가 없음`);
    b3Assert(/deliverCellPick\s*\(/.test(pointer), "capture pointerdown 체인에 cell 전달이 없음");
    b3Assert(/deliverCellPickLocal\s*\(/.test(deliver) && !/\bdeliverPick(?:Local)?\s*\(/.test(deliver), "cell router가 전용 local 경로를 쓰지 않음");
    b3Assert(/noticeBlock(?:\.call)?\s*\(/.test(local), "cell 전달이 noticeBlock을 쓰지 않음");
    for (const field of ["r", "c", "addr", "text", "path"])
      b3Assert(new RegExp("\\b(?:pick|p)\\." + field + "\\b").test(local), `noticeBlock 내용에 ${field}가 없음`);
    b3Assert(/type\s*:\s*["']pty\.input["']/.test(local), "cell block의 PTY 전달이 없음");
    b3Assert(!/\bdeliverPick(?:Local)?\s*\(/.test(local), "cell local 전달이 webview ORCA deliverPick을 호출함");
    return true;
  });

  check("[T-B4-3] pick mode가 꺼지면 표 셀 이벤트를 삼키지 않음", () => {
    const src = pickHost, pick = b4Function(src, "pickCellAt");
    // 이벤트 차단 guard 와 pointerdown 은 같은 등록 함수 안에 있으므로 그 함수 전체를 검사한다.
    const family = b4Function(src, "wirePickPointer");
    b3Assert(/if\s*\(\s*!pickMode\s*\)\s*return\s+null/.test(pick), "pickCellAt 자체의 pick-off null guard가 없음");
    const guard = family.match(/for\s*\(const type of \[[^\]]+\]\)\s*\{[\s\S]*?document\.addEventListener\(type,[\s\S]*?\},\s*true\);/);
    b3Assert(guard && /if\s*\(\s*!pickMode\s*\|\|/.test(guard[0]), "후속 이벤트 guard가 pick-off에서 먼저 반환하지 않음");
    b3Assert(/!pickCellAt\s*\(\s*e\.target\s*\)/.test(guard[0]), "후속 이벤트 guard에 cell family 멤버가 없음");
    b3Assert(guard[0].indexOf("return;") < guard[0].indexOf("preventDefault()"), "pick-off return 전에 이벤트를 삼킬 수 있음");
    return true;
  });

  check("[T-B4-4] webview ORCA pick은 기존 deliverPick 경로를 유지함", () => {
    const ipcAt = webviewFactory.indexOf('e.channel === "orca-pick"');
    const ipc = ipcAt >= 0 ? webviewFactory.slice(ipcAt, ipcAt + 420) : "";
    const pick = b4Function(pickHost, "pickCellAt");
    const deliver = b4Function(pickHost, "deliverCellPick") + b4Function(pickHost, "deliverCellPickLocal");
    b3Assert(/callHook\(\s*"pick\.deliver",\s*pick,\s*tabId\s*\)/.test(ipc), "webview orca-pick IPC가 deliverPick을 유지하지 않음");
    b3Assert(!/deliverCellPick/.test(ipc), "webview IPC가 cell pick 경로로 섞임");
    b3Assert(/callHook\(\s*"viewer\.sheetCellAt"/.test(pick) && !/webview|orca-pick|deliverPick/.test(pick), "pickCellAt이 host 표 셀 밖 대상을 받음");
    b3Assert(!/\bdeliverPick(?:Local)?\s*\(/.test(deliver), "cell 전달이 ORCA 전달 함수를 호출함");
    return true;
  });

  check("[T-B4-5] cell pick guard 밖의 표 선택·복사·서식·채우기 동작은 보존됨", () => {
    const src = pickHost;
    const family = b4Function(src, "wirePickPointer");
    const sheetHandlers = sheetEvents;
    b3Assert(/!pickMode[\s\S]{0,500}!pickCellAt\s*\(\s*e\.target\s*\)/.test(family), "cell 삼킴이 pick mode 조건에 묶이지 않음");
    b3Assert(/fileview\.addEventListener\(["']mousedown["'][\s\S]*?svSet\s*\(/.test(sheetHandlers), "기존 셀 범위 선택 handler가 없음");
    b3Assert(/document\.addEventListener\(["']copy["']/.test(sheetHandlers) && /document\.addEventListener\(["']paste["']/.test(sheetHandlers), "기존 표 복사·붙여넣기 handler가 없음");
    b3Assert(/function svFormat\s*\(/.test(sheetEdit) && /function svFill\s*\(/.test(sheetEdit), "기존 표 서식·채우기 함수가 없음");
    b3Assert(/closest\(["']th\.sv-ch["']\)/.test(sheetHandlers) && /closest\(["']th\.sv-rh["']\)/.test(sheetHandlers), "기존 행·열 header 선택이 없음");
    return true;
  });

  // ── Block 5 RED: 파일 트리 비동기 자동 포커싱 ──────────────────────────────
  console.log("\n[Block 5 RED] 파일 트리 비동기 자동 포커싱");

  check("[T-B5-1] 같은 스페이스 파일 탭은 조상을 펼치고 대상 행을 강조·스크롤함", () => {
    const src = tree;
    const start = b4Function(src, "startPendingReveal");
    const advance = b4Function(src, "continuePendingReveal");
    b3Assert(/pendingReveal\s*=\s*\{[\s\S]*?space\s*:[\s\S]*?tabId\s*:[\s\S]*?targetPath\s*:[\s\S]*?root\s*:[\s\S]*?expectedDir\s*:[\s\S]*?token\s*:/m.test(start), "reveal 상태가 space/tab/path/root/expectedDir/token을 함께 캡처하지 않음");
    b3Assert(/collapsed\.dirs\.delete\s*\(/.test(advance), "캐시된 조상을 펼치지 않음");
    b3Assert(/classList\.add\s*\(\s*["']active["']\s*\)/.test(advance), "대상 파일 행 active 강조가 없음");
    // 세로 크기가 드래그로 바뀌는 패널이라 center 로 맞춰야 항상 가운데에 온다.
    // nearest 는 패널이 작을 때 대상 행을 위아래 가장자리에 붙인다.
    b3Assert(/scrollIntoView\s*\(\s*\{\s*block\s*:\s*["']center["']\s*\}\s*\)/.test(advance), "대상 파일 행 center 스크롤이 없음");
    return true;
  });

  check("[T-B5-2] 캐시된 조상은 requestDir 없이 동기적으로 처리함", () => {
    const advance = b4Function(tree, "continuePendingReveal");
    const cacheAt = advance.indexOf("dirCache.get(");
    const requestAt = advance.indexOf("requestDir(");
    const expandAt = advance.indexOf("collapsed.dirs.delete(");
    b3Assert(cacheAt >= 0 && requestAt > cacheAt && expandAt > cacheAt, "cache 확인→미로드 요청/캐시 조상 펼침 흐름이 없음");
    const missingBranch = advance.slice(cacheAt, expandAt);
    b3Assert(/(?:===\s*undefined|!dirCache\.has\s*\(|===\s*["']loading["'])/.test(missingBranch), "미로드·loading 조상 판정이 없음");
    b3Assert(/expectedDir\s*=/.test(missingBranch) && /requestDir\s*\(/.test(missingBranch) && /return\s*;/.test(missingBranch), "최초 미로드 조상 하나만 요청하고 대기하지 않음");
    b3Assert(!/await\b|Promise\b/.test(advance), "캐시 hit 경로가 비동기 대기를 포함함");
    return true;
  });

  check("[T-B5-3] 다른 스페이스 파일 탭은 트리 상태와 DOM을 전혀 건드리지 않음", () => {
    const show = b4Function(centerTabs, "showActiveTab");
    const start = b4Function(tree, "startPendingReveal");
    b3Assert(/startPendingReveal\s*\(\s*t\s*\)/.test(show), "showActiveTab의 file 분기가 조건부 reveal helper로 수렴하지 않음");
    b3Assert(!/activeFile\s*=|collapsed\.dirs|renderFileTree\s*\(|scrollIntoView\s*\(/.test(show), "showActiveTab이 reveal guard 밖에서 트리를 직접 변경함");
    const guard = start.match(/if\s*\([\s\S]*?\)\s*return\s*;/)?.[0] || "";
    b3Assert(/centerSpace\s*!==\s*getSelectedSpaceId\(\)/.test(guard), "center/sidebar space 불일치 guard가 없음");
    b3Assert(/kind\s*!==\s*["']file["']|kind\s*===\s*["']file["']/.test(guard) && /\.path\b/.test(guard), "활성 file tab/path guard가 없음");
    b3Assert(/getActiveTabId\s*\(\s*centerSpace\s*\)/.test(guard), "활성 tab identity guard가 없음");
    b3Assert(/spaceRootFor\s*\(/.test(start) && /isRevealPathWithinRoot\s*\(/.test(guard), "space root containment guard가 없음");
    return true;
  });

  check("[T-B5-4] fs 오류·child 소멸은 추가 트리 mutation 없이 reveal을 중단함", () => {
    const handler = b4Function(tree, "handlePendingRevealFs");
    const advance = b4Function(tree, "continuePendingReveal");
    const fsBranch = fnBody(mainJs, "handleFsMessage");
    b3Assert(/m\.path\s*!==\s*[A-Za-z_$][\w$]*\.expectedDir/.test(handler), "fs 응답 path의 exact expectedDir 판정이 없음");
    b3Assert(/m\.error[\s\S]{0,220}?pendingReveal\s*=\s*null[\s\S]{0,120}?return\s+true/.test(handler), "fs 오류가 pending만 조용히 끝내지 않음");
    b3Assert(/if\s*\(\s*!child\s*\)[\s\S]{0,160}?pendingReveal\s*=\s*null[\s\S]{0,80}?return\s*;/.test(advance), "다음 child/최종 파일 소멸 중단이 없음");
    b3Assert(/if\s*\(\s*handlePendingRevealFs\s*\(\s*m\s*\)\s*\)\s*(?:return\s*;|\{[\s\S]{0,180}?return\s*;\s*\})/.test(fsBranch), "reveal 전용 fs 응답이 기존 unconditional render 전에 소비되지 않음");
    return true;
  });

  check("[T-B5-5] stale fs 응답은 space·tab·path·root·token 재검증에서 폐기됨", () => {
    const current = b4Function(tree, "isPendingRevealCurrent");
    const handler = b4Function(tree, "handlePendingRevealFs");
    const cancel = b4Function(tree, "cancelPendingReveal");
    const show = b4Function(centerTabs, "showActiveTab");
    for (const re of [
      /\.token\s*!==\s*revealTokenSeq/,
      /getSelectedSpaceId\(\)\s*!==\s*[A-Za-z_$][\w$]*\.space/,
      /getActiveTabId\s*\([^)]*\.space\s*\)[\s\S]{0,80}\.tabId/,
      /\.path[\s\S]{0,80}\.targetPath/,
      /spaceRootFor\s*\([^)]+\.space\s*\)[\s\S]{0,160}\.root/,
    ]) b3Assert(re.test(current), `stale 재검증 누락: ${re}`);
    const recheckAt = handler.indexOf("isPendingRevealCurrent(");
    const cacheAt = handler.indexOf("dirCache.set(");
    b3Assert(recheckAt >= 0 && cacheAt > recheckAt, "stale 판정을 cache/DOM mutation보다 먼저 하지 않음");
    b3Assert(/pendingReveal\s*=\s*null[\s\S]{0,120}?return\s+true/.test(handler.slice(recheckAt, cacheAt)), "stale 응답을 조용히 폐기하지 않음");
    b3Assert(/cancelPendingReveal\s*\(\s*\)/.test(show), "탭·스페이스 전환 시 진행 중 reveal token을 무효화하지 않음");
    b3Assert(/(?:\+\+revealTokenSeq|revealTokenSeq\s*\+=\s*1)/.test(cancel) && !/pendingReveal\s*=\s*null/.test(cancel), "취소가 이전 expectedDir을 남긴 채 token만 무효화하지 않음");
    return true;
  });

  check("[T-B5-6] 실제 target DOM이 있을 때만 CSS.escape selector로 강조·스크롤함", () => {
    const advance = b4Function(tree, "continuePendingReveal");
    const renders = advance.match(/renderFileTree\s*\(/g) || [];
    const queryAt = advance.indexOf("querySelector(");
    const addAt = advance.indexOf('classList.add("active")');
    const scrollAt = advance.indexOf("scrollIntoView(");
    b3Assert(renders.length === 1, "최종 reveal renderFileTree가 정확히 한 번이 아님");
    b3Assert(/\.fitem\.file\[data-file=[\s\S]{0,100}?CSS\.escape\s*\(/.test(advance), "CSS.escape한 exact file data selector가 없음");
    b3Assert(queryAt >= 0 && addAt > queryAt && scrollAt > addAt, "조회→강조→스크롤 순서가 아님");
    const beforeAdd = advance.slice(queryAt, addAt);
    b3Assert(/if\s*\(\s*![A-Za-z_$][\w$]*\s*\)[\s\S]{0,100}?return\s*;/.test(beforeAdd), "querySelector null이면 강조 전에 끝나는 guard가 없음");
    return true;
  });

  // 훅 이름과 그 이름을 채우는 함수 사이가 검사 사각지대다. 소비 쪽 검사는
  // 앱 셸이 이 이름을 호출하는지를, 구현 쪽 검사는 그 함수의 판정 방식을 본다. 그런데 그 이름을
  // 다른 함수에 연결해도 둘 다 통과한다. provide("viewer.tabDirty", () => false) 로 바꾸면
  // 표·문서의 미저장 편집이 clean 으로 판정되는데도 검사는 통과했다.
  // 분리하기 전에는 판정이 소비 함수 안에 있어 이 틈이 없었다. 분리하면서 생긴 틈이라
  // 여기서 닫는다. 다만 이 검사가 확인하는 것은 그 이름이 그 함수를 호출한다는 것까지다. 그 함수가
  // 올바르게 판정하는지는 각 구현 검사(T-B2-1 · T-B3-3 · EC-B3-3 · COV-1)가 검사한다.
  check("[SEAM-1] 뷰어 훅 이름이 실제로 그 구현을 부른다", () => {
    const WIRED = {
      "viewer.tabDirty": ["svTabDirty", "docxTabDirty"],
      "viewer.discardSnapshot": ["svDiscardSnapshot"],
      "viewer.sameDiscardSnapshot": ["svSameDiscardSnapshot"],
      "viewer.resetAfterDiscard": ["svResetAfterDiscard"],
      "viewer.tearDownTab": ["svTearDownTab"],
      "viewer.retargetTabPath": ["svRetargetTabPath"],
      "viewer.saveTab": ["svSave", "docxSaveTab"],
      "viewer.leaveTab": ["cleanupDocxRender", "svLeaveTab", "isTabDirty"],
      "viewer.enterTab": ["svEnterTab"],
    };
    const bad = [];
    for (const [name, wants] of Object.entries(WIRED)) {
      const at = viewerBoot.indexOf(`provide("${name}"`);
      if (at < 0) { bad.push(`${name}: 채우는 자리가 없다`); continue; }
      // provide 하나의 본문만 검사한다. 파일 전체를 대상으로 하면 다른 줄의 이름 때문에 통과한다.
      let depth = 0, end = -1;
      for (let i = viewerBoot.indexOf("(", at); i < viewerBoot.length; i++) {
        if (viewerBoot[i] === "(") depth++;
        else if (viewerBoot[i] === ")") { depth--; if (!depth) { end = i; break; } }
      }
      const body = end > at ? viewerBoot.slice(at, end) : "";
      const missing = wants.filter((fn) => !new RegExp(`\\b${fn}\\s*\\(`).test(body));
      if (missing.length) bad.push(`${name}: ${missing.join(", ")} 를 안 부른다`);
      // 그 이름이 이 파일 어디서 오는지도 검사한다. import 이거나 이 파일이 만든 지역
      // 이름(initDocxPanel 이 반환하는 cleanupDocxRender 같은 것)이어야 한다. 없으면 그 provide 는
      // 정의되지 않은 함수를 호출하므로 실행 시 예외가 난다.
      for (const fn of wants) {
        const rest = viewerBoot.slice(0, at) + viewerBoot.slice(end);
        if (!new RegExp(`\\b${fn}\\b`).test(rest)) bad.push(`${name}: ${fn} 이 이 파일에 없다`);
      }
    }
    if (bad.length) throw new Error(bad.join(" · "));
    return true;
  });

  console.log("\n[Coverage fix RED] 요구사항 커버리지 실결함");

  check("[COV-1] 값이 달라진 열린 셀 editor만 dirty·commit 대상으로 봄", () => {
    const src = tabClose;
    const edit = b4Function(sheetEdit, "svEdit");
    const close = b4Function(sheetEdit, "svCloseEdit");
    const dirty = b4Function(sheetEdit, "svTabDirty");
    b3Assert(/_svEd\s*=\s*\{[\s\S]{0,240}\borig\s*:\s*ta\.value\b/.test(edit), "svEdit이 textarea 원래 값을 _svEd.orig에 저장하지 않음");
    b3Assert(/(?:validCommit\s*&&\s*(?:v|el\.value)\s*!==\s*ed\.orig|(?:v|el\.value)\s*!==\s*ed\.orig\s*&&\s*validCommit)/.test(close), "svCloseEdit이 원래 값과 달라진 경우에만 commit하지 않음");
    b3Assert(/editorDirty\s*=\s*!!\([\s\S]{0,360}?\.el\.value\s*!==\s*[\s\S]{0,80}?\.orig/.test(dirty), "isTabDirty의 열린 editor 판정이 실제 값 변경을 비교하지 않음");
    return true;
  });

  // switchSheetMode 는 center/tab-close.js 에서 sheet/mode.js 로 옮겼다. 표와 텍스트
  // 토글은 표 뷰어의 기능인데 앱 셸에 있었고, 그 함수 때문에 앱 셸이 t.sheetMode·t.sheet 와
  // "sheet.read" 를 참조했다. 검사 내용은 같고 읽는 위치와 호출하는 이름만 바뀐다.
  // 대화상자 잠금을 직접 여닫던 부분은 그 잠금을 감싼 chooseDirtyAction 하나로 통합했다.
  check("[COV-2] CSV·TSV 모드 전환은 현재 표현 dirty를 3버튼 선택으로 먼저 해소함", () => {
    const src = sheetMode;
    // 이 클릭 핸들러는 fileviewClickHandler 라는 이름 붙은 함수로 분리했다. docx 를 docxview
    // 패널로 옮기면서 fileview 와 docxview 양쪽에 같은 핸들러를 등록해야 했기 때문이다.
    // fileview 에 인라인으로 등록되지 않으므로 함수 정의 자체를 찾는다.
    const clickAt = sheetEvents.indexOf("function fileviewClickHandler(e) {");
    const clickTo = sheetEvents.indexOf("// 메뉴 바", clickAt);
    const handler = clickAt >= 0 && clickTo > clickAt ? sheetEvents.slice(clickAt, clickTo) : "";
    const flow = b4Function(src, "switchSheetMode");
    b3Assert(/act\s*===\s*["']text["'][\s\S]{0,180}?switchSheetMode\s*\(\s*t\s*,\s*false/.test(handler), "원문 전환이 공용 dirty guard로 수렴하지 않음");
    b3Assert(/act\s*===\s*["']table["'][\s\S]{0,180}?switchSheetMode\s*\(\s*t\s*,\s*true/.test(handler), "표 전환이 공용 dirty guard로 수렴하지 않음");
    b3Assert(!/act\s*===\s*["'](?:text|table)["'][\s\S]{0,100}?\.sheetMode\s*=/.test(handler), "mode click handler가 sheetMode를 즉시 선변경함");
    const dirtyAt = flow.search(/(?:source|current)[A-Za-z_$]*Dirty\s*=/i);
    const promptAt = flow.search(/await\s+chooseDirtyAction\s*\(/);
    const switchAt = flow.search(/\.sheetMode\s*=\s*(?:target|next|want)/);
    // 구간 어딘가에 판정 함수가 있으면 통과하는 방식으로는, 둘 중 하나를
    // 상수로 바꿔도 나머지 한 줄이 정규식을 만족시켜 통과한다. 지금은 두 값이
    // 각각 두 판정에서 오는지를 따로 검사하므로, 어느 쪽을 상수로 만들어도 실패한다.
    b3Assert(dirtyAt >= 0, "현재 text/table 표현별 dirty 판정이 없음");
    const dirtyBlock = flow.slice(dirtyAt, promptAt);
    for (const name of ["sourceDirty", "targetDirty"]) {
      const bound = new RegExp(name + "\\s*=\\s*([^;]+);").exec(dirtyBlock);
      b3Assert(bound && /isTextTabDirty\s*\(/.test(bound[1]) && /svTabDirty\s*\(/.test(bound[1]),
        name + " 가 글자·표 두 판정에서 오지 않음 — 한쪽을 상수로 두면 그 표현의 미저장 편집을 못 본다");
    }
    b3Assert(promptAt > dirtyAt && /await\s+chooseDirtyAction\s*\(/.test(flow.slice(promptAt)), "dirty 전환이 기존 3버튼 prompt의 응답을 기다리지 않음");
    // 잠금은 앱 셸이 소유한다. 대화상자가 이미 열려 있으면(null) 두 번째를 띄우지 않고 중단하는지 검사한다.
    b3Assert(/choice\s*===\s*null|null\s*===\s*choice/.test(flow), "대화상자가 이미 열려 있는 경우를 안 가린다");
    b3Assert(/choice\s*===\s*["']save["'][\s\S]{0,900}?(?:saveTabForClose|svSave|saveFileTab)\s*\(/.test(flow), "저장 선택이 현재 표현 저장 완료 경로로 이어지지 않음");
    b3Assert(/choice\s*===\s*["']discard["'][\s\S]{0,900}?discardTabToDisk\s*\(/.test(flow), "저장 안 함 선택이 dirty 폐기 경로로 이어지지 않음");
    b3Assert(switchAt > promptAt, "3버튼 선택 전에 sheetMode를 바꿈");
    return true;
  });
}
