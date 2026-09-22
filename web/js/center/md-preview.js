// 마크다운 미리보기. 텍스트 탭의 다른 표시 형태다.
//
// 소유 범위
//   .md 파일을 열었을 때 막대에 표시되는 「원문 · 미리보기」 두 버튼과, 미리보기로 바꿨을 때
//   본문 대신 표시되는 영역. 그 영역의 클래스(.md-body)는 이 기능의 것이 아니다. 메모도 같은
//   이름으로 같은 모습을 그리므로 그 이름은 앱 셸이 정의하고(17-editor-bar.css) 여기서는 빌려 쓴다.
//
// 제공 API
//   initCapability(ctx): 훅 넷을 채운다.
//   mdpreview.barHtml(t): 막대에 넣을 버튼. 마크다운이 아니면 빈 문자열.
//   mdpreview.paneHtml(t): 미리보기 영역의 뼈대. 마크다운이 아니면 빈 문자열.
//   mdpreview.render(t, wrap): 미리보기로 그렸으면 true. 그때 텍스트 편집기는 감춘다.
//   mdpreview.click(target, t): 두 버튼 중 하나를 눌렀으면 true. 다시 그리는 것은 앱 셸이 한다.
//
// 의존 대상
//   ctx 의 $ 와 앱 셸의 mdToHtml(core/markdown.js). 탭 객체의 mdMode 필드에 현재 표시 형태를 적는다.
//
// 유지 조건
//   끄면 버튼도 영역도 없이 텍스트 편집기만 남아야 한다. 훅을 아무도 채우지 않으면 그렇게 된다.
//   미리보기는 저장하지 않은 편집(draft)을 우선해 그린다. 그러지 않으면 방금 입력한 내용이 보이지 않는다.
//   앱 셸이 mdToHtml 을 직접 호출하는 자리를 만들지 않는다. 그러면 기능을 끈 뒤에도 미리보기가 남는다.
//
// 영향 범위
//   훅 이름을 바꾸면 호출하는 쪽은 web/js/center/text-editor.js 하나다.
//   .md-body 의 모양을 바꾸면 같은 이름을 쓰는 메모의 미리보기도 함께 바뀐다.
import { provide } from "../core/hooks.js";
import { mdToHtml, isMarkdownExtension } from "../core/markdown.js";
// 확장자 판정은 앱 셸의 것을 그대로 쓴다. 여기서 다시 구현하면 점 없는 이름·숨김 파일에서 결과가 달라진다.
import { extOf } from "../explorer/tree.js";

const isMd = (t) => {
  const ext = extOf(String((t && t.path) || ""));
  return isMarkdownExtension(ext);
};

export function initCapability(ctx) {
  const { $ } = ctx;

  provide("mdpreview.barHtml", (t) => (isMd(t)
    ? `<button data-md="raw" class="${t.mdMode !== "preview" ? "on" : ""}">원문</button>`
      + `<button data-md="preview" class="${t.mdMode === "preview" ? "on" : ""}">미리보기</button>`
    : ""));

  provide("mdpreview.paneHtml", (t) => (isMd(t) ? `<div class="md-body" id="md-preview" hidden></div>` : ""));

  provide("mdpreview.render", (t, wrap) => {
    if (!isMd(t) || t.mdMode !== "preview") return false;
    const pv = $("#md-preview");
    if (!pv) return false;
    pv.hidden = false;
    // 저장하지 않은 편집이 있으면 그것을 그린다. 디스크 내용을 그리면 방금 입력한 내용이 보이지 않는다.
    pv.innerHTML = mdToHtml(t.draft != null ? t.draft : t.content);
    if (wrap) wrap.classList.add("hidden");
    return true;
  });

  // 현재 이 탭의 화면을 이 기능이 그리고 있는가. 외부에서 파일이 바뀌면 앱 셸이 이것을 확인하고
  // 맞으면 다시 그린다. 미리보기는 Monaco 모델이 아니라 자체 DOM 을 표시하므로, 모델만 교체하면
  // 화면이 이전 내용으로 남는다. 이 기능이 로드되지 않았으면 undefined 가 반환되고 false 와 같다.
  provide("mdpreview.presents", (t) => isMd(t) && t.mdMode === "preview");

  provide("mdpreview.click", (target, t) => {
    const md = target && target.closest && target.closest("[data-md]");
    if (!md) return false;
    t.mdMode = md.dataset.md;
    return true;
  });

  return {};
}
