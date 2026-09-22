import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DOCX_RE = /\.docx$/i;
export const MAX_DOCX_BYTES = 20 * 1024 * 1024;

export const isDocxPath = (filePath) => DOCX_RE.test(String(filePath || ""));

export async function readDocxRaw(filePath, options = {}) {
  const local = options.local !== false;
  if (!local && !(typeof options.fsPathAllowed === "function" && options.fsPathAllowed(filePath))) {
    throw new Error("허용되지 않은 경로");
  }

  const stat = await fs.stat(filePath);
  if (stat.size > MAX_DOCX_BYTES) throw new Error("파일이 너무 큽니다(20MB 초과) — 열지 않음");
  const bytes = await fs.readFile(filePath);
  return {
    data: bytes.toString("base64"),
    revision: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

// docx.write: 임시파일에 쓰고 원본 mode를 복사한 뒤 원자적으로 교체한다(sheet.js writeWorkbook 선례).
export async function writeDocxRaw(filePath, bytes, options = {}) {
  const { baselineRevision } = options;
  if (typeof baselineRevision !== "string" || !/^[0-9a-f]{64}$/i.test(baselineRevision)) {
    throw new Error("writeDocxRaw: baselineRevision이 필요합니다");
  }
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let fh = null;
  let created = false;
  try {
    fh = await fs.open(tmpPath, "wx", 0o600);
    created = true;
    await fh.writeFile(bytes);
    try {
      const st = await fs.stat(filePath);
      await fh.chmod(st.mode);
    } catch (e) {
      throw new Error("원본 파일 권한을 복사하지 못해 저장을 중단했습니다: " + (e && e.message || e));
    }
    await fh.sync();
    const current = await fs.readFile(filePath);
    const currentRevision = crypto.createHash("sha256").update(current).digest("hex");
    if (currentRevision !== baselineRevision) {
      const err = new Error("다른 곳에서 파일이 바뀌었습니다 — 저장을 중단했습니다");
      err.conflict = true;
      throw err;
    }
    await fh.close();
    fh = null;
    await fs.rename(tmpPath, filePath);
    created = false;
    try {
      const dh = await fs.open(dir, "r");
      try { await dh.sync(); } finally { await dh.close(); }
    } catch {}
  } catch (e) {
    if (fh) { try { await fh.close(); } catch {} }
    if (created) { try { await fs.unlink(tmpPath); } catch {} }
    throw e;
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
