// 이 주소가 로컬인가를 정하는 유일한 자리.
//
// 한 곳에 둔 이유: 이 판정에 두 가지가 달려 있다. 대량 기입을 바로 허용할지(되돌릴 수 있는가),
// 그리고 로그인 벽에서 프로젝트가 선언한 개발 계정을 꺼내 쓸지. 두 곳이 각자 판정하면
// 한쪽만 넓어질 때 로컬로 잘못 판단해 원격에 값을 쓰거나 자격증명을 노출한다.
//
// .cjs인 이유는 양쪽에서 함께 써야 하기 때문이다. server/*.js는 ESM,
// native/electron/*.cjs는 CJS이고, CJS로 두면 둘 다 읽을 수 있다.
function isLocalOrigin(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol === "file:" || u.protocol === "about:" || u.protocol === "data:") return true;
  const h = u.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".test")) return true;
  // 사설 대역은 사내 공용 서버일 수 있어 로컬로 보지 않는다.
  return false;
}
module.exports = { isLocalOrigin };
