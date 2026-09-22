// 소유 범위: 서버 쓰기의 원자성. 동시 쓰기·심링크·크기·별칭 경로에서도 원본을 잃지 않는다.
// 제공 API: 이름 export runDocxBlock9Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사용자가 직접 입력한다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 를 블록별로 나눈 것이고 본문은 수정하지 않았다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/docx-atomic-write.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT } from "../core.mjs";
import { aiTabs, dock, fileRouting, httpHandler, tabClose, renderer } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5WasmInventory,
  docxConcurrentWriteProbe, docxDispatchedHandler, docxMessageBranch, docxRenderBranch,
  docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe,
} from "./90-docx-block1.mjs";

export async function runDocxBlock9Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B9-")) return;
  console.log("\n[DOCX Block 9 RED] Atomic replacement (원자적 서버 쓰기)");
  const card = (id, name, fn) => { if (!selected || selected === `B9-${id}`) check(`[DOCX-B9-${id}] ${name}`, fn); };

  const docxJs = read("server/docx.js");
  const writeDocxRaw = docxSourceFunction(docxJs, "writeDocxRaw");
  const srv = read("server/index.js");
  const docxHandlers = read("server/docx-handlers.js");
  const writeHandler = docxDispatchedHandler(srv, docxHandlers, "docx.write");

  card("T1", "임시파일을 wx(exclusive create)로 연다 — 동시 쓰기가 서로의 임시파일을 덮어쓰지 않는다", () => {
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    docxAssert(/\.open\s*\(\s*tmpPath\s*,\s*["']wx["']/.test(writeDocxRaw),
      "임시파일을 fs.open(tmpPath, 'wx')로 배타 생성하지 않음");
    return true;
  });

  card("T2", "임시파일 쓰기 후 rename 전에 fsync한다 — 크래시 시 부분 쓰기 유실을 막는다", () => {
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const openIdx = writeDocxRaw.search(/\.open\s*\(\s*tmpPath/);
    const renameIdx = writeDocxRaw.search(/\brename\s*\(\s*tmpPath\s*,\s*filePath\s*\)/);
    docxAssert(openIdx >= 0, "임시파일을 여는 코드를 찾지 못함");
    docxAssert(renameIdx > openIdx, "rename(tmpPath, filePath) 호출을 찾지 못함(또는 open보다 앞에 있음)");
    const between = writeDocxRaw.slice(openIdx, renameIdx);
    docxAssert(/\.sync\s*\(\s*\)/.test(between),
      "임시파일 쓰기와 rename 사이에 fsync(.sync()) 호출이 없음 — fsync 없이 rename만 하면 rename 자체는 즉시 반영돼도 내용이 디스크에 완전히 도달했다는 보장이 없다");
    return true;
  });

  card("T3", "rename 성공 후 디렉터리도 fsync한다 — rename이라는 디렉터리 엔트리 교체 자체의 내구성을 보장한다", () => {
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const renameIdx = writeDocxRaw.search(/\brename\s*\(\s*tmpPath\s*,\s*filePath\s*\)/);
    docxAssert(renameIdx >= 0, "rename(tmpPath, filePath) 호출을 찾지 못함");
    const afterRename = writeDocxRaw.slice(renameIdx);
    docxAssert(/\.open\s*\(\s*dir\b/.test(afterRename),
      "rename 후 디렉터리를 여는 코드가 없음 — 디렉터리 fsync를 하려면 디렉터리 fd가 필요함");
    docxAssert(/\.sync\s*\(\s*\)/.test(afterRename),
      "rename 후 디렉터리 fsync(.sync()) 호출이 없음 — 파일 rename 자체는 성공해도 그 디렉터리 엔트리 변경이 디스크에 내구적으로 반영됐다는 보장이 없다");
    return true;
  });

  card("T4", "rename 직전에 baselineRevision을 다시 확인한다 — 최초 확인 이후의 TOCTOU 창을 rename 바로 앞으로 좁힌다", () => {
    // handleDocxWrite가 enqueuePathIo 콜백 진입 시 이미 한 번 현재 디스크 해시와 baselineRevision을
    // 비교하지만(Block 7), 그 확인과 실제 rename 사이에도 시간 차(임시파일 쓰기+fsync)가 있다.
    // 그 구간에서 파일이 다시 바뀌면 최초 확인만으로는 감지하지 못하므로, rename 직전에 한 번
    // 더 확인해 위험 구간을 임시파일 쓰기 소요 시간까지로 좁힌다.
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const openIdx = writeDocxRaw.search(/\.open\s*\(\s*tmpPath/);
    const renameIdx = writeDocxRaw.search(/\brename\s*\(\s*tmpPath\s*,\s*filePath\s*\)/);
    docxAssert(openIdx >= 0 && renameIdx > openIdx, "open~rename 구간을 찾지 못함");
    const between = writeDocxRaw.slice(openIdx, renameIdx);
    docxAssert(/baselineRevision/.test(between), "rename 직전 구간에 baselineRevision을 다루는 코드가 없음");
    docxAssert(/createHash|sha256/i.test(between), "rename 직전 구간에서 현재 파일 내용의 해시를 다시 계산하지 않음");
    const syncIdx = between.search(/\.sync\s*\(\s*\)/);
    const recheckIdx = between.search(/baselineRevision/);
    docxAssert(syncIdx < 0 || recheckIdx > syncIdx,
      "baselineRevision 재검사가 임시파일 fsync보다 먼저 옴 — 재검사는 rename 직전(쓰기 완료 후)이어야 창이 좁아진다");
    return true;
  });

  card("T5", "쓰기 중간에 실패해도 원본 파일은 원본 그대로 남는다(fault injection)", () => {
    // POSIX rename은 원자적이라 rename 호출에 도달하기 전의 실패는 원본을 바꾸지 못한다.
    // 그래서 쓰기 중간 실패의 대표 시나리오는 그 앞 구간인 임시파일 생성에서의 실패다.
    // 디렉터리를 쓰기 금지(0555)로 만들어 임시파일 생성 자체가 EACCES로 실패하게
    // 강제한다.
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b9-"));
      try {
        const fixture = path.join(temp, "t5.docx");
        const original = Buffer.from("b9-t5-original-bytes-untouched");
        writeFileSync(fixture, original);
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b9-t5-read" }]);
        const baseline = readOut?.["b9-t5-read"]?.revision;
        docxAssert(!!baseline, "사전 read에서 baseline revision을 못 얻음: " + JSON.stringify(readOut));
        chmodSync(temp, 0o555);
        try {
          const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b9-t5-write", data: Buffer.from("attempted-overwrite").toString("base64"), baselineRevision: baseline }]);
          const resp = writeOut?.["b9-t5-write"];
          docxAssert(resp && resp.error, "디렉터리 쓰기 금지 상태에서도 저장이 에러 없이 성공으로 응답함(fault injection이 실제로 실패를 못 만든 것일 수도 있음): " + JSON.stringify(resp));
        } finally { chmodSync(temp, 0o755); }
        docxAssert(readFileSync(fixture).equals(original), "쓰기 중간 실패 후 원본 파일 내용이 바뀜 — 원자성 위반(rename 전 실패인데 원본이 손상됨)");
        docxAssert(!readdirSync(temp).some((name) => name.includes(".tmp-")), "실패 후 임시파일이 정리되지 않고 남아 있음");
      } finally {
        try { chmodSync(temp, 0o755); } catch {}
        rmSync(temp, { recursive: true, force: true });
      }
    }
    return true;
  });

  card("T6", "실패 시 catch 경로가 임시파일을 정리(unlink)한다", () => {
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const catchIdx = writeDocxRaw.search(/\bcatch\b/);
    docxAssert(catchIdx >= 0, "writeDocxRaw에 catch 블록이 없음 — 실패 시 임시파일이 남을 위험");
    const catchBlock = writeDocxRaw.slice(catchIdx);
    docxAssert(/unlink\s*\(\s*tmpPath\s*\)/.test(catchBlock), "catch 블록이 tmpPath를 unlink하지 않음");
    return true;
  });

  card("T7", "쓰기 대상이 symlink면 거절한다 — symlink를 통한 워크스페이스 밖 쓰기를 막는다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/isSymbolicLink|lstat/.test(writeHandler), "docx.write 핸들러가 symlink 여부를 확인하지 않음(lstat/isSymbolicLink)");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b9-t7-"));
      try {
        const real = path.join(temp, "real.docx");
        const original = Buffer.from("b9-t7-real-target-untouched");
        writeFileSync(real, original);
        const link = path.join(temp, "link.docx");
        symlinkSync(real, link);
        const readOut = docxWriteProbe([{ type: "docx.read", path: link, requestId: "b9-t7-read" }]);
        const baseline = readOut?.["b9-t7-read"]?.revision;
        docxAssert(!!baseline, "symlink 경로 사전 read에서 baseline revision을 못 얻음: " + JSON.stringify(readOut));
        const writeOut = docxWriteProbe([{ type: "docx.write", path: link, requestId: "b9-t7-write", data: Buffer.from("attempted-through-symlink").toString("base64"), baselineRevision: baseline }]);
        const resp = writeOut?.["b9-t7-write"];
        docxAssert(resp && resp.error, "symlink 경로로의 저장이 거절되지 않고 성공으로 응답함: " + JSON.stringify(resp));
        docxAssert(readFileSync(real).equals(original), "symlink를 통한 저장 시도 후 실제 대상 파일 내용이 바뀜");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T8", "같은 실제 파일을 가리키는 서로 다른 경로 문자열(어휘적 별칭)의 동시 저장 요청도 직렬화된다", () => {
    // enqueuePathIo가 정규화하지 않은 원시 경로 문자열을 큐 키로 쓰면 "dir/file.docx"와 "dir/./file.docx"는
    // 같은 파일인데도 서로 다른 키가 된다. 두 저장 요청이 직렬화되지 않고 동시에 처리되면
    // 레이스로 한쪽이 그대로 유실될 수 있다.
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/path\.resolve\s*\(\s*p\s*\)|resolve\s*\(\s*p\s*\)|\.dev\b[\s\S]{0,20}\.ino\b|\.ino\b[\s\S]{0,20}\.dev\b/.test(writeHandler),
      "docx.write 핸들러가 enqueuePathIo 큐 키를 path.resolve 또는 물리적 식별자(dev+ino)로 정규화하지 않음 — 경로 별칭이 직렬화를 우회할 수 있음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b9-t8-"));
      try {
        const real = path.join(temp, "aliased.docx");
        const original = Buffer.from("b9-t8-original");
        writeFileSync(real, original);
        const readOut = docxWriteProbe([{ type: "docx.read", path: real, requestId: "b9-t8-read" }]);
        const baseline = readOut?.["b9-t8-read"]?.revision;
        docxAssert(!!baseline, "사전 read에서 baseline revision을 못 얻음: " + JSON.stringify(readOut));
        // path.join은 "." 세그먼트를 즉시 정규화해 지워버려 real과 완전히 같은 문자열이 된다
        // (별칭 검증 무력화).
        // 문자열을 직접 이어붙여야 실제로 다른 리터럴이면서 같은 파일을 가리키는 경로가 만들어진다.
        const aliasPath = real.slice(0, real.lastIndexOf(path.sep) + 1) + "." + path.sep + "aliased.docx";
        docxAssert(aliasPath !== real, "별칭 경로 문자열이 원본과 리터럴로 같음 — 별칭 검증이 무의미해짐");
        const payloadA = Buffer.from("b9-t8-writer-a").toString("base64");
        const payloadB = Buffer.from("b9-t8-writer-b").toString("base64");
        const out = docxAliasedConcurrentWriteProbe([real, aliasPath], baseline, [payloadA, payloadB]);
        const r0 = out?.r0, r1 = out?.r1;
        docxAssert(r0 && r1, "별칭 동시 저장 응답을 둘 다 못 받음: " + JSON.stringify(out));
        const successes = [r0, r1].filter((r) => !r.error);
        const conflicts = [r0, r1].filter((r) => r.error);
        docxAssert(successes.length === 1 && conflicts.length === 1,
          `별칭 경로 동시 저장이 직렬화되지 않음 — 정확히 하나만 성공해야 하는데: ${JSON.stringify(out)}`);
        docxAssert(conflicts[0].conflict === true, "실패한 쪽이 conflict:true로 구분되지 않음(레이스로 인한 실패인데 일반 error처럼 보임)");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T9", "물리적 식별자(dev+ino) 기반 큐 키가 있다 — hard link 저장은 각자 정확한 내용으로 손상 없이 끝난다", () => {
    // temp+rename 방식의 원자적 교체에서는 hard link 로 연결된 두 이름을 하나로 직렬화해
    // conflict 로 처리할 수 없다. rename(tmpPath, name)은 그 이름의 디렉터리 엔트리만 새 inode로
    // 바꾸고, 같은 inode를 가리키던 다른 이름은 이전 inode를 그대로 가리킨다. vim 등 원자적
    // 저장을 쓰는 대부분의 에디터가 같은 특성을 가지며, 백업 후 교체 방식은 hard link 관계
    // 자체를 끊는다. dev+ino 큐 키를 적용한 뒤에도 순차 저장에서는 두 요청 모두 성공 응답을
    // 받고, 이후 real은 "writer-0", hardLink는 "writer-1" 로 남는다. 즉 두 이름이 물리적으로
    // 분리(un-hardlink)되지만 어느 쪽도 내용이 잘리거나 섞이지 않는다(no torn write,
    // no cross-contamination). Iris 는 hard link 를 만들지 않으므로, 사용자가 파일시스템에서
    // 직접 hard link 를 만든 뒤 두 이름을 각각 다른 탭으로 여는 드문 경우에만 나타나고,
    // 그때도 데이터 유실(원본의 부분 손상이나 한쪽 편집 전체 소실)은 없다. dev+ino 큐 키는
    // 같은 이름에 대한 두 요청이 겹쳐 temp 쓰기 도중 서로의 상태를 덮어쓰는 실제 동시성
    // 레이스만 막으면 되고, 실제로 막는다.
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/lstatSync|statSync/.test(writeHandler) && /\.dev\b/.test(writeHandler) && /\.ino\b/.test(writeHandler),
      "docx.write 핸들러가 lstat/stat의 dev+ino로 큐 키를 만들지 않음 — 진짜 동시(레이스) hard link 쓰기가 서로의 temp 상태를 밟을 위험");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b9-t9-"));
      try {
        const real = path.join(temp, "physical.docx");
        const original = Buffer.from("b9-t9-original");
        writeFileSync(real, original);
        const hardLink = path.join(temp, "hardlinked.docx");
        linkSync(real, hardLink);
        docxAssert(statSync(real).ino === statSync(hardLink).ino, "테스트 fixture 자체가 hard link를 못 만듦(환경 문제)");
        // saveAllowed(p)는 fsPathAllowed 또는 이 서버에서 열어본 적 있는 경로(wasOpenedHere)만
        // 허용하고, 두 별칭 경로가 물리적으로 같은 파일이어도 경로 문자열 단위로 추적한다.
        // 그래서 hardLink 쪽도 미리 한 번 read해 두지 않으면, 저장이 이 테스트가 검증하려는
        // 로직에 도달하기 전에 열어본 적 없음으로 거절된다.
        const readOut = docxWriteProbe([
          { type: "docx.read", path: real, requestId: "b9-t9-read" },
          { type: "docx.read", path: hardLink, requestId: "b9-t9-read-alias" },
        ]);
        const baseline = readOut?.["b9-t9-read"]?.revision;
        docxAssert(!!baseline, "사전 read에서 baseline revision을 못 얻음: " + JSON.stringify(readOut));
        docxAssert(!!readOut?.["b9-t9-read-alias"]?.revision, "hard link 별칭 경로의 사전 read(saveAllowed 통과용)가 실패함: " + JSON.stringify(readOut));
        const contentA = "b9-t9-writer-a", contentB = "b9-t9-writer-b";
        const writeOutA = docxWriteProbe([{ type: "docx.write", path: real, requestId: "b9-t9-write-a", data: Buffer.from(contentA).toString("base64"), baselineRevision: baseline }]);
        const respA = writeOutA?.["b9-t9-write-a"];
        docxAssert(respA && !respA.error, "real 경로로의 첫 저장이 실패함: " + JSON.stringify(respA));
        const writeOutB = docxWriteProbe([{ type: "docx.write", path: hardLink, requestId: "b9-t9-write-b", data: Buffer.from(contentB).toString("base64"), baselineRevision: baseline }]);
        const respB = writeOutB?.["b9-t9-write-b"];
        docxAssert(respB && !respB.error, "hardLink 경로로의 두 번째 저장이 실패함(un-hardlink 자체는 정상 동작): " + JSON.stringify(respB));
        docxAssert(readFileSync(real).toString() === contentA, `real 파일이 손상됨 — 보낸 내용과 다름: ${readFileSync(real).toString()}`);
        docxAssert(readFileSync(hardLink).toString() === contentB, `hardLink 파일이 손상됨 — 보낸 내용과 다름: ${readFileSync(hardLink).toString()}`);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T10", "writeDocxRaw는 baselineRevision을 필수 인자로 검증한다 — 재검사를 빼먹은 새 호출자가 조용히 생기지 못하게 막는다", () => {
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const sigMatch = writeDocxRaw.match(/function\s+writeDocxRaw\s*\(([^)]*)\)/);
    docxAssert(sigMatch, "writeDocxRaw 시그니처를 찾지 못함");
    docxAssert(/baselineRevision/.test(sigMatch[1]) || /options/.test(sigMatch[1]),
      "writeDocxRaw 시그니처에 baselineRevision(또는 options)이 없음");
    const beforeOpen = writeDocxRaw.slice(0, Math.max(0, writeDocxRaw.search(/\.open\s*\(\s*tmpPath/)));
    docxAssert(/baselineRevision/.test(beforeOpen) && /throw/.test(beforeOpen),
      "임시파일을 열기 전에 baselineRevision 유효성을 검증해 throw하지 않음 — 누락된 호출자가 재검사 없이 조용히 통과할 위험");
    return true;
  });

  card("T11", "쓰기 대상이 symlink가 아니어도 일반 파일이 아니면(디렉터리·FIFO·소켓) 거절한다", () => {
    // symlink만 막으면 FIFO·소켓·디렉터리 같은 비정규 파일을 거르지 못한다. 특히 동기
    // readFileSync가 FIFO를 만나면 이벤트 루프 전체가 무기한 멈출 수 있다.
    // lstat().isFile()로 symlink와 비정규 파일을 한 번에 거절해야 한다.
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/isFile\s*\(\s*\)/.test(writeHandler),
      "docx.write 핸들러가 lstat(...).isFile()로 일반 파일 여부를 확인하지 않음 — symlink만 막고 FIFO/소켓/디렉터리는 새어나감");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b9-t11-"));
      try {
        const dirTarget = path.join(temp, "adir.docx");
        mkdirSync(dirTarget);
        const readOut = docxWriteProbe([{ type: "docx.read", path: dirTarget, requestId: "b9-t11-read" }]);
        // 디렉터리는 docx.read 자체가 실패할 수 있다. baseline을 못 얻으면 임의 64자리 hex로 시도하며, 어느 쪽이든 거절돼야 한다.
        const baseline = readOut?.["b9-t11-read"]?.revision || "0".repeat(64);
        const writeOut = docxWriteProbe([{ type: "docx.write", path: dirTarget, requestId: "b9-t11-write", data: Buffer.from("x").toString("base64"), baselineRevision: baseline }]);
        const resp = writeOut?.["b9-t11-write"];
        docxAssert(resp && resp.error, "디렉터리 경로로의 저장이 거절되지 않고 성공으로 응답함: " + JSON.stringify(resp));
        docxAssert(statSync(dirTarget).isDirectory(), "디렉터리 대상에 저장 시도 후 디렉터리 자체가 사라지거나 바뀜");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T12", "임시파일 쓰기는 부분 쓰기(short write) 위험이 없는 API로 한다", () => {
    // 저수준 fh.write()는 요청보다 작은 bytesWritten 으로 일부만 쓰고 끝날 수 있다. 이를
    // 무시하고 전체가 쓰였다고 가정하면 부분 DOCX가 원본을 교체할 위험이 있다.
    // fh.writeFile()(또는 fs.writeFile)은 Node가 내부적으로 전체 버퍼를 쓸 때까지 반복하므로
    // 이 위험이 구조적으로 없다.
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    docxAssert(/\.writeFile\s*\(/.test(writeDocxRaw),
      "writeDocxRaw가 handle.writeFile()(전체 쓰기 보장)을 쓰지 않음 — 대신 저수준 .write()를 쓰면 short write 위험이 있음");
    docxAssert(!/[^.]\.write\s*\(\s*bytes\s*\)/.test(writeDocxRaw) && !/\bfh\.write\s*\(/.test(writeDocxRaw),
      "writeDocxRaw가 handle.write()(부분 쓰기 가능, 반환값 미확인 시 위험)를 직접 호출함");
    return true;
  });

  card("T13", "wx 충돌(EEXIST) 시 자신이 만들지 않은 파일을 지우지 않는다", () => {
    // catch에 unlink(tmpPath)가 있는지만 확인하는 T6의 오라클은 조건 없이 항상 unlink하는
    // 구현도 통과시킨다. wx가 EEXIST로 실패하면, 즉 임시파일 이름이 이미 존재하는 파일과
    // 충돌하면, 이 호출이 만들지 않은 파일까지 지워진다.
    // handle을 성공적으로 얻었을 때만(created 플래그 등) cleanup해야 한다.
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const createdFlagMatch = writeDocxRaw.match(/(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*false/);
    docxAssert(createdFlagMatch, "임시파일을 실제로 생성했는지 추적하는 플래그(let ... = false)가 없음");
    const flagName = createdFlagMatch[1];
    const catchIdx = writeDocxRaw.search(/\bcatch\b/);
    docxAssert(catchIdx >= 0, "catch 블록이 없음");
    const catchBlock = writeDocxRaw.slice(catchIdx);
    docxAssert(new RegExp(`if\\s*\\(\\s*${flagName}\\s*\\)[\\s\\S]{0,80}unlink`).test(catchBlock),
      `catch 블록이 ${flagName} 플래그 확인 없이 무조건 unlink함 — EEXIST로 open 자체가 실패한 경우 남의 파일을 지울 위험`);
    return true;
  });

  card("T14", "임시파일은 처음부터 보수적 권한(0600)으로 만들고, 권한 복사 실패는 저장 실패로 취급한다", () => {
    // temp 파일이 기본 umask 권한(보통 0666&umask)으로 잠깐이라도 존재하면 민감한 docx
    // 내용이 더 넓은 권한으로 노출된다. 원본 mode 복사(chmod) 실패를 빈 catch로 무시하고
    // rename까지 진행하면, 0600처럼 좁은 권한이던 문서가 더 넓은 기본 권한으로 교체된다.
    // chmod 실패는 저장 자체를 막아야 한다.
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    docxAssert(/\.open\s*\(\s*tmpPath\s*,\s*["']wx["']\s*,\s*0o?600\b/i.test(writeDocxRaw),
      "임시파일을 0o600(보수적 기본 권한)으로 열지 않음");
    const chmodIdx = writeDocxRaw.search(/chmod/);
    docxAssert(chmodIdx >= 0, "권한 복사(chmod) 코드가 없음");
    const aroundChmod = writeDocxRaw.slice(Math.max(0, chmodIdx - 200), chmodIdx + 300);
    docxAssert(!/catch\s*\{\s*\}/.test(aroundChmod) && !/catch\s*\(\s*\)?\s*\{\s*\}/.test(aroundChmod),
      "chmod 실패를 빈 catch로 무시함 — 원본보다 넓은 권한으로 저장되는데도 저장은 성공 처리됨");
    return true;
  });

  card("T15", "디렉터리 fsync 실패는 저장 실패로 보고하지 않고, 파일 핸들은 모든 경로에서 명시적으로 닫힌다", () => {
    // rename이 성공한 뒤 디렉터리 fsync가 권한 등으로 실패했을 때 저장 전체를 실패로
    // 응답하면, 클라이언트는 재시도하고 사용자는 이미 성공한 저장을 실패로 오인한다.
    // 또한 반복 저장에서 handle을 닫지 않으면 EMFILE로 이어진다.
    docxAssert(writeDocxRaw, "writeDocxRaw 함수를 찾지 못함");
    const renameIdx = writeDocxRaw.search(/\brename\s*\(\s*tmpPath\s*,\s*filePath\s*\)/);
    docxAssert(renameIdx >= 0, "rename 호출을 찾지 못함");
    const afterRename = writeDocxRaw.slice(renameIdx);
    const dirSyncBlock = afterRename.slice(0, afterRename.search(/\bcatch\b(?![\s\S]*\bcatch\b)/) + 200 || 400);
    docxAssert(/try\s*\{[\s\S]{0,300}\.sync\s*\(\s*\)[\s\S]{0,300}\}\s*catch/.test(afterRename),
      "rename 후 디렉터리 fsync가 try/catch로 감싸여 있지 않음 — fsync 실패가 그대로 저장 실패로 전파될 위험");
    docxAssert(/finally\s*\{[\s\S]{0,80}\.close\s*\(\s*\)/.test(writeDocxRaw) || (writeDocxRaw.match(/\.close\s*\(\s*\)/g) || []).length >= 2,
      "파일 핸들 close()가 성공/실패 각 경로에서 명시적으로 호출되는지 확인 불가 — handle 누수 위험");
    return true;
  });
}


export default async function run() {
  await runDocxBlock9Checks();
}
