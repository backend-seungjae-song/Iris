// 다른 브라우저에 묶인 쿠키는 가져오지 않는다. 동작으로 검사한다.
//
// 소스 모양으로 검사하지 않는 이유: 거르는 줄이 있어도 조건이 뒤집히거나 순서가 틀리면 소스 검사는
// 그대로 통과한다. 여기서는 가짜 행을 실제 함수에 먹여 결과를 본다.
//
// 배경: cf_clearance 는 "이 클라이언트가 도전을 풀었다"는 증표이고 푼 주체에
// 묶여 있다. 크롬이 푼 것을 Iris 파티션에 복사하면 Cloudflare 가 거부하고 다시 검사를 건다.
// 그러면 사람 확인 페이지로 넘어가 체크박스가 반복해서 뜬다.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const { decryptCookieRows } = require(path.join(root, "native/electron/cookie-import.cjs"));

// encrypted_value 가 비면 value 를 그대로 읽는 경로가 있다. 그래서 열쇠 없이 돌릴 수 있다.
const row = (host, name, value) => ({
  host_key: host, name, path: "/", value, encrypted_value: Buffer.alloc(0),
  is_secure: 1, is_httponly: 0, samesite: 0, expires_utc: 0,
});

test("도전 풀이 증표는 어느 도메인에서도 안 실린다", () => {
  const rows = [
    row(".claude.com", "cf_clearance", "가져오면안됨"),
    row(".claude.com", "__cf_bm", "가져오면안됨"),
    row(".example.co.kr", "__cfruid", "가져오면안됨"),
    row(".example.co.kr", "_cfuvid", "가져오면안됨"),
    row(".claude.com", "sessionKey", "가져와야함"),
  ];
  const { list } = decryptCookieRows(rows, null, null);
  const names = list.map((c) => c.name).sort();
  assert.deepEqual(names, ["sessionKey"], "증표가 걸러지지 않았다: " + names.join(", "));
});

test("구글 무결성 쿠키 거르기는 그대로다", () => {
  const rows = [
    row(".google.com", "SIDCC", "가져오면안됨"),
    row(".google.com", "SID", "가져와야함"),
    // 같은 이름이라도 구글이 아니면 무결성 쿠키가 아니다. 그 판정은 도메인을 본다.
    row(".other.com", "SIDCC", "가져와야함"),
  ];
  const { list } = decryptCookieRows(rows, null, null);
  assert.deepEqual(list.map((c) => c.name + " " + c.domain).sort(),
    ["SID .google.com", "SIDCC .other.com"]);
});

test("이름이 닮았을 뿐인 쿠키는 안 거른다", () => {
  // 접두만 같은 것까지 거르면 사이트의 진짜 세션 쿠키가 조용히 사라진다.
  const rows = [
    row(".claude.com", "cf_clearance_backup", "가져와야함"),
    row(".claude.com", "my__cf_bm", "가져와야함"),
  ];
  const { list } = decryptCookieRows(rows, null, null);
  assert.equal(list.length, 2);
});
