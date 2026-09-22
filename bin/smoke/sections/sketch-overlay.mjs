// 소유 범위: 스케치 오버레이의 헤더 배치. 맥 신호등이 놓이는 첫 줄과 도구가 놓이는 둘째 줄.
// 제공 API: 러너가 한 번 부르는 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구.
// 유지 조건: 계측기 자기시험을 먼저 둔다. 0건이 위반 없음인지 측정 실패인지 구분해야 한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/sketch-overlay.mjs
import { check, read } from "../core.mjs";

// 도구·굵기·색 버튼을 어느 줄에 배치하는가. 첫 줄(head)에 두면 신호등에 가려진다.
const TOOL_INTO_HEAD = /head\.appendChild\(b\)|head\.append\(widthWrap|head\.append\(colorWrap|head\.appendChild\(widthWrap\)|head\.appendChild\(colorWrap\)/;

export default async function run() {
  console.log("[스케치 오버레이 — 머리는 두 줄이다]");

  const js = read("web/js/browser/sketch-canvas.js");
  const css = read("web/css/32-sketch.css");

  check("계측기가 도구를 첫 줄에 붙이는 모양을 실제로 집어낸다", () => {
    if (!TOOL_INTO_HEAD.test("    head.appendChild(b);")) throw new Error("아는 위반을 못 잡는다");
    if (TOOL_INTO_HEAD.test("    bar.appendChild(b);")) throw new Error("둘째 줄에 붙이는 것까지 잡는다");
    return true;
  });

  check("머리는 두 줄이고 둘째 줄이 도구를 받는다", () => {
    if (!/head\.className = "sk-head"/.test(js)) throw new Error("첫 줄(sk-head)이 없다");
    if (!/bar\.className = "sk-bar"/.test(js)) throw new Error("둘째 줄(sk-bar)이 없다");
    if (!/root\.append\(head, bar, scroll\)/.test(js)) throw new Error("두 줄이 이 순서로 서지 않는다");
    if (!/bar\.appendChild\(b\)/.test(js)) throw new Error("도구가 둘째 줄에 안 붙는다");
    if (TOOL_INTO_HEAD.test(js)) throw new Error("도구가 첫 줄에 붙는다 — 신호등에 깔린다");
    return true;
  });

  check("되돌리기·취소·보내기는 도구 줄에 선다", () => {
    if (!/bar\.append\(undo, cancel, send\)/.test(js)) throw new Error("셋이 도구 줄에 안 붙는다");
    if (/head\.append\(undo|head\.appendChild\((?:undo|cancel|send)\)/.test(js)) {
      throw new Error("신호등 줄에 버튼을 뒀다");
    }
    return true;
  });

  check("그림은 찌그러지지 않고 배율로 커지고 작아진다", () => {
    // 폭과 높이에 상한을 따로 걸면 높이만 잘려 세로로 눌린다. 크기는 배율 하나로 둘 다 정한다.
    const block = css.match(/\.sk-stage\s*\{([^}]*)\}/);
    if (!block) throw new Error(".sk-stage 규칙이 없다");
    if (/max-(?:width|height)/.test(block[1])) throw new Error("폭·높이 상한을 따로 건다 — 한쪽만 줄어 찌그러진다");
    if (/stage\.style\.aspectRatio/.test(js)) throw new Error("비율과 상한에 크기를 맡긴다");
    if (!/stage\.style\.width = `\$\{width \* scale\}px`/.test(js)) throw new Error("폭을 배율로 안 준다");
    if (!/stage\.style\.height = `\$\{height \* scale\}px`/.test(js)) throw new Error("높이를 같은 배율로 안 준다");
    if (!/scroll\.addEventListener\("wheel"/.test(js)) throw new Error("핀치·⌘휠 확대가 없다");
    if (!/bar\.appendChild\(zoomWrap\)/.test(js)) throw new Error("확대 버튼이 도구 줄에 없다");
    return true;
  });

  check("글자 도구는 획 목록으로 들어간다", () => {
    if (!/\{ id: "text", label: "글자"/.test(js)) throw new Error("글자 도구가 없다");
    // 획 목록에 들어가야 되돌리기·합치기가 같이 처리한다.
    if (!/strokes\.push\(\{ tool: "text"/.test(js)) throw new Error("확정한 글자를 획 목록에 안 넣는다");
    if (!/s\.tool === "text"[\s\S]{0,600}fillText/.test(js)) throw new Error("글자를 캔버스에 안 그린다");
    // 보내기 전에 입력 중인 글자를 확정하지 않으면 그림에서 빠진다.
    if (!/send\.addEventListener\("click", async \(\) => \{\s*commitText\(\)/.test(js)) throw new Error("보내기 전에 입력을 확정하지 않는다");
    return true;
  });

  check("도구는 얹으면 이름을 말한다", () => {
    if (!/b\.dataset\.tip = tip/.test(js)) throw new Error("안내를 직접 안 그린다");
    if (/b\.title = /.test(js)) throw new Error("OS 기본 title 로 되돌아갔다 — 이 오버레이에서는 안 뜬다");
    if (!/\.sk-bar \[data-tip\]:hover::after/.test(css)) throw new Error("얹었을 때 뜨는 규칙이 없다");
    return true;
  });

  check("첫 줄은 신호등이 앉는 자리를 비운다", () => {
    const block = css.match(/\.sk-head\s*\{([^}]*)\}/);
    if (!block) throw new Error(".sk-head 규칙이 없다");
    const left = block[1].match(/padding:[^;]*\s(\d+)px;/);
    if (!left) throw new Error("왼쪽 여백을 못 읽는다");
    // 신호등 셋과 여백이 70px 안에 들어간다. 그보다 좁으면 첫 버튼이 가려진다.
    if (Number(left[1]) < 70) throw new Error(`왼쪽 여백이 ${left[1]}px — 신호등 자리를 못 비운다`);
    if (!/height:\s*30px/.test(block[1])) throw new Error("창의 드래그 스트립(30px)과 높이가 다르다");
    return true;
  });
}
