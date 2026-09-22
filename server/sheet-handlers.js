import fs from "node:fs";

import { isSheetPath, readSheet, supportsSheetMerges, writeSheet } from "./sheet.js";
import { enqueuePathIo } from "./path-io.js";
import {
  isPathAllowed as fsPathAllowed,
  noteOpened,
  requestRecompute as recompute,
  saveAllowed,
  saveDeniedMsg,
} from "./runtime-state.js";

// 표 파일 읽기와 사용자 편집 저장 계약의 단일 handler.
//
// 소유 범위
//   sheet.read의 형식·크기·읽기 경계와 sheet.write의 편집 검증·직렬화·저장 응답.
//
// 제공 API
//   WebSocket 진입점이 부르는 handleSheetRead와 handleSheetWrite 함수.
//
// 의존 대상
//   sheet 형식 구현, path-io의 path queue, runtime-state의 경로·열어 본 파일·재계산 port.
//
// 유지 조건
//   읽기 경계·20MB 상한, merge 선검증, dirty payload 순서, 외부 변경 직렬화와 저장 후 recompute.
//
// 영향 범위
//   server/index.js의 sheet.read/write dispatch와 fs handler의 공용 queue,
//   test/sheet-*·test/file-* 및 bin/smoke.mjs 표 저장·상관관계·경계 검사.

// sheet.read(표 파일): 엑셀·CSV를 화면이 그릴 수 있는 모양으로 바꿔 보낸다.
// 읽기 경계와 크기 상한은 fs.read와 같은 규칙을 쓴다. 같은 파일을 두 경로로 여는데 한쪽만
// 느슨하면 그쪽이 우회 경로가 된다.
export async function handleSheetRead(ws, msg) {
  const done = (extra) => ws.send(JSON.stringify({ type: "sheet", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, ...extra }));
  const p = msg.path;
  if (!p || (!ws._local && !fsPathAllowed(p))) { ws.send(JSON.stringify({ type: "sheet", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, error: "허용되지 않은 경로" })); return; }
  if (!isSheetPath(p)) { done({ error: "표로 열 수 있는 형식이 아닙니다" }); return; }
  await enqueuePathIo(p, async () => {
    try {
      const st = fs.statSync(p);
      if (st.size > 20 * 1024 * 1024) { ws.send(JSON.stringify({ type: "sheet", path: p, requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, error: "파일이 너무 큽니다(20MB 초과) — 열지 않음" })); return; }
      const data = await readSheet(p);
      if (ws._local) noteOpened(p);   // 표 뷰어로 연 파일 = 저장도 되는 파일
      done({ data });
    } catch (e) {
      // 손상된 파일·암호가 걸린 파일이 여기로 온다. 창은 이 말을 그대로 보여주고 Finder를 권한다.
      done({ error: String((e && e.message) || e) });
    }
  });
}

