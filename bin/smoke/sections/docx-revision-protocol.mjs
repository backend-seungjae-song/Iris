// 소유 범위: revision 을 실은 읽기·쓰기 프로토콜. 남의 revision 위에 덮지 않는다.
// 제공 API: 이름 export runDocxBlock7Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-revision-protocol.mjs
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

export async function runDocxBlock7Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B7-")) return;
  console.log("\n[DOCX Block 7 RED] Revisioned read/write protocol");
  const card = (id, name, fn) => { if (!selected || selected === `B7-${id}`) check(`[DOCX-B7-${id}] ${name}`, fn); };

  const srv = read("server/index.js");
  const docxHandlers = read("server/docx-handlers.js");
  const readHandler = docxDispatchedHandler(srv, docxHandlers, "docx.read");
  const writeHandler = docxDispatchedHandler(srv, docxHandlers, "docx.write");

  card("T1", "docx.read 응답은 실제 바이트의 SHA-256 revision을 포함한다", () => {
    docxAssert(/revision/.test(readHandler), "docx.read 핸들러에 revision 필드가 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t1.docx");
        writeFileSync(fixture, "PK\x03\x04not-a-real-zip-but-bytes-suffice-for-hash-check");
        const expected = createHash("sha256").update(readFileSync(fixture)).digest("hex");
        const out = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t1" }]);
        docxAssert(out?.["b7-t1"]?.revision === expected, `live revision이 실제 파일 SHA-256과 다름: ${JSON.stringify(out?.["b7-t1"])}`);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T2", "baselineRevision이 일치하면 저장 성공 + 새 revision 반환 + 파일이 실제로 갱신된다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/baselineRevision/.test(writeHandler), "docx.write가 baselineRevision을 다루지 않음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t2.docx");
        const original = Buffer.from("original-bytes-v1");
        writeFileSync(fixture, original);
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t2-read" }]);
        const baseline = readOut?.["b7-t2-read"]?.revision;
        docxAssert(!!baseline, "사전 read에서 baseline revision을 못 얻음: " + JSON.stringify(readOut));
        const newBytes = Buffer.from("updated-bytes-v2");
        const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b7-t2-write", data: newBytes.toString("base64"), baselineRevision: baseline }]);
        const resp = writeOut?.["b7-t2-write"];
        docxAssert(resp && !resp.error && typeof resp.revision === "string" && resp.revision.length === 64,
          "정상 저장이 성공(64자 hex revision)으로 응답하지 않음: " + JSON.stringify(resp));
        docxAssert(readFileSync(fixture).equals(newBytes), "파일 내용이 실제로 새 바이트로 갱신되지 않음");
        docxAssert(resp.revision === createHash("sha256").update(newBytes).digest("hex"), "응답 revision이 새로 쓴 바이트의 SHA-256과 다름");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T3", "baselineRevision이 실제로 바뀐 디스크 상태와 불일치하면 거절하고 원본을 보존한다", () => {
    // "0".repeat(64) 같은 가짜 stale 값만 보내면, baseline 을 마지막으로 읽은 캐시값과
    // 비교하는(디스크를 다시 읽지 않는) 잘못된 구현도 통과한다. 파일을 외부에서 바꾼 뒤 그
    // 이전 revision 으로 저장을 시도해야 쓰기 직전 현재 디스크 해시와 비교하는지 검증된다.
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/conflict/.test(writeHandler), "docx.write에 conflict 판정이 없음 — 일반 error와 구분 불가");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t3.docx");
        writeFileSync(fixture, Buffer.from("original-v1"));
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t3-read" }]);
        const staleRevision = readOut?.["b7-t3-read"]?.revision;
        docxAssert(!!staleRevision, "사전 read 실패: " + JSON.stringify(readOut));
        const externallyChanged = Buffer.from("externally-changed-v2-outside-server");
        writeFileSync(fixture, externallyChanged); // 서버를 거치지 않고 직접 파일을 바꿈(외부 변경 재현)
        const before = statSync(fixture);
        const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b7-t3-write", data: Buffer.from("attempted-overwrite").toString("base64"), baselineRevision: staleRevision }]);
        const resp = writeOut?.["b7-t3-write"];
        docxAssert(resp && resp.error && resp.conflict === true, "stale baseline(외부 변경 후)이 conflict:true 응답을 만들지 않음: " + JSON.stringify(resp));
        const after = statSync(fixture);
        docxAssert(readFileSync(fixture).equals(externallyChanged), "conflict 거절 후에도 파일 바이트가 바뀜 — 외부 변경 내용 보존 실패");
        docxAssert(before.mtimeNs === after.mtimeNs, "conflict 거절 후에도 mtime이 바뀜");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T4", "원격 연결(ws._local=false)에서 docx.write는 거절된다(AC5)", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/!ws\._local/.test(writeHandler), "docx.write에 원격 거절(!ws._local) 분기가 없음 — fs.write/sheet.write와 다른 경계");
    return true;
  });

  card("T5", "saveAllowed 밖 경로(열지 않은 파일)의 docx.write는 거절된다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/saveAllowed\s*\(/.test(writeHandler), "docx.write가 saveAllowed 경계를 쓰지 않음");
    return true;
  });

  card("T6", "잘못된 base64 또는 20MB 초과 payload는 거절된다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/typeof\s+msg\.data\s*===?\s*["']string["']/.test(writeHandler), "docx.write가 msg.data 타입을 검증하지 않음");
    docxAssert(/20\s*\*\s*1024\s*\*\s*1024|MAX_DOCX_BYTES/.test(writeHandler), "docx.write에 20MB 상한 검증이 없음");
    return true;
  });

  card("T7", "동일 파일 연속 두 저장(각자 이전 새 revision 사용)이 서로를 충돌로 오인하지 않는다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음 — 연속 저장 자체를 시도할 수 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t7.docx");
        writeFileSync(fixture, Buffer.from("v0"));
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t7-read" }]);
        let revision = readOut?.["b7-t7-read"]?.revision;
        docxAssert(!!revision, "사전 read 실패: " + JSON.stringify(readOut));
        for (const [label, bytes] of [["first", Buffer.from("v1-first-save")], ["second", Buffer.from("v2-second-save")]]) {
          const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b7-t7-" + label, data: bytes.toString("base64"), baselineRevision: revision }]);
          const resp = writeOut?.["b7-t7-" + label];
          docxAssert(resp && !resp.error, `${label} 저장이 실패함(직전 저장의 새 revision을 썼는데도 충돌 오인): ` + JSON.stringify(resp));
          revision = resp.revision;
        }
        docxAssert(readFileSync(fixture).equals(Buffer.from("v2-second-save")), "두 번째 저장 내용이 최종 파일에 반영되지 않음");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T8", "같은 경로의 docx read/write는 enqueuePathIo로 직렬화된다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/enqueuePathIo\s*\(/.test(writeHandler), "docx.write가 enqueuePathIo를 쓰지 않음 — sheet.write와 다른 동시성 경계");
    docxAssert(/enqueuePathIo\s*\(/.test(readHandler), "docx.read가 enqueuePathIo를 쓰지 않음(기존 동작 회귀 확인)");
    return true;
  });

  card("T9", "저장 성공 후 recompute()가 호출된다(git 상태 갱신, fs.write/sheet.write 선례)", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    docxAssert(/recompute\s*\(\s*\)/.test(writeHandler), "docx.write 성공 경로에 recompute() 호출이 없음");
    return true;
  });

  card("T10", "docx 쓰기는 임시파일+rename 최소 패턴을 따른다(sheet.js writeWorkbook 선례 수준)", () => {
    const docxPath = path.join(ROOT, "server/docx.js");
    const docx = existsSync(docxPath) ? readFileSync(docxPath, "utf8") : "";
    docxAssert(/writeDocxRaw|writeDocx\s*\(/.test(docx), "server/docx.js에 쓰기 함수가 없음");
    docxAssert(/\.tmp-|tmpPath/.test(docx), "임시파일 경로 패턴이 없음 — 직접 원본에 씀(원자성 없음)");
    docxAssert(/rename(?:Sync)?\s*\(/.test(docx), "rename 호출이 없음 — 임시파일→원본 교체가 원자적이지 않음");
    docxAssert(/catch[\s\S]{0,200}unlink(?:Sync)?\s*\(/.test(docx), "쓰기 실패 시 임시파일 정리(unlink) 경로가 없음");
    return true;
  });

  card("T11", "docx.read의 data와 revision은 같은 한 번의 읽기에서 나온 동일 bytes에서 파생된다", () => {
    docxAssert(/revision/.test(readHandler), "docx.read 핸들러에 revision 필드가 없음 — data와의 동일 출처 검증 자체가 불가");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t11.docx");
        writeFileSync(fixture, Buffer.from("t11-single-read-source"));
        const out = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t11" }]);
        const resp = out?.["b7-t11"];
        docxAssert(resp && typeof resp.data === "string" && typeof resp.revision === "string", "data/revision 응답이 없음: " + JSON.stringify(resp));
        const decoded = Buffer.from(resp.data, "base64");
        const expected = createHash("sha256").update(decoded).digest("hex");
        docxAssert(resp.revision === expected, "revision이 응답에 실린 data(base64 디코드)의 SHA-256과 다름 — 별도 재읽기로 파생됐을 위험");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T12", "저장은 캐시된 값이 아니라 쓰기 직전 현재 디스크 revision과 비교한다", () => {
    // T3 와 달리 이 카드는 외부 변경이 있었는데도 stale baseline 으로 저장이 성공하는 실패
    // 모드를 겨냥한다. T3 는 거절 자체를, T12 는 비교 시점의 신선도를 확인하도록 카드를 나눠
    // 둔다.
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t12.docx");
        writeFileSync(fixture, Buffer.from("t12-v1"));
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t12-read" }]);
        const r1 = readOut?.["b7-t12-read"]?.revision;
        docxAssert(!!r1, "사전 read 실패: " + JSON.stringify(readOut));
        writeFileSync(fixture, Buffer.from("t12-v2-external"));
        const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b7-t12-write", data: Buffer.from("t12-v3-attempted").toString("base64"), baselineRevision: r1 }]);
        const resp = writeOut?.["b7-t12-write"];
        docxAssert(resp && resp.conflict === true, "외부 변경 후 stale baseline 저장이 conflict로 거절되지 않음(캐시값과 비교했을 위험): " + JSON.stringify(resp));
        docxAssert(readFileSync(fixture).equals(Buffer.from("t12-v2-external")), "conflict인데도 파일이 바뀜");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T13", "같은 baseline으로 동시에 저장하는 두 연결 중 정확히 하나만 성공한다", () => {
    docxAssert(!!writeHandler && /conflict/.test(writeHandler), "docx.write 핸들러 또는 conflict 판정이 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t13.docx");
        writeFileSync(fixture, Buffer.from("t13-v0"));
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t13-read" }]);
        const baseline = readOut?.["b7-t13-read"]?.revision;
        docxAssert(!!baseline, "사전 read 실패: " + JSON.stringify(readOut));
        const candidates = [Buffer.from("t13-from-socket-a"), Buffer.from("t13-from-socket-b")];
        const out = docxConcurrentWriteProbe(fixture, baseline, candidates.map((b) => b.toString("base64")));
        const results = [out?.r0, out?.r1];
        const successes = results.filter((r) => r && !r.error);
        const conflicts = results.filter((r) => r && r.error && r.conflict === true);
        docxAssert(successes.length === 1 && conflicts.length === 1,
          `동시 저장 결과가 성공 1/충돌 1이 아님(성공 ${successes.length}, 충돌 ${conflicts.length}): ${JSON.stringify(out)}`);
        const winner = successes[0];
        const winnerCandidate = candidates.find((b) => createHash("sha256").update(b).digest("hex") === winner.revision);
        docxAssert(!!winnerCandidate, "성공 응답의 revision이 두 후보 payload 중 어느 것의 해시와도 일치하지 않음: " + JSON.stringify(winner));
        docxAssert(readFileSync(fixture).equals(winnerCandidate), "최종 파일 바이트가 성공한 쪽의 payload와 다름");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T14", "열람 후 외부에서 삭제된 파일에 대한 저장은 되살리지 않고 conflict로 거절한다", () => {
    // 이 분기는 design.md 에 없다. "덮어쓰기 기본, 외부 변경 시 저장 중단" 정책을 파일이
    // 통째로 사라진 경우까지 확장한 결정이고, 확정된 충돌 정책의 극단 사례라 새로운 사용자
    // 트레이드오프는 아니다.
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t14.docx");
        writeFileSync(fixture, Buffer.from("t14-v1"));
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t14-read" }]);
        const revision = readOut?.["b7-t14-read"]?.revision;
        docxAssert(!!revision, "사전 read 실패: " + JSON.stringify(readOut));
        unlinkSync(fixture);
        const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b7-t14-write", data: Buffer.from("t14-resurrect-attempt").toString("base64"), baselineRevision: revision }]);
        const resp = writeOut?.["b7-t14-write"];
        docxAssert(resp && resp.error && resp.conflict === true, "삭제된 파일에 대한 저장이 conflict로 거절되지 않음: " + JSON.stringify(resp));
        docxAssert(!existsSync(fixture), "삭제된 파일이 저장으로 되살아남(외부 변경을 덮어씀)");
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T15", "충돌이 아닌 오류(권한·잘못된 baseline 등)에는 conflict:true가 붙지 않는다", () => {
    docxAssert(!!writeHandler && /saveAllowed\s*\(/.test(writeHandler), "docx.write 핸들러 또는 saveAllowed 경계가 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const neverOpened = path.join(temp, "t15-never-opened.docx");
        writeFileSync(neverOpened, Buffer.from("t15-v1"));
        const writeOut = docxWriteProbe([{ type: "docx.write", path: neverOpened, requestId: "b7-t15-write", data: Buffer.from("x").toString("base64"), baselineRevision: "a".repeat(64) }]);
        const resp = writeOut?.["b7-t15-write"];
        docxAssert(resp && resp.error, "열지 않은 경로 저장이 에러 없이 진행됨: " + JSON.stringify(resp));
        docxAssert(resp.conflict !== true, "saveAllowed 거절인데 conflict:true가 붙음 — 클라이언트가 권한 거절을 baseline 충돌로 오인할 위험: " + JSON.stringify(resp));
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T16", "잘못된 base64와 20MB 초과는 decoded bytes 기준으로 거절되고, 정확히 20MB는 성공한다", () => {
    docxAssert(!!writeHandler, "docx.write 핸들러가 없음");
    if (LIVE) {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t16.docx");
        writeFileSync(fixture, Buffer.from("t16-v1"));
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t16-read" }]);
        const baseline = readOut?.["b7-t16-read"]?.revision;
        docxAssert(!!baseline, "사전 read 실패: " + JSON.stringify(readOut));
        // 두 step 을 한 probe 호출에 같이 보내면 malformed 응답을 받은 시점에 이미 유효한
        // 20MB step 까지 처리가 끝나, "malformed 시도 후 원본 불변" 단언을 관측할 수 없다.
        // malformed 와 20MB 를 별도 probe 호출로 분리해 같은 oracle 을 관측 가능하게 만든다.
        const malformedOut = docxSizedWriteProbe(fixture, [{ kind: "malformedBase64", baselineRevision: baseline }]);
        const malformed = malformedOut?.s0;
        docxAssert(malformed && malformed.error && malformed.conflict !== true, "malformed base64가 일반 error(conflict 아님)로 거절되지 않음: " + JSON.stringify(malformed));
        docxAssert(readFileSync(fixture).equals(Buffer.from("t16-v1")), "malformed payload 시도 후에도 원본이 바뀌면 안 됨");
        const sizedOut = docxSizedWriteProbe(fixture, [{ kind: "sized", bytes: 20 * 1024 * 1024, baselineRevision: baseline }]);
        const exact20mb = sizedOut?.s0;
        docxAssert(exact20mb && !exact20mb.error && exact20mb.revision, "정확히 20MB payload가 성공하지 않음: " + JSON.stringify(exact20mb));
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });

  card("T17", "임시파일 교체 후에도 원본 파일 mode(권한)를 보존한다", () => {
    docxAssert(/chmod(?:Sync)?\s*\(/.test((() => { const p = path.join(ROOT, "server/docx.js"); return existsSync(p) ? readFileSync(p, "utf8") : ""; })()),
      "server/docx.js의 쓰기 함수가 원본 mode를 임시파일에 복사하지 않음(writeWorkbook 선례 미준수)");
    if (LIVE && process.platform !== "win32") {
      const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-b7-"));
      try {
        const fixture = path.join(temp, "t17.docx");
        writeFileSync(fixture, Buffer.from("t17-v1"));
        chmodSync(fixture, 0o600);
        const readOut = docxWriteProbe([{ type: "docx.read", path: fixture, requestId: "b7-t17-read" }]);
        const baseline = readOut?.["b7-t17-read"]?.revision;
        docxAssert(!!baseline, "사전 read 실패: " + JSON.stringify(readOut));
        const writeOut = docxWriteProbe([{ type: "docx.write", path: fixture, requestId: "b7-t17-write", data: Buffer.from("t17-v2").toString("base64"), baselineRevision: baseline }]);
        const resp = writeOut?.["b7-t17-write"];
        docxAssert(resp && !resp.error, "정상 저장이 실패함: " + JSON.stringify(resp));
        const mode = statSync(fixture).mode & 0o777;
        docxAssert(mode === 0o600, `저장 후 파일 mode가 0600으로 보존되지 않음(실제: ${mode.toString(8)})`);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    return true;
  });
}


export default async function run() {
  await runDocxBlock7Checks();
}
