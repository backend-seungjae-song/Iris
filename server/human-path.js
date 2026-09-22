// 사람 경로 게이트. 확인은 사용자가 실제로 거치는 경로로만 한다.
//
// 주소를 직접 입력해 결과 화면으로 건너뛰거나 JS로 버튼을 눌러 놓고 확인했다고 기록하면,
// 사용자가 실제로 거치는 경로를 확인한 것이 아니라서 실제로는 동작하지 않는 경우가 생긴다.
// 문서 규칙만으로는 지켜지지 않으므로 도구 계층에서 막는다.
//
// 게이트는 서버의 명령 경로 한 곳에서만 호출한다. MCP·CLI·계획 러너가 모두 그 경로를 지나기 때문이다.
// 두 곳에 두면 한쪽만 수정돼 우회된다. 판정에 필요한 값은 인자와 그 탭의 현재 주소뿐이라
// 순수 함수로 두고, 앱 없이 검사할 수 있다(bin/smoke.mjs가 실제로 실행한다).

// 첫 진입은 주소로 이동한다. 사용자도 새 사이트는 주소를 입력한다. 빈 탭은 아직 어떤 페이지도 아니다.
const BLANK_URL_RE = /^(?:about:|chrome:|chrome-extension:|data:|file:|$)/i;
const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return null; } };

// eval은 읽기 도구다. 클릭·입력·이동에는 전용 도구가 있고, 그 도구만 사용자의 조작과
// 같은 이벤트를 만든다(포커스·hover·키·기본동작·가려짐 판정). JS로 호출한 .click()은 그중
// 아무것도 거치지 않아, 실제로는 눌리지 않는 버튼도 눌린 것처럼 통과한다.
// 상태 시드(localStorage·document.cookie)는 페이지 조작이 아니라 사전 준비라 여기 없다.
export const EVAL_WRITE = [
  [/\.\s*click\s*\(/, "browser_click"],
  [/\.\s*dblclick\s*\(/, "browser_dblclick"],
  [/\.\s*dispatchEvent\s*\(/, "그 조작에 맞는 도구(click·fill·key)"],
  [/\.\s*(?:submit|requestSubmit)\s*\(/, "폼의 제출 버튼을 browser_click"],
  [/\.\s*(?:value|checked|selectedIndex)\s*=(?!=)/, "browser_fill · browser_select"],
  [/\.\s*(?:innerHTML|outerHTML|innerText|textContent)\s*=(?!=)/, "실제 조작 도구"],
  [/\.\s*(?:setAttribute|removeAttribute)\s*\(/, "실제 조작 도구"],
  [/\.\s*focus\s*\(/, "browser_click"],
  [/(?:^|[^.\w$])location\s*(?:=(?!=)|\.\s*(?:href|assign|replace)\s*(?:=(?!=)|\())/, "화면의 링크를 browser_click"],
  [/(?:^|[^.\w$])(?:history|location)\s*\.\s*(?:pushState|replaceState|reload|go|back|forward)\s*\(/, "browser_history"],
  [/(?:^|[^.\w$])window\s*\.\s*open\s*\(/, "browser_new_tab"],
  [/\.\s*classList\s*\.\s*(?:add|remove|toggle|replace)\s*\(/, "실제 조작 도구"],
  [/\.\s*(?:append|appendChild|prepend|insertBefore|insertAdjacentHTML|replaceWith|removeChild|remove)\s*\(/, "실제 조작 도구"],
  [/\.\s*scrollIntoView\s*\(/, "browser_scroll"],
  // 위 목록은 자주 쓰는 패턴에 더 정확한 안내를 붙이려고 앞에 둔 것이고, 실제 경계는 이 줄이다.
  // 속성에 값을 넣는 것은 모두 쓰기다(.title·.src·.style.display·.dataset.x…). 이름을 하나씩
  // 나열해 막으면 나열하지 않은 이름으로 우회된다(확인 결과: document.title이 통과했다).
  // 읽기에는 `=`가 없다. `==`·`===`·`=>`는 대입이 아니므로 뒤를 보고 걸러낸다.
  [/\.\s*[A-Za-z_$][\w$]*\s*=(?![=>])/, "browser_fill · browser_select · browser_click"],
];

// 차단 사유는 표현식의 어느 부분 때문인지까지 알린다. 그러지 않으면 같은 표현식을 조금 바꿔 다시 보낸다.
export function evalWriteHit(src) {
  for (const [re, alt] of EVAL_WRITE) {
    const m = re.exec(String(src || ""));
    if (m) return { snippet: String(m[0]).trim(), alt };
  }
  return null;
}

// 막을 이유를 문장으로 돌려준다(null이면 통과). 여기서 막힌 명령은 실행기로 나가지 않는다.
// currentUrl은 그 명령이 나갈 탭이 지금 띄우고 있는 주소다.
export function humanPathDeny(cmd, args, currentUrl) {
  const a = args || {};
  if (cmd === "eval") {
    const hit = evalWriteHit(a.expression);
    if (!hit) return null;
    return `eval은 읽기 전용입니다 — 페이지를 조작하는 표현식(\`${hit.snippet}\`)은 실행하지 않습니다. `
      + `${hit.alt}(으)로 사람이 하듯 조작하세요. JS로 부른 조작은 포커스·hover·키·기본동작·가려짐 판정을 `
      + `모두 건너뛰기 때문에, 실제로는 눌리지 않는 버튼도 눌린 것처럼 통과합니다. 값을 읽거나 세는 eval은 그대로 됩니다.`;
  }
  if (cmd === "goto") {
    // 그 경로 자체가 확인 대상이 아닐 때(딥링크·리다이렉트·로그인 후 복귀 확인)는 이유를 적고 진행한다.
    // 이유는 회차 기록에 남아, 보고서를 읽는 사람이 클릭으로 이동한 경로가 아님을 알 수 있다.
    if (a.reason) return null;
    if (a.entry) return null;                                   // browser_new_tab이 여는 진입 주소(내부 호출)
    if (BLANK_URL_RE.test(String(currentUrl || ""))) return null;   // 빈 탭 → 첫 진입
    const from = originOf(currentUrl), to = originOf(a.url);
    if (!from || !to || from !== to) return null;               // 다른 사이트로 이동하는 것은 사용자도 주소로 한다
    // 현재 주소를 다시 호출하는 것은 이동이 아니라 새로고침이다. 그것까지 막으면
    // 새로고침할 방법이 없어 보여 같은 주소로 새 탭을 만드는 우회가 생기므로, 대신 방법을 안내한다.
    const same = String(currentUrl || "").split("#")[0] === String(a.url || "").split("#")[0];
    return `같은 사이트(${from}) 안을 주소로 건너뛰지 않습니다 — 지금 화면에서 눌러서 가세요. `
      + (same ? `지금 이 페이지를 그대로 다시 부르려던 것이면 browser_history {action:"reload"}를 쓰세요(browser_new_tab이나 같은 주소 goto는 새로고침이 아닙니다). ` : "")
      + `browser_snapshot으로 무엇이 있는지 보고 그 링크·버튼을 browser_click 하면 됩니다. `
      + `주소로 건너뛰면 그 사이의 화면·조건·오류가 확인되지 않아, "됐다"고 적은 것이 사람이 해보면 안 되는 경우가 남습니다. `
      + `그 경로 자체가 확인 대상이 아니라면 reason에 이유를 적어 다시 부르세요(그 사실이 회차 기록에 남습니다).`;
  }
  return null;
}
