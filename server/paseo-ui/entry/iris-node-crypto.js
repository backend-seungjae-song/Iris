// 대화 화면 번들용 node:crypto 대체(metro.config.cjs 가 Paseo 서버 소스의 node:crypto 를 이 파일로 연결)
// - Paseo task-notification-tool-call.ts 가 알림 카드 id 를 sha1 로 만듦. 브라우저에는 node:crypto 가 없음
// - createHash("sha1").update(문자열·바이트).digest("hex") 만 지원. 다른 쓰임은 오류
function sha1(bytes) {
  const words = new Uint32Array(((bytes.length + 8 >> 6) + 1) * 16);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;
  const w = new Uint32Array(80);
  let [a0, b0, c0, d0, e0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[off + t] : rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, b, c, d, e] = [a0, b0, c0, d0, e0];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (rol(a, 5) + f + e + k + w[t]) >>> 0;
      [e, d, c, b, a] = [d, c, rol(b, 30) >>> 0, a, tmp];
    }
    [a0, b0, c0, d0, e0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0, (e0 + e) >>> 0];
  }
  return [a0, b0, c0, d0, e0].map((x) => x.toString(16).padStart(8, "0")).join("");
}

export function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== "sha1") throw new Error(`대화 화면 번들은 sha1 만 지원합니다: ${algorithm}`);
  const parts = [];
  const hash = {
    update(data) {
      parts.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
      return hash;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new Error("대화 화면 번들은 hex 결과만 지원합니다");
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.length; }
      return sha1(all);
    },
  };
  return hash;
}
