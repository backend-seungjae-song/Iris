// 주소 끝 다듬기. 터미널 링크(xterm-wiring.js)와 대화 화면 링크(server/paseo-ui 빌드에 iris-url-token.js 로 복사)가 함께 씀
// - 의존 없는 순수 함수만. 대화 화면 빌드(Metro)에는 이 파일 하나만 복사됨

// 맨 주소 끝의 문장 부호와, 영문·숫자·기호 바로 뒤에 붙은 한글 어미·조사는 주소가 아님
// - 예: `…/devtools/입니다.` → `…/devtools/`
// - 한글 바로 뒤의 어미 글자는 남김: `/wiki/서울` 같은 한글 경로
export function terminalUrlToken(raw) {
  const END = /[.,;:!?…。、]+$/u;
  const KO = /([\x21-\x7e])(?:입니다|이에요|이라는|이라고|예요|이다|이고|이며|이면|라는|라고|인데|으로|에서|까지|부터|에게|처럼|보다|이나|라도|을|를|은|는|이|가|와|과|로|에|의|도|만)$/u;
  return String(raw || "").replace(END, "").replace(KO, "$1").replace(END, "");
}
