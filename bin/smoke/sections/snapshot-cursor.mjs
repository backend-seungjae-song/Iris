// 소유 범위: 스냅샷의 바이트 단위 분할. 전진하는 커서, 잘린 구간의 경고·상태 보존, role·name·region 필터.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/snapshot-cursor.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdInputSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrHandlers, herdrState,
  httpHandler, main, mainJs, mcp, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[13] 스냅샷 — 노드 수가 아니라 바이트로 끊는다");
{
  const eng = read("native/electron/snapshot-engine.cjs");
  const cdp = cdpCmdInspectSource;
  const mcpS = read("bin/iris-mcp.mjs");
  check("예산 단위는 직렬화 바이트다", () =>
    /const size = Buffer\.byteLength\(line\) \+ 1;/.test(eng)
    && /if \(cursor == null && used \+ size > budget\)/.test(eng));
  check("커서는 반드시 전진한다", () => {
    // 큰 줄만 건너뛰고 뒤의 작은 줄을 계속 담으면 다음 장에 같은 줄이 다시 나온다.
    // 한 줄이 예산보다 크면 커서가 전진하지 못해 같은 자리에 머문다(확인된 반례).
    const p2 = path.join(ROOT, "native/electron/snapshot-engine.cjs");
    // ESM에서 CJS 내부 함수를 가져와 실제로 실행한다. 문자열 존재만 검사하면 이 반례를 잡지 못한다.
    const tmp = path.join(ROOT, "node_modules", ".smoke-snapshot-probe.cjs");
    writeFileSync(tmp, readFileSync(p2, "utf8").replace("module.exports = { buildSnapshot };",
      "module.exports = { buildSnapshot, selectLines };"));
    const mod = { exports: createRequire(import.meta.url)(tmp) };
    try { unlinkSync(tmp); } catch {}
    const entries = [{ ref: "", role: "text", name: "x".repeat(200), depth: 0 },
                     { ref: "", role: "heading", name: "작은 줄", depth: 0 },
                     { ref: "", role: "text", name: "또", depth: 0 }];
    const lines = entries.map((e) => `${e.role} "${e.name}"`);
    let cur = 0, seen = [], guard = 0;
    while (guard++ < 8) {
      const r = mod.exports.selectLines(entries, lines, { budget: 1, cursor: cur });
      seen.push(...lines.slice(cur, r.cursor == null ? lines.length : r.cursor));
      if (r.cursor == null) break;
      if (r.cursor <= cur) return false;
      cur = r.cursor;
    }
    return JSON.stringify(seen) === JSON.stringify(lines);
  });
  check("잘린 구간의 경고·상태·제목은 버리지 않는다", () =>
    /KEEP_ROLES = new Set\(\["alert", "alertdialog", "status", "heading", "log"\]\)/.test(eng)
    && /잘린 구간의 경고·상태·제목/.test(eng));
  check("이어 볼 커서를 준다", () =>
    /이어 보려면 cursor=\$\{cursor\}/.test(eng));
  check("ref는 자르기 전에 붙는다 — 조각마다 번호가 달라지지 않는다", () =>
    /질의·예산은 ref를 붙인 뒤에 적용한다/.test(eng));
  check("role·name·region으로 좁힐 수 있다", () =>
    /if \(want\.role \|\| want\.name\)/.test(eng) && /if \(want\.region\)/.test(eng));
  check("region은 landmark 안쪽으로 닫힌다", () =>
    /if \(inside != null && e\.depth <= inside\) inside = null;/.test(eng));
  check("명령·도구가 그 인자를 그대로 받는다", () =>
    /budget: args\.budget, cursor: args\.cursor/.test(cdp)
    && /cursor: \{ type: "number"/.test(mcpS));
}

}
