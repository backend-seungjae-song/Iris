// PNG 한 장의 64비트 dHash와 두 값의 다른 비트 수. 보고서가 거의 같은 장면을 빼는 데 씀
// 8비트 회색·RGB·회색+알파·RGBA, 인터레이스 없는 PNG만. 그 밖은 비교하지 않고 남김(null)
import zlib from "node:zlib";

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// 버퍼 → 9×8 회색 평균 격자 → 가로 이웃 비교 64비트
export function dhashPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.toString("latin1", 1, 4) !== "PNG") return null;
  let off = 8, w = 0, h = 0, depth = 0, type = -1, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), name = buf.toString("latin1", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (name === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    off += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!ch || depth !== 8 || interlace || !w || !h || !idat.length) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) return null;
  const sums = new Float64Array(72), counts = new Float64Array(72);
  const colOf = new Uint8Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(8, Math.floor((x * 9) / w));
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1), filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const v = raw[base + 1 + i], a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let out;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else return null;
      cur[i] = out & 255;
    }
    const row = Math.min(7, Math.floor((y * 8) / h)) * 9;
    for (let x = 0; x < w; x++) {
      const p = x * ch;
      const gray = ch >= 3 ? (cur[p] * 299 + cur[p + 1] * 587 + cur[p + 2] * 114) / 1000 : cur[p];
      sums[row + colOf[x]] += gray; counts[row + colOf[x]] += 1;
    }
    [prev, cur] = [cur, prev];
  }
  let hash = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const left = sums[r * 9 + c] / (counts[r * 9 + c] || 1), right = sums[r * 9 + c + 1] / (counts[r * 9 + c + 1] || 1);
    hash = (hash << 1n) | (left > right ? 1n : 0n);
  }
  return hash;
}

export function hashDistance(a, b) {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
