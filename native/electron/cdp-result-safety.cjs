// CDP 결과 경계에서 자동 입력한 비밀번호를 가리는 상태 소유 모듈.
//
// 소유 범위
//   webContents ID별로 이 문서에 채운 secret 집합과 문자열·배열·객체를 재귀적으로 가리는 규칙.
//
// 제공 API
//   rememberSecret(wcId, secret) · redactSecrets(wcId, value) · forgetSecrets(wcId).
//   원시 Map이나 Set은 내주지 않는다.
//
// 의존 대상
//   다른 모듈이나 Electron에 기대지 않는다. 호출자가 안정된 탭 ID와 결과 값만 넘긴다.
//
// 유지 조건
//   기억한 비밀번호는 문자열이나 중첩 결과 어디에 있어도 가린다. 빈 값과 3자 미만 값은 기억하지
//   않고, navigation·destroy에서 forget한 뒤에는 다른 결과까지 지우지 않는다.
//
// 영향 범위
//   공급자는 cdp-control.cjs login 명령과 main.cjs의 navigation/destroy 수명주기이고, 양방향
//   소비자는 cdp-control.cjs의 모든 명령 결과 guard다. 느슨해지면 snapshot·text·eval·observe와
//   CLI·MCP 응답으로 자격증명 값이 노출된다.

const filledSecrets = new Map();

function rememberSecret(wcId, secret) {
  if (!secret || String(secret).length < 3) return;
  let s = filledSecrets.get(wcId); if (!s) { s = new Set(); filledSecrets.set(wcId, s); }
  s.add(String(secret));
}

function forgetSecrets(wcId) { filledSecrets.delete(wcId); }

function redactSecrets(wcId, value) {
  const s = filledSecrets.get(wcId); if (!s || !s.size) return value;
  const walk = (v) => {
    if (typeof v === "string") { let o = v; for (const sec of s) if (o.includes(sec)) o = o.split(sec).join("••••••••"); return o; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(value);
}

module.exports = { rememberSecret, forgetSecrets, redactSecrets };
