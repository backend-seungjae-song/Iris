// 소유 범위: 클라이언트 저장 수명. dirty 판정, 저장 중 재진입, 실패 뒤 상태.
// 제공 API: 이름 export runDocxBlock8Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-save-lifecycle.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT } from "../core.mjs";
import { aiTabs, capabilitySource, dock, docxPanel, fileRouting, httpHandler, tabClose, renderer } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5WasmInventory, docxConcurrentWriteProbe, docxDispatchedHandler, docxHookedFunction, docxMessageBranch, docxProvideBody, docxRenderBranch, docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe, docxWsHandler,
} from "./90-docx-block1.mjs";

export async function runDocxBlock8Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B8-")) return;
  console.log("\n[DOCX Block 8 RED] Client save lifecycle");
  const card = (id, name, fn) => { if (!selected || selected === `B8-${id}`) check(`[DOCX-B8-${id}] ${name}`, fn); };

  // dirty 판정은 앱 셸(center/tab-close)이 아니라 그 편집을 들고 있는 쪽이 한다.
  // 앱 셸은 이름을 호출하고 문서 쪽이 그 이름을 채운다. 그래서 앱 셸이 그 이름을 호출하는지와,
  // 그 이름을 채우는 함수가 아래 계약대로 판정하는지를 함께 확인한다.
  const frameDirty = docxSourceFunction(renderer, "isTabDirty");
  const isTabDirty = docxHookedFunction(renderer, "viewer.tabDirty", "docx");
  const saveTabForClose = docxSourceFunction(renderer, "saveTabForClose");
  const docxSaveTab = docxSourceFunction(renderer, "docxSaveTab");
  const docxBranch = docxWsHandler(renderer, "docx");

  card("T1", "isTabDirty가 docx 탭의 dirty를 getDocumentHandle().revision 비교와 영속 플래그 OR로 판정한다", () => {
    // stateVersion()은 커서 이동·줌에도 bump 되므로 dirty 판정에 쓰면 안 된다(core d.ts 확인).
    // getDocumentHandle().revision 비교여야 문서 내용 변경만 dirty 로 잡는다.
    // core 번들(chunk-5OSFUHGF.js 의 `rev=0` 으로 시작하는 세션 클래스, d.ts: "a mount from
    // bytes is a fresh session")에서 확인한 사실은, detach()~attach() 를 가로지르면 세션이 새로
    // 만들어져 revision 이 리셋된다는 것이다. detach 전 dirty 였던 탭도 attach 후에는
    // getDocumentHandle().revision 비교만으로 clean 으로 오판된다. 그래서 live 비교 하나로는
    // detach/attach 경계를 버티지 못하고, `t.docxDirty` 같은 영속 플래그가 OR 로 결합돼야 한다
    // (플래그는 detach 시점에 설정되고 저장 성공 시에만 해제된다).
    docxAssert(frameDirty && /callHook\(\s*["']viewer\.tabDirty["']/.test(frameDirty),
      "틀의 isTabDirty 가 뷰어에게 dirty 를 묻지 않음 — 물어보지 않으면 문서의 판정이 아무 데도 안 쓰인다");
    docxAssert(isTabDirty, "viewer.tabDirty 를 채우는 문서 쪽 함수를 찾지 못함");
    docxAssert(/docxMode/.test(isTabDirty), "그 함수에 docx 탭 분기가 없음");
    docxAssert(/getDocumentHandle\s*\(\s*\)\s*\.revision/.test(isTabDirty),
      "isTabDirty가 editor.getDocumentHandle().revision을 비교하지 않음");
    docxAssert(!/docxMode[\s\S]{0,200}stateVersion\s*\(/.test(isTabDirty) || /getDocumentHandle/.test(isTabDirty),
      "docx dirty 판정이 stateVersion()에 의존할 위험 — 커서 이동만으로 오탐 dirty 발생 가능");
    docxAssert(/t\.docxDirty\b/.test(isTabDirty),
      "isTabDirty가 t.docxDirty(영속 플래그)를 확인하지 않음 — detach/attach로 세션 revision이 리셋되면 live 비교만으로는 dirty를 잃어버림(P0)");
    return true;
  });

  card("T2", "docxSaveTab이 editor.save()로 바이트를 얻어 baselineRevision과 함께 docx.write를 보낸다", () => {
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    docxAssert(/\.save\s*\(\s*\)/.test(docxSaveTab), "editor.save() 호출이 없음(저장할 바이트를 얻는 유일한 공식 API)");
    docxAssert(/type\s*:\s*["']docx\.write["']/.test(docxSaveTab), "docx.write 요청을 보내지 않음");
    docxAssert(/baselineRevision/.test(docxSaveTab), "docx.write 요청에 baselineRevision이 없음");
    return true;
  });

  card("T3", "저장 시작 시점에 캡처한 handle revision을 저장 완료 후에도 그대로 써서 in-flight 편집을 지키지 않는 실수를 막는다", () => {
    // 저장 완료 후 다시 getDocumentHandle()을 새로 호출해 그 값을 baseline으로 삼으면, save()
    // 호출~응답 도착 사이에 사용자가 추가로 편집한 내용까지 "저장됨"으로 오판해 dirty가 잘못
    // 꺼진다. await 이전에 캡처한 변수를 그대로 재사용해야 "저장된 건 시작 시점 스냅샷뿐"이라는
    // 사실이 dirty 판정에 정확히 반영된다.
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    const firstAwait = docxSaveTab.search(/\bawait\b/);
    docxAssert(firstAwait > 0, "docxSaveTab에 await 지점이 없음(비동기 저장 흐름이 아님)");
    const beforeAwait = docxSaveTab.slice(0, firstAwait);
    const handleVarMatch = beforeAwait.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*getDocumentHandle\s*\(\s*\)\s*\.revision/);
    docxAssert(handleVarMatch, "await(저장 요청) 이전에 getDocumentHandle().revision을 캡처하는 코드가 없음 — 저장 시작 시점 스냅샷이 없음");
    const afterAwait = docxSaveTab.slice(firstAwait);
    docxAssert(new RegExp(`\\b${handleVarMatch[1]}\\b`).test(afterAwait),
      "저장 완료 후 저장 시작 시점에 캡처한 revision 변수를 재사용하지 않음 — in-flight 편집이 조용히 dirty=false로 지워질 위험");
    return true;
  });

  card("T4", "저장 성공 시 baselineRevision과 docxData가 함께 방금 전송한 bytes/revision으로 갱신된다", () => {
    // revision 만 갱신하고 docxData(재마운트 시 core 에 넘기는 원본 bytes)를 갱신하지 않으면,
    // 저장 성공 후 탭이 detach·재생성될 때 저장 전 bytes 로 다시 마운트되어 방금 저장한 내용이
    // 화면에서 사라진다. 디스크는 맞고 클라이언트 캐시만 오래된 상태다.
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    docxAssert(/resp\.revision|response\.revision|\.revision\b[\s\S]{0,80}=[\s\S]{0,20}(?:resp|response|m)\.revision/.test(docxSaveTab)
      || /\.revision\s*=\s*[A-Za-z_$][\w$]*\.revision/.test(docxSaveTab),
      "docx.write 성공 응답의 revision을 탭 상태에 반영하는 코드가 없음 — 다음 저장이 옛 baseline과 비교됨");
    docxAssert(/docxData\s*=/.test(docxSaveTab),
      "저장 성공 시 docxData를 전송한 bytes로 승격하지 않음 — 재마운트 시 저장 전 내용으로 되돌아갈 위험");
    return true;
  });

  card("T5", "docx.write 실패 시 conflict:true와 그 외 오류가 서로 다른 사용자 메시지로 분기한다", () => {
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    docxAssert(/\.conflict\b/.test(docxSaveTab), "docxSaveTab이 응답의 conflict 필드를 확인하지 않음");
    const conflictAt = docxSaveTab.search(/\.conflict\b/);
    const around = docxSaveTab.slice(Math.max(0, conflictAt - 200), conflictAt + 400);
    docxAssert(/showToast\s*\(|showBanner\s*\(|docxBanner/.test(around),
      "conflict 분기 근처에 사용자 대면 메시지 호출이 없음");
    return true;
  });

  card("T6", "외부 변경(watch) 도착 시 dirty한 docx 탭의 editor를 파괴·재생성하지 않고 보존한다", () => {
    docxAssert(docxBranch, "m.type === \"docx\" 메시지 분기를 찾지 못함");
    docxAssert(/reason\s*===?\s*["']watch["']/.test(docxBranch),
      "docx 메시지 분기가 reason(watch/open/reload)을 구분하지 않음 — file/sheet 분기와 다른 취급");
    const watchAt = docxBranch.search(/reason\s*===?\s*["']watch["']/);
    const watchBlock = docxBranch.slice(watchAt, watchAt + 900);
    docxAssert(/isTabDirty\s*\(|isDocxTabDirty\s*\(/.test(watchBlock),
      "watch 도착 시 dirty 여부를 확인하는 코드가 없음 — 무조건 최신 바이트로 덮어쓸 위험(원래 버그)");
    const dirtyGuardAt = watchBlock.search(/isTabDirty\s*\(|isDocxTabDirty\s*\(/);
    const guardedBlock = watchBlock.slice(dirtyGuardAt, dirtyGuardAt + 500);
    docxAssert(!/cleanupDocxRender\s*\(/.test(guardedBlock) && !/createDocxEditor\s*\(/.test(guardedBlock),
      "dirty 분기 안에서 cleanupDocxRender/createDocxEditor를 호출함 — 편집 중인 editor를 파괴·재생성함(Block 6 T8 destroy 계약과 충돌)");
    return true;
  });

  card("T7", "dirty 상태에서 도착한 외부 변경은 즉시 반영되지 않고 대기 데이터로만 보관되며 baselineRevision을 오염시키지 않는다", () => {
    // dirty watch 응답의 revision 을 docxRevision(서버 baseline)에 반영하면, Block 7 의
    // baselineRevision 비교가 최신 baseline 으로 오인해 다음 저장이 외부 변경을 conflict 없이
    // 덮어쓴다. 서버 충돌 검사 자체가 무력해진다. docxRevision 은 저장·최초 로드 시점 baseline
    // 그대로 유지하고, 외부 변경 revision 은 docxDiskRevision 에만 담아야 한다.
    docxAssert(docxBranch, "m.type === \"docx\" 메시지 분기를 찾지 못함");
    docxAssert(/docxDiskData|docxDiskRevision/.test(docxBranch),
      "dirty 상태의 외부 변경을 보관할 대기 필드(docxDiskData/docxDiskRevision류)가 없음 — applyExternalChange의 diskContent 패턴과 다르게 데이터를 버릴 위험");
    const watchAt = docxBranch.search(/reason\s*===?\s*["']watch["']/);
    const dirtyGuardAt = watchAt >= 0 ? docxBranch.slice(watchAt).search(/isTabDirty\s*\(|isDocxTabDirty\s*\(/) : -1;
    docxAssert(dirtyGuardAt >= 0, "watch+dirty 분기를 찾지 못해 baselineRevision 오염 여부를 확인할 수 없음");
    const dirtyBlock = docxBranch.slice(watchAt + dirtyGuardAt, watchAt + dirtyGuardAt + 500);
    docxAssert(!/\bdocxRevision\s*=/.test(dirtyBlock),
      "dirty 상태의 외부 변경 처리에서 docxRevision(서버 baseline)을 새 값으로 덮어씀 — 다음 저장이 baselineRevision 비교를 통과해 외부 변경을 조용히 덮어쓸 위험(서버 충돌 검사 무력화)");
    return true;
  });

  card("T8", "dirty 없는 docx 탭에 온 외부 변경(watch)은 기존처럼 자동 반영된다(회귀 방지)", () => {
    docxAssert(docxBranch, "m.type === \"docx\" 메시지 분기를 찾지 못함");
    docxAssert(/docxData\s*=\s*m\.data/.test(docxBranch),
      "clean 탭에 대한 외부 변경 자동 반영 경로가 사라짐 — Block 8이 Block 1/6의 기존 열람 동작을 깨뜨림");
    return true;
  });

  card("T9", "명시적 open/reload(reason이 watch가 아님) 응답은 기존과 동일하게 항상 적용된다(회귀 방지)", () => {
    docxAssert(docxBranch, "m.type === \"docx\" 메시지 분기를 찾지 못함");
    const watchAt = docxBranch.search(/reason\s*===?\s*["']watch["']/);
    docxAssert(watchAt < 0 || docxBranch.slice(0, watchAt).length < docxBranch.length,
      "watch 분기가 파일 전체를 감싸 open/reload 응답까지 dirty 게이트를 타게 만들었을 위험 — watch는 별도 분기여야 함");
    return true;
  });

  card("T10", "탭 닫기 확인창(closeTabs)의 저장 흐름이 docx 탭도 처리한다", () => {
    docxAssert(saveTabForClose, "saveTabForClose 함수를 찾지 못함");
    docxAssert(/callHook\(\s*["']viewer\.saveTab["']/.test(saveTabForClose),
      "닫기 저장이 뷰어에게 저장을 맡기지 않음 — 물어보지 않으면 docx 탭이 저장 없이 닫힌다");
    docxAssert(docxHookedFunction(renderer, "viewer.saveTab", "docx"),
      "viewer.saveTab 을 채우는 문서 쪽 저장 함수를 찾지 못함");
    return true;
  });

  card("T11", "docxSaveTab은 기존 _saveInFlight 단일비행 관례를 재사용한다(중복 저장 방지)", () => {
    // 단순 boolean guard(docxSaving=true/false)만으로는 두 번째 호출자가 첫 저장의 완료를
    // 기다릴 수 없다. closeTabs 가 저장을 기다렸다 닫으려 해도 "이미 저장 중"이라 무시되면 탭이
    // 닫히지 않는다. saveFileTab(text)·svSave(sheet)가 쓰는 t._saveInFlight(첫 호출이 Promise 를
    // 만들어 저장하고 이후 호출은 그 Promise 를 반환) 패턴을 docx 도 따라야 여러 호출자(저장
    // 버튼·Cmd+S·닫기 확인창)가 같은 저장을 공유할 수 있다.
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    docxAssert(/t\._saveInFlight/.test(docxSaveTab),
      "docxSaveTab이 t._saveInFlight를 쓰지 않음 — saveFileTab/svSave와 다른 단일비행 메커니즘을 새로 발명했거나 아예 없을 위험");
    docxAssert(/if\s*\(\s*t\._saveInFlight\s*\)\s*return\s+t\._saveInFlight/.test(docxSaveTab),
      "docxSaveTab 시작부에 이미 진행 중인 저장을 그대로 반환하는 가드가 없음 — 중복 docx.write 발생 위험");
    return true;
  });

  card("T12", "저장 버튼/단축키(saveActiveFile)가 docx 탭에서 docxSaveTab을 호출한다", () => {
    // 저장 트리거(Cmd+S·저장 버튼)도 함께 검사한다. docxSaveTab 이 옳아도 아무 데서도 호출되지
    // 않으면 기능이 없는 것과 같다.
    const saveActiveFile = docxSourceFunction(renderer, "saveActiveFile");
    docxAssert(saveActiveFile, "saveActiveFile 함수를 찾지 못함");
    docxAssert(/callHook\(\s*["']viewer\.saveTab["']/.test(saveActiveFile),
      "Cmd+S 가 뷰어에게 저장을 맡기지 않음 — 물어보지 않으면 docx 탭에서 아무 일도 안 난다");
    docxAssert(docxHookedFunction(renderer, "viewer.saveTab", "docx"),
      "viewer.saveTab 을 채우는 문서 쪽 저장 함수를 찾지 못함");
    return true;
  });

  card("T13", "dirty한 docx 탭에서 다른 탭으로 전환해도 편집 중인 editor가 파괴되지 않는다", () => {
    // withFileViewTransition 이 탭 전환마다 cleanupDocxRender(→editor.destroy())를 호출한다.
    // destroy()는 attach 시 세션을 복원하는 detach()와 달리 내용을 stash 하지 않는 영구
    // 파괴라서, dirty 한 docx 탭에서 다른 탭을 클릭하기만 해도 저장하지 않은 편집이 사라진다.
    // design.md 의 "탭 이동 시 경고"가 이 시나리오를 가리키는데, closeTabs 확인창은 탭 닫기에만
    // 걸리고 전환은 거치지 않아 보호되지 않는다.
    // 수정 방향은 UI 경고 추가가 아니라 올바른 core API 사용이다. 전환 시 destroy 대신
    // detach()로 바이트를 보존하고, 그 탭으로 돌아오면 새 editor 를 만들지 않고 attach()로
    // 복원한다(core d.ts: "Tear down the painted surface, stashing the CURRENT document
    // bytes... attach() restores the content"). text/sheet 탭이 전환 시 경고 없이 내용을
    // 보존하는 기존 UX 와도 일관된다.
    // 내려가는 탭 정리는 앱 셸에서 분리됐다. 앱 셸은 이름을 호출하고(viewer.leaveTab) 그
    // 편집기를 만든 쪽이 무엇을 보존하고 무엇을 버릴지 정한다. 앱 셸이 이름을 호출하는지와 그
    // 이름을 채운 쪽이 실제로 detach 하는지를 양쪽에서 확인한다. 한쪽만 보면 다른 쪽이 빠져도
    // 통과한다.
    const transition = docxSourceFunction(renderer, "withFileViewTransition");
    docxAssert(transition, "withFileViewTransition 함수를 찾지 못함");
    docxAssert(/callHook\(\s*["']viewer\.leaveTab["']/.test(transition),
      "탭 전환이 내려가는 탭의 정리를 뷰어에게 맡기지 않음 — 틀이 다시 편집기를 직접 부순다");
    // 이 이름은 별도 함수 없이 그 자리에서 동작하므로 몸통 자체가 검사 대상이다.
    const leave = docxProvideBody(capabilitySource("viewer"), "viewer.leaveTab");
    docxAssert(leave, "viewer.leaveTab 이름을 채우는 쪽을 찾지 못함");
    docxAssert(/\.detach\s*\(\s*\)/.test(leave),
      "탭 전환 시 dirty한 docx editor를 detach()로 보존하는 경로가 없음 — destroy만 있으면 전환 시 편집 내용이 파괴됨");
    // detach() 직전에 t.docxDirty=true 를 설정해야 한다. 그러지 않으면 detach~attach 경계에서
    // 세션 revision 이 리셋돼(T1 참조) dirty 정보가 사라진다.
    const detachAt = leave.search(/\.detach\s*\(\s*\)/);
    docxAssert(detachAt >= 0, "detach() 호출을 찾지 못해 순서를 확인할 수 없음");
    const beforeDetach = leave.slice(Math.max(0, detachAt - 300), detachAt);
    docxAssert(/docxDirty\s*=\s*true/.test(beforeDetach),
      "detach() 직전에 t.docxDirty=true를 세팅하지 않음 — detach 후 세션 revision 리셋으로 dirty 정보가 소실됨(P0)");
    return true;
  });

  card("T15", "attach 재사용 후 docxHandleRevision을 새 세션의 현재 값으로 재캡처한다", () => {
    // attach()는 항상 fresh session 이라 이전 세션의 revision 연속성이 없다(core 번들의 rev=0
    // 코드 확인). 재부착 직후 새 세션의 현재 getDocumentHandle().revision 을
    // docxHandleRevision 으로 다시 캡처해야 그 다음부터의 live 비교(T1 의 두 번째 항)가 새 세션
    // 기준으로 정확해진다. 영속 docxDirty 플래그와 별개로 재부착 이후 추가 편집을 감지하는 데
    // 필요하다.
    const render = docxSourceFunction(docxPanel, "renderDocxContent") || docxSourceFunction(renderer, "renderFileViewBody");
    docxAssert(render, "renderDocxContent/renderFileViewBody 함수를 찾지 못함");
    docxAssert(/\.attach\s*\(/.test(render), "attach() 재사용 분기를 찾지 못함");
    const attachAt = render.search(/\.attach\s*\(/);
    const afterAttach = render.slice(attachAt, attachAt + 400);
    docxAssert(/docxHandleRevision\s*=[\s\S]{0,120}getDocumentHandle\s*\(\s*\)\s*\.revision/.test(afterAttach),
      "attach() 직후 docxHandleRevision을 새 세션 값으로 재캡처하지 않음 — 재부착 이후 추가 편집이 live 비교로 감지되지 않을 위험");
    return true;
  });

  card("T16", "저장 성공 시 영속 dirty 플래그(t.docxDirty)도 함께 해제된다", () => {
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    docxAssert(/docxDirty\s*=\s*false/.test(docxSaveTab),
      "저장 성공 경로가 t.docxDirty를 false로 해제하지 않음 — 저장 후에도 영속 플래그 때문에 계속 dirty로 남을 위험(반대 방향 버그)");
    return true;
  });

  card("T17", "비활성 탭에 새 서버 데이터가 반영될 때 그 탭이 들고 있던 stale detached editor를 무효화한다", () => {
    // 비활성(전환으로 detach 된) 탭에 clean-watch 또는 non-watch 응답이 도착해
    // docxData/docxRevision 을 새로 반영해도, 그 탭이 들고 있던 detached t.docxEditor 를 그대로
    // 두면 그 탭으로 돌아왔을 때 attach 재사용 분기가 새 데이터가 아니라 오래된 editor 를 다시
    // 붙여 서버에서 받은 최신 내용이 무시된다.
    docxAssert(docxBranch, "m.type === \"docx\" 메시지 분기를 찾지 못함");
    // 그리고 있는 탭의 소유자는 질의로 확인한다(getRenderedFileOwner). 소문자로 시작하는 이름
    // 때문에 대소문자를 가리지 않고 찾는다. 또 "어딘가에 그 이름이 있다"로는 부족하다. 이
    // 함수는 아래에서도 같은 이름을 호출하므로, 비활성 판정을 지워도 그 패턴은 남는다(변이로
    // 확인). 그래서 파괴하는 위치 바로 앞에서 "지금 그리는 탭이 아니다"를 확인하는지 검사한다.
    const killAt = docxBranch.search(/docxEditor\.destroy\s*\(\s*\)|cleanupDocxRender\s*\(\s*target\s*\)/);
    docxAssert(killAt >= 0,
      "비활성 탭에 새 데이터 반영 시 stale detached editor를 destroy/정리하는 코드가 없음 — 복귀 시 옛 내용이 다시 마운트될 위험");
    const beforeKill = docxBranch.slice(Math.max(0, killAt - 200), killAt);
    docxAssert(/!==[\s\S]{0,60}renderedFileOwner/i.test(beforeKill),
      "stale editor를 지우기 전에 그 탭이 지금 그리는 탭이 아닌지 묻지 않음 — 보고 있는 탭의 편집기를 지울 위험");
    return true;
  });

  card("T18", "저장 완료 시점에 editor가 이미 교체됐으면(stale) close 흐름이 성공으로 오인하지 않도록 명시적으로 실패시킨다", () => {
    // stale 완료를 조용히 undefined로 resolve하면
    // Promise.allSettled 기반 closeTabs가 이를 "성공"으로 집계해, 실제로는 아무것도 저장되지
    // 않았는데 탭이 닫힐 위험 경로가 생긴다. stale이면 명시적으로 throw(reject)해야 한다.
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    const firstAwait = docxSaveTab.search(/\bawait\b/);
    const editorVarMatch = docxSaveTab.slice(0, Math.max(0, firstAwait)).match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*t\.docxEditor\b/);
    docxAssert(editorVarMatch, "await 이전에 t.docxEditor 참조를 캡처하는 코드가 없음");
    const afterAwait = docxSaveTab.slice(Math.max(0, firstAwait));
    // 직접 비교(t.docxEditor !== var)든 간접(const isCurrent = t.docxEditor === var; if
    // (!isCurrent))든 스타일은 구현 자유다. 비교 자체의 존재를 확인한 뒤, 그 지점부터 먼저
    // 등장하는 종료 키워드가 return 이 아니라 throw 여야 한다. "함수 어딘가에 throw 가 있다"만
    // 보면 resp.error 처리부의 무관한 throw 때문에 잘못된 통과가 난다.
    const staleCheckAt = afterAwait.search(new RegExp(`t\\.docxEditor\\s*===?\\s*${editorVarMatch[1]}|${editorVarMatch[1]}\\s*===?\\s*t\\.docxEditor`));
    docxAssert(staleCheckAt >= 0, "저장 완료 후 editor 교체(stale) 여부를 확인하는 코드가 없음");
    const afterCompare = afterAwait.slice(staleCheckAt);
    const firstReturn = afterCompare.search(/\breturn\b/);
    const firstThrow = afterCompare.search(/\bthrow\b/);
    docxAssert(firstThrow >= 0 && (firstReturn < 0 || firstThrow < firstReturn),
      "stale 완료 분기가 throw보다 먼저(또는 대신) return함 — Promise.allSettled 기반 close 흐름이 조용한 undefined resolve를 성공으로 오인할 위험");
    return true;
  });

  card("T19", "툴바/메뉴의 file.save(저장) 슬롯 클릭이 실제로 docxSaveTab을 호출한다", () => {
    // core d.ts 상 file.save 는 kind:'save' 라 runToolbarCommand 범용 dispatch 로는 동작하지
    // 않는다. d.ts 는 save 가 command 가 아니라 Editor.save() 직접 호출이라고 적고 별도로
    // declare function runSave(editor) 를 둔다. Block 6 가 image.insert/table.insert/text.link 에 쓴 것과 같은
    // docxRunSpecialChromeSlot 특수 슬롯 패턴을 file.save 에도 적용해야 화면의 저장 버튼이
    // 동작한다.
    const special = docxSourceFunction(renderer, "docxRunSpecialChromeSlot");
    docxAssert(special, "docxRunSpecialChromeSlot 함수를 찾지 못함(Block 6 산출물)");
    docxAssert(/["']file\.save["']/.test(special), "docxRunSpecialChromeSlot이 file.save 슬롯을 처리하지 않음 — 저장 버튼이 죽어있음");
    const saveAt = special.search(/["']file\.save["']/);
    const saveBlock = special.slice(saveAt, saveAt + 200);
    docxAssert(/docxSaveTab\s*\(/.test(saveBlock), "file.save 분기가 docxSaveTab을 호출하지 않음");
    return true;
  });

  card("T14", "저장 완료 처리는 그 사이 editor가 교체되지 않았는지 확인한 뒤에만 탭 상태를 갱신한다", () => {
    // docxGeneration 은 read/mount freshness 토큰이지 저장 완료 검증용이 아니다(watch 요청
    // 발신만으로도 bump 되지만 dirty 면 editor 는 유지되므로, generation 변화만으로 저장을
    // 무효화하면 정상 저장도 취소될 수 있다). 저장이 시작된 editor 참조(또는 동급 식별자)를
    // 캡처해 두고, 응답 처리 시점에 t.docxEditor 가 여전히 그 참조와 같은지 확인한 뒤에만
    // docxRevision/docxData/docxHandleRevision 을 갱신한다. 그 사이 탭이 재로드돼 새 editor 로
    // 교체됐으면 오래된 응답은 버려야 새 editor 의 상태가 오염되지 않는다.
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    const firstAwait = docxSaveTab.search(/\bawait\b/);
    const beforeAwait = docxSaveTab.slice(0, Math.max(0, firstAwait));
    const editorVarMatch = beforeAwait.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*t\.docxEditor\b/);
    docxAssert(editorVarMatch, "await(저장 요청) 이전에 t.docxEditor 참조를 캡처하는 코드가 없음 — 완료 시점 stale 여부를 확인할 방법이 없음");
    const afterAwait = docxSaveTab.slice(Math.max(0, firstAwait));
    docxAssert(new RegExp(`t\\.docxEditor\\s*===?\\s*${editorVarMatch[1]}|${editorVarMatch[1]}\\s*===?\\s*t\\.docxEditor`).test(afterAwait),
      "저장 완료 후 t.docxEditor가 저장 시작 시점 캡처와 같은지 확인하지 않음 — 그 사이 editor가 교체됐으면 stale 응답이 새 editor 상태를 오염시킬 위험");
    return true;
  });

  card("T20", "editor의 change 이벤트가 탭 dirty 표시를 즉시(다음 무관한 재렌더를 기다리지 않고) 갱신한다", () => {
    // docxRefreshChrome(t)는 툴바 슬롯만 갱신하고 tabstrip 을 건드리지 않는다. renderTabs()는
    // 탭 전환 같은 다른 조작이 있어야 다시 호출되므로, 그전까지는 isTabDirty(t)가 true 여도 탭
    // 앞 점(.cdirty)이 타이핑 직후에 나타나지 않는다. 텍스트·시트 탭은 markFileDirty 가
    // markTabDirty(t.id, d)로 그 탭 하나만 즉시 갱신하므로, docx 도 change 핸들러 안에서 같은
    // 함수를 호출해야 renderTabs() 전체 재렌더 없이 즉시 반영된다.
    const renderDocxContent = docxSourceFunction(docxPanel, "renderDocxContent");
    docxAssert(renderDocxContent, "renderDocxContent 함수를 찾지 못함");
    const changeAt = renderDocxContent.search(/editor\.on\s*\(\s*["']change["']/);
    docxAssert(changeAt >= 0, "editor.on(\"change\", ...) 구독이 없음");
    const changeBlock = renderDocxContent.slice(changeAt, changeAt + 400);
    docxAssert(/markTabDirty\s*\(\s*t\.id\s*,\s*isTabDirty\s*\(\s*t\s*\)\s*\)/.test(changeBlock),
      "change 핸들러가 markTabDirty(t.id, isTabDirty(t))를 호출하지 않음 — dirty 표시가 타이핑 직후가 아니라 다음 무관한 탭 재렌더까지 지연됨");
    return true;
  });

  card("T21", "저장 성공 직후 탭 dirty 표시도 즉시(다음 무관한 재렌더를 기다리지 않고) 사라진다", () => {
    // docxSaveTab 성공 경로가 t.docxDirty=false 만 설정하고 tabstrip DOM 을 건드리지 않으면,
    // isTabDirty(t)가 false 로 돌아섰는데도 탭 앞 점(.cdirty)이 저장 직후 화면에 남는다.
    // T20 과 대칭인 결함이라 켜질 때뿐 아니라 꺼질 때도 즉시 반영돼야 한다.
    docxAssert(docxSaveTab, "docxSaveTab 함수가 없음");
    const dirtyFlagAt = docxSaveTab.search(/t\.docxDirty\s*=\s*false/);
    docxAssert(dirtyFlagAt >= 0, "docxSaveTab 성공 경로에 t.docxDirty = false가 없음");
    // 창을 400 으로 넓힌다. 저장 성공 경로에 docxSavedHash 기준선 갱신이 t.docxDirty=false 와
    // markTabDirty 호출 사이에 들어가 200 으로는 markTabDirty 를 잡지 못한다. markTabDirty
    // 호출 자체를 옮기거나 뺀 것은 아니다.
    const afterFlag = docxSaveTab.slice(dirtyFlagAt, dirtyFlagAt + 400);
    docxAssert(/markTabDirty\s*\(\s*t\.id\s*,\s*isTabDirty\s*\(\s*t\s*\)\s*\)/.test(afterFlag),
      "저장 성공 직후 markTabDirty(t.id, isTabDirty(t))를 호출하지 않음 — 저장해도 dirty 점이 다음 무관한 탭 재렌더까지 남아있음");
    return true;
  });

}


export default async function run() {
  await runDocxBlock8Checks();
}
