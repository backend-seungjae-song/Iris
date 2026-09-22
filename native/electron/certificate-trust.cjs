// 로컬 개발 서버의 자체서명 인증서 신뢰 판정.
//
// 소유 범위
//   host+지문별 앱 수명 결정과 같은 인증서를 동시에 묻는 Promise 장부.
//
// 제공 API
//   isLocalCertHost(host) 조회와 createCertificateTrust(...)가 주는 askHuman·handleCertificateError·
//   installCertificateTrust 명령. 원시 Map이나 결정 장부는 내주지 않는다.
//
// 의존 대상
//   조립부가 넘기는 앱 URL, fetch 구현과 certificate-error event source.
//
// 유지 조건
//   HTTPS + ERR_CERT_AUTHORITY_INVALID + 지문 + localhost/명시 로컬 host만 사람에게 묻는다.
//   다른 오류·host는 기본 거절에 맡기고, 같은 host+지문은 한 번만 묻고, noplan=1을 유지한다.
//
// 영향 범위
//   공급자는 main.cjs의 APP_URL·Electron app certificate-error·서버 /dialog-ask이고, 양방향
//   소비자는 main.cjs whenReady 보안 조립과 BrowserWindow/webview의 로컬 HTTPS navigation이다.
//   판정은 서버 dialog 카드·사람 응답·certificate callback과 해당 페이지 로드 성공 여부에도 영향을 준다.

const CERT_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalCertHost(h) {
  const n = String(h || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (n === "::1" || /^127(\.\d{1,3}){3}$/.test(n)) return true;
  return CERT_LOCAL_HOSTS.has(n) || n.endsWith(".localhost");
}

function createCertificateTrust({ appUrl, fetchImpl = fetch }) {
  const certDecisions = new Map();
  const certAsking = new Map();

  async function askHuman(wcId, message) {
    try {
      const rawAppUrl = typeof appUrl === "function" ? appUrl() : appUrl;
      const port = new URL(rawAppUrl).port || 4271;
      const u = `http://127.0.0.1:${port}/dialog-ask?noplan=1&wc=${Number(wcId) || 0}&kind=confirm&msg=${encodeURIComponent(message)}`;
      const res = await fetchImpl(u);
      if (!res.ok) return false;
      const j = await res.json();
      return !!(j && j.answer === "ok");
    } catch { return false; }
  }

  function handleCertificateError(event, wc, url, error, certificate, callback) {
    let host = "", proto = "";
    try { const u = new URL(url); host = u.hostname; proto = u.protocol; } catch {}
    if (proto !== "https:" || !isLocalCertHost(host) || String(error) !== "ERR_CERT_AUTHORITY_INVALID") return null;
    const fp = String((certificate && certificate.fingerprint) || "");
    if (!fp) return null;
    const key = host + "|" + fp;
    event.preventDefault();
    if (certDecisions.has(key)) { callback(certDecisions.get(key)); return null; }
    let p = certAsking.get(key);
    if (!p) {
      p = askHuman(wc && wc.id,
        `이 로컬 서버의 인증서를 발급한 곳을 확인할 수 없습니다.\n\n`
        + `주소: https://${host}\n지문: ${fp}\n\n`
        + `직접 띄운 개발 서버가 맞으면 계속하세요. 아니면 취소하세요.`)
        .then((ok) => { certDecisions.set(key, ok); certAsking.delete(key); return ok; },
              () => { certAsking.delete(key); return false; });
      certAsking.set(key, p);
    }
    p.then((ok) => callback(!!ok), () => callback(false));
    return p;
  }

  function installCertificateTrust(app) {
    app.on("certificate-error", handleCertificateError);
  }

  return { askHuman, handleCertificateError, installCertificateTrust };
}

module.exports = { createCertificateTrust, isLocalCertHost };
