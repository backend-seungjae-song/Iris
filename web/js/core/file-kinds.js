// 파일 종류 등록표. 어떤 경로를 누가 그리는지 각 기능이 스스로 등록한다.
//
// 소유 범위
//   등록 순서와 첫 일치 판정. 어떤 확장자가 무엇인지는 알지 않는다. 그것은 각 기능의 몫이다.
//
// 제공 API
//   registerFileKind(spec) · fileKindOf(path, tab) · fileKindIds() · clearFileKinds().
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않으므로 Node 에서 그대로 호출된다.
//
// 배경
//   가운데 탭이 확장자를 직접 알고 있었다. `.docx` 와 `.xlsx|.csv|…` 세 정규식이 앱 셸의 네 파일에
//   흩어져 있어, 새 뷰어(그림·PDF 등)를 추가하려면 파일 라우팅·탭 만들기·탭 닫기·텍스트
//   편집기를 함께 수정해야 했다. 기능마다 병렬로 작업할 수 없다는 뜻이다.
//   이제 앱 셸은 이 경로를 누가 맡는지만 조회한다. 아무도 맡지 않으면 텍스트 파일로 다룬다.
//
// spec 필드
//   id        : 문서 탭의 종류 이름. 브라우저 상태가 그대로 쓴다("docx"·"sheet").
//   test      : (path, tab) => boolean. 탭이 주어지면 그 탭의 상태를 먼저 본다.
//   tabKind   : 가운데 탭의 kind 값("docx" 면 docxview 에, 아니면 fileview 에 표시된다).
//   tabFlags  : 이 경로로 만든 탭에만 세울 플래그({ sheetMode:true } 같은 것).
//   tabFields : () => 그 뷰어가 쓰는 탭 필드의 기본값. 모든 파일 탭이 등록된 전부를 함께 갖는다.
//               필드의 유무로 탭 정체성 비교가 갈리면 안 되기 때문이다.
//   docIcon · docLabel : 브라우저 탭 줄과 지목 안내에 표시할 아이콘과 이름.
//   textForm  : (path) => boolean. 같은 파일을 텍스트로도 보여줄 수 있는가(csv·tsv).
//   read      : (path, tab) => 서버에 보낼 메시지. 세대 번호 같은 자체 상태는 여기서 처리한다.
//   discardReads : (path) => { text, data }. 「모두 취소」가 무엇을 다시 읽어야 하는가.
//   pending   : (tab) => boolean. 이 탭이 아직 내용을 받지 못했는가. 어느 필드가 비어 있으면
//               받지 못한 것인지는 그 뷰어만 안다. 앱 셸이 docxData·sheetError 같은 필드 이름을
//               알기 시작하면 새 뷰어마다 그 자리를 함께 고쳐야 한다.
//
// 유지 조건
//   같은 id 를 두 번 등록하지 않는다. 나중 것이 덮어쓰면 어느 뷰어가 그리는지 알 수 없다.
//   등록 순서가 곧 우선순위다. 먼저 등록한 것이 먼저 맡는다.
//   아무도 맡지 않는 경로에서 null 을 반환하는 것은 오류가 아니다. 기능을 끈 상태의 정상 동작이다.
//
// 영향 범위
//   center/{file-routing,tabs,tab-close,text-editor} 가 조회하고, viewer/boot.js 가 등록한다.
//   현재 목록 확인: node bin/importers.mjs web/js/core/file-kinds.js

const kinds = [];

export function registerFileKind(spec) {
  if (!spec || !spec.id || typeof spec.test !== "function") return false;
  if (kinds.some((k) => k.id === spec.id)) {
    try { console.error("[file-kinds] 이미 등록된 종류:", spec.id); } catch {}
    return false;
  }
  kinds.push(spec);
  return true;
}

// 탭을 함께 주면 그 탭의 현재 상태가 경로보다 우선한다. 같은 파일이라도 사용자가 표를
// 텍스트로 바꿔 보고 있을 수 있다.
export function fileKindOf(path, tab) {
  if (!path) return null;
  for (const k of kinds) { try { if (k.test(path, tab)) return k; } catch {} }
  return null;
}

// 아직 내용이 없어 다시 요청해야 하는가. 아무도 맡지 않는 경로는 텍스트 파일이라 content 만 본다.
export function tabNeedsContent(path, tab) {
  const kind = fileKindOf(path, tab);
  if (kind && typeof kind.pending === "function") { try { return !!kind.pending(tab); } catch { return false; } }
  return tab ? tab.content == null : false;
}

// 브라우저 상태에 저장되는 문서 탭의 종류가 곧 이 목록이다. 앱 셸이 "docx 이거나 sheet 이면"을
// 확인하던 다섯 자리가 이것을 조회하므로, 새 뷰어를 추가할 때 그 다섯을 함께 고치지 않아도 된다.
export function isFileKindId(id) { return kinds.some((k) => k.id === id); }
export function fileKindById(id) { return kinds.find((k) => k.id === id) || null; }
export function fileKinds() { return kinds.slice(); }

export function fileKindIds() { return kinds.map((k) => k.id); }
export function clearFileKinds() { kinds.length = 0; }