// sheet.write(표 고쳐 쓰기): 바뀐 칸만 원본에 갈아 끼운다.
// 쓰기 경계는 fs.write와 같다. 로컬만, 워크스페이스 하위만 허용한다. 읽기는 로컬에 한해
// 워크스페이스 밖까지 열려 있지만 쓰기는 열지 않는다. 잘못 쓰면 되돌릴 수 없기 때문이다.
export async function handleSheetWrite(ws, msg) {
  const done = (extra) => ws.send(JSON.stringify({ type: "sheet-saved", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, ...extra }));
  const p = msg.path;
  if (!ws._local) { done({ error: "원격에서는 저장 불가(AC5)" }); return; }
  if (!p || !saveAllowed(p)) { done({ error: saveDeniedMsg(p) }); return; }
  if (!isSheetPath(p)) { done({ error: "표로 저장할 수 있는 형식이 아닙니다" }); return; }
  const edits = Array.isArray(msg.edits) ? msg.edits : null;
  if (!edits || !edits.length) { done({ error: "바뀐 칸이 없습니다" }); return; }
  if (edits.length > 20000) { done({ error: "한 번에 저장할 수 있는 칸을 넘었습니다(2만 칸)" }); return; }
  await enqueuePathIo(p, async () => {
    try {
      const mergeEdits = edits.filter((e) => e && e.merge);
      let sheetNames = null;
      if (mergeEdits.length && supportsSheetMerges(p)) {
        const book = await readSheet(p);
        sheetNames = new Set((book.sheets || []).map((sheet) => sheet.name));
      }
      let mergeRangeCount = 0;
      for (const e of edits) {
        if (!e) { done({ error: "칸 위치가 올바르지 않습니다" }); return; }
        if (e.merge) {
          if (!supportsSheetMerges(p)) { done({ error: "이 표 형식은 셀 병합을 지원하지 않습니다" }); return; }
          if (typeof e.sheet !== "string" || !sheetNames.has(e.sheet)) { done({ error: "병합할 시트 이름이 올바르지 않습니다" }); return; }
          if (!Array.isArray(e.merge.ranges)) { done({ error: "병합 범위 목록이 올바르지 않습니다" }); return; }
          mergeRangeCount += e.merge.ranges.length;
          if (e.merge.ranges.length > 20000 || mergeRangeCount > 20000
            || e.merge.ranges.some((range) => typeof range !== "string" || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(range))) {
            done({ error: "병합 범위가 올바르지 않거나 너무 많습니다" }); return;
          }
          continue;
        }
        // 열 폭·행 높이는 칸이 아니라 줄·열 자체를 가리키므로 위치 규칙이 다르다.
        if (e.layout) {
          if (!Number.isInteger(e.layout.i) || e.layout.i < 1 || !Number.isFinite(e.layout.px)) { done({ error: "폭·높이 값이 올바르지 않습니다" }); return; }
          continue;
        }
        // 행·열 삽입도 칸이 아니라 줄·열 자체를 가리킨다.
        if (e.insert) {
          if (typeof e.sheet !== "string") { done({ error: "삽입할 시트 이름이 올바르지 않습니다" }); return; }
          if (e.insert.axis !== "row" && e.insert.axis !== "col") { done({ error: "삽입 방향이 올바르지 않습니다" }); return; }
          if (!Number.isInteger(e.insert.at) || e.insert.at < 1) { done({ error: "삽입 위치가 올바르지 않습니다" }); return; }
          if (!Number.isInteger(e.insert.count) || e.insert.count < 1 || e.insert.count > 1000) { done({ error: "삽입 개수가 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.delete) {
          if (typeof e.sheet !== "string") { done({ error: "삭제할 시트 이름이 올바르지 않습니다" }); return; }
          if (e.delete.axis !== "row" && e.delete.axis !== "col") { done({ error: "삭제 방향이 올바르지 않습니다" }); return; }
          if (!Number.isInteger(e.delete.at) || e.delete.at < 1) { done({ error: "삭제 위치가 올바르지 않습니다" }); return; }
          if (!Number.isInteger(e.delete.count) || e.delete.count < 1 || e.delete.count > 1000) { done({ error: "삭제 개수가 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.freeze !== undefined) {
          if (typeof e.sheet !== "string") { done({ error: "고정할 시트 이름이 올바르지 않습니다" }); return; }
          if (e.freeze && (!Number.isInteger(e.freeze.x) || !Number.isInteger(e.freeze.y) || e.freeze.x < 0 || e.freeze.y < 0)) {
            done({ error: "고정 값이 올바르지 않습니다" }); return;
          }
          continue;
        }
        if (e.grid !== undefined) {
          if (typeof e.sheet !== "string") { done({ error: "시트 이름이 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.hidden !== undefined) {
          if (typeof e.sheet !== "string") { done({ error: "시트 이름이 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.newSheet !== undefined) continue;
        if (e.rename !== undefined) {
          if (typeof e.sheet !== "string" || typeof e.rename !== "string" || !e.rename.trim()) { done({ error: "이름이 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.duplicate) {
          if (typeof e.sheet !== "string") { done({ error: "시트 이름이 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.removeSheet) {
          if (typeof e.sheet !== "string") { done({ error: "시트 이름이 올바르지 않습니다" }); return; }
          continue;
        }
        if (e.dv) {
          if (typeof e.sheet !== "string" || typeof e.dv.range !== "string" || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(e.dv.range)
            || !Array.isArray(e.dv.values) || !e.dv.values.length || e.dv.values.some((v) => typeof v !== "string" || v.includes(",") || v.includes('"'))) {
            done({ error: "데이터 검증 값이 올바르지 않습니다" }); return;
          }
          continue;
        }
        if (e.note !== undefined) {
          if (typeof e.sheet !== "string" || !Number.isInteger(e.note.r) || !Number.isInteger(e.note.c) || e.note.r < 1 || e.note.c < 1) {
            done({ error: "메모 위치가 올바르지 않습니다" }); return;
          }
          continue;
        }
        if (e.image) {
          if (typeof e.sheet !== "string" || !Number.isInteger(e.image.r) || !Number.isInteger(e.image.c) || e.image.r < 1 || e.image.c < 1
            || typeof e.image.dataUrl !== "string" || !/^data:image\/(png|jpeg|gif);base64,/.test(e.image.dataUrl)
            || !["png", "jpeg", "gif"].includes(e.image.extension)) {
            done({ error: "이미지 정보가 올바르지 않습니다" }); return;
          }
          continue;
        }
        if (e.definedName) {
          if (typeof e.sheet !== "string" || typeof e.definedName.name !== "string" || !e.definedName.name.trim()
            || typeof e.definedName.range !== "string" || !/^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+$/.test(e.definedName.range)) {
            done({ error: "이름 범위 정보가 올바르지 않습니다" }); return;
          }
          continue;
        }
        if (e.removeDefinedName) {
          if (typeof e.removeDefinedName.name !== "string" || typeof e.removeDefinedName.range !== "string") {
            done({ error: "이름 범위 정보가 올바르지 않습니다" }); return;
          }
          continue;
        }
        if (!Number.isInteger(e.r) || !Number.isInteger(e.c) || e.r < 1 || e.c < 1) { done({ error: "칸 위치가 올바르지 않습니다" }); return; }
      }
      const n = await writeSheet(p, edits);
      done({ saved: n });
      recompute(); // git 상태 갱신 트리거
    } catch (e) {
      done({ error: String((e && e.message) || e) });
    }
  });
}


