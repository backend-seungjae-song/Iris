// 저장된 로그인(아이디/비번) 임포트. Chrome/Brave/Edge의 "Login Data" DB를 복호화한다.
// 쿠키와 동일한 Keychain Safe Storage 키(AES-128-CBC v10)로 password_value를 복호화한다.
// Electron webview에는 Chrome식 네이티브 자동완성 드롭다운이 없으므로, 여기서 뽑은 자격증명을
// main의 safeStorage 암호화 저장소에 넣고 webview-preload가 자체 자동완성 UI로 채운다.
const path = require("node:path");
const { getMacKey, decryptValue, queryChromiumDb } = require("./cookie-import.cjs");

// profileEntry.dbPath = ".../<Profile>/Cookies" → 같은 폴더의 "Login Data".
function loginDbPath(profileEntry) {
  return path.join(path.dirname(profileEntry.dbPath), "Login Data");
}

// origin_url("https://accounts.google.com/...") → origin("https://accounts.google.com"). 실패 시 원문.
function toOrigin(u) {
  try { return new URL(u).origin; } catch { return String(u || ""); }
}

// 지정 프로필의 저장된 로그인을 복호화해 [{ origin, url, username, password }]로 반환.
// macOS 전용. Keychain 접근 실패(취소/권한)나 DB 부재는 { error }.
function listLoginsFromChrome(profileEntry) {
  if (process.platform !== "darwin") return { error: "macOS만 지원합니다." };
  const fs = require("node:fs");
  const db = loginDbPath(profileEntry);
  if (!fs.existsSync(db)) return { logins: [], total: 0 }; // 로그인 저장 없음(정상)
  let key;
  try { key = getMacKey(profileEntry.browser.service, profileEntry.browser.account); }
  catch (e) { return { error: "Keychain 접근 실패: " + (e && e.message || e) }; }
  let rows;
  try {
    // blacklisted_by_user=1 은 "이 사이트 저장 안 함"이라 비번이 없다 → 제외.
    // scheme=0(HTML 폼)만 받는다. Basic/Digest(scheme 1/2) 자격증명이 HTML 자동완성으로 노출되지 않게 한다.
    rows = queryChromiumDb(db, "SELECT origin_url, username_value, hex(password_value) FROM logins WHERE blacklisted_by_user=0 AND scheme=0;");
  } catch (e) { return { error: "Login Data 읽기 실패: " + (e && e.message || e) }; }
  const logins = [];
  for (const f of rows) {
    if (f.length < 3) continue;
    const originUrl = f[0], username = f[1] || "";
    let password = "";
    try { password = decryptValue(Buffer.from(f[2], "hex"), key, false); } catch { continue; } // stripHmac 금지(비밀번호 손상 방지)
    if (!password) continue; // 빈 비번(예: 저장 안 됨) 제외
    logins.push({ origin: toOrigin(originUrl), url: originUrl, username, password });
  }
  return { logins, total: rows.length };
}

module.exports = { listLoginsFromChrome, toOrigin };
