import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readDocxRaw, writeDocxRaw, isDocxPath, MAX_DOCX_BYTES } from "./docx.js";
import { enqueuePathIo } from "./path-io.js";
import {
  isPathAllowed as fsPathAllowed,
  noteOpened,
  requestRecompute as recompute,
  saveAllowed,
  saveDeniedMsg,
} from "./runtime-state.js";

// docx.read/write WebSocket 요청의 경계·revision 충돌·queued persistence를 맡는 leaf handler.
//
// 소유 범위
//   DOCX read/write correlation 응답, base64·크기 검증, inode queue key와 외부 변경 충돌 순서.
//
// 제공 API
//   entry exact dispatch가 호출하는 handleDocxRead와 handleDocxWrite.
//
// 의존 대상
//   docx helper, path-io FIFO와 runtime-state의 단일 경로·열린 파일 저장 capability·recompute port.
//
// 유지 조건
//   로컬 read 예외와 원격 경계, baseline SHA-256 재검사, symlink/일반 파일 판정, 20MB 상한,
//   응답 필드·조건·순서·타이밍을 보존하고 다른 handler를 import하거나 호출하지 않는다.
//
// 영향 범위
//   server/index.js의 docx.read/write dispatch와 runtime-state 열린 파일 capability,
//   server/docx.js 원자 교체 계약, web/js/docx/editor.js 및 bin/smoke.mjs DOCX Block 1·7·9 검사.

// docx.read(문서 원본): 렌더러가 직접 해석할 OOXML 바이트를 base64로 전달한다.
// 읽기 경계와 크기 상한은 fs.read/sheet.read와 같고, 서버에서는 문서를 파싱하지 않는다.
export async function handleDocxRead(ws, msg) {
  const done = (extra) => ws.send(JSON.stringify({ type: "docx", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, docxGeneration: msg.docxGeneration, ...extra }));
  const p = msg.path;
  if (!p || (!ws._local && !fsPathAllowed(p))) { done({ error: "허용되지 않은 경로" }); return; }
  if (!isDocxPath(p)) { done({ error: "DOCX로 열 수 있는 형식이 아닙니다" }); return; }
  await enqueuePathIo(p, async () => {
    try {
      const { data, revision } = await readDocxRaw(p, { local: ws._local, fsPathAllowed });
      if (ws._local) noteOpened(p);   // 뷰어에 실제로 표시한 파일이 저장 가능한 파일이다(fs.read/sheet.read 선례)
      done({ data, revision });
    } catch (e) {
      done({ error: String((e && e.message) || e) });
    }
  });
}

// docx.write(문서 저장): 원본 덮어쓰기, baselineRevision(쓰기 직전 현재 디스크 SHA-256)이
// 불일치하면 conflict로 거절하고 원본을 보존한다. 쓰기 경계는 fs.write/sheet.write와 같다.
// 로컬만(AC5), saveAllowed 안쪽만.
export async function handleDocxWrite(ws, msg) {
  const done = (extra) => ws.send(JSON.stringify({ type: "docx-saved", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, ...extra }));
  const p = msg.path;
  if (!ws._local) { done({ error: "원격에서는 저장 불가(AC5)" }); return; }
  if (!p || !saveAllowed(p)) { done({ error: saveDeniedMsg(p) }); return; }
  if (!isDocxPath(p)) { done({ error: "DOCX로 저장할 수 있는 형식이 아닙니다" }); return; }
  const data = typeof msg.data === "string" ? msg.data : null;
  if (data === null) { done({ error: "저장할 내용이 올바르지 않습니다" }); return; }
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    done({ error: "저장할 내용이 올바른 base64가 아닙니다" }); return;
  }
  if (typeof msg.baselineRevision !== "string" || !/^[0-9a-f]{64}$/i.test(msg.baselineRevision)) {
    done({ error: "기준 revision이 올바르지 않습니다" }); return;
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_DOCX_BYTES) { done({ error: "파일이 너무 큽니다(20MB 초과) — 저장하지 않음" }); return; }

  // 큐 키: 가능하면 물리적 식별자(dev+ino)를 쓴다. hard link·대소문자 별칭·상위 symlink까지 같은 실제
  // 파일이면 하나의 큐로 합쳐진다. lstat이 실패하면(파일이 아직 없거나 이 시점에만 사라짐)
  // path.resolve로 어휘적 별칭("."/"..")만 정규화한 값으로 폴백한다. 아래
  // enqueuePathIo 콜백의 fresh lstat/read가 실제 존재·타입을 다시 검증하므로 안전하다.
  let queueKey = path.resolve(p);
  try {
    const lst = fs.lstatSync(p);
    if (!lst.isSymbolicLink() && lst.isFile()) {
      queueKey = `${lst.dev}:${lst.ino}`;
    }
  } catch {}

  await enqueuePathIo(queueKey, async () => {
    try {
      let lst;
      try {
        lst = fs.lstatSync(p);
      } catch (e) {
        if (e && e.code === "ENOENT") {
          done({ error: "원본 파일이 더 이상 존재하지 않습니다(외부에서 삭제됨)", conflict: true });
          return;
        }
        throw e;
      }
      if (lst.isSymbolicLink() || !lst.isFile()) {
        done({ error: "symlink이거나 일반 파일이 아닌 대상에는 저장할 수 없습니다" });
        return;
      }
      const current = fs.readFileSync(p);
      const currentRevision = crypto.createHash("sha256").update(current).digest("hex");
      if (currentRevision !== msg.baselineRevision) {
        done({ error: "다른 곳에서 파일이 바뀌었습니다 — 저장을 중단했습니다", conflict: true });
        return;
      }
      const revision = await writeDocxRaw(p, bytes, { baselineRevision: msg.baselineRevision });
      done({ revision });
      recompute(); // git 상태 갱신 트리거
    } catch (e) {
      if (e && e.conflict) { done({ error: e.message, conflict: true }); return; }
      done({ error: String((e && e.message) || e) });
    }
  });
}
