import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateHome } from "../state-home.cjs";
import { redactMacPaths } from "./public-text.js";

const links = new Map();
const MEDIA = /\.(?:pdf|html?|png|jpe?g|gif|webp|svg)$/i;
const inside = (root, file) => process.platform === "win32"
  ? file.toLowerCase().startsWith(root.replace(/[\\/]+$/, "").toLowerCase() + path.sep)
  : file.startsWith(root + path.sep);

export function safeMediaUrl(value, { home = os.homedir(), stateDir = stateHome(), cwd } = {}) {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return null;
  try {
    let file = value.startsWith("file:") ? fileURLToPath(value) : value;
    if (!path.isAbsolute(file)) {
      if (!cwd || /^[a-z][a-z0-9+.-]*:/i.test(file)) return null;
      file = path.resolve(cwd, file);
    }
    const root = fs.realpathSync(home);
    const actual = fs.realpathSync(file);
    const denied = path.resolve(stateDir);
    const realDenied = fs.existsSync(denied) ? fs.realpathSync(denied) : denied;
    if (!inside(root, actual) || actual === realDenied || inside(realDenied, actual)
      || !MEDIA.test(actual) || !fs.statSync(actual).isFile()) return null;
    const url = pathToFileURL(actual).href;
    return url.length <= 2048 ? url : null;
  } catch { return null; }
}

export function mediaText(text, agent) {
  const register = (value) => {
    if (!agent || value.length > 2048) return null;
    const ref = randomBytes(16).toString("hex");
    links.set(ref, { agent: agent.ref, value });
    while (links.size > 4096) links.delete(links.keys().next().value);
    return `iris-media:${ref}`;
  };
  let out = String(text).replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)(\))/g, (match, start, value, end) => {
    if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
    if (/^https?:/i.test(value)) return match;
    if (!/^(?:file:|\/|\.\.?\/)/.test(value) && !MEDIA.test(value)) return match;
    const ref = register(value);
    return ref ? `${start}${ref}${end}` : match;
  });
  out = out.replace(/`((?:file:\/\/|\/|\.\.?\/)[^`\n]+\.(?:pdf|html?|png|jpe?g|gif|webp|svg))`/gi,
    (match, value) => {
      const ref = register(value); return ref ? `[Mac 파일](${ref})` : match;
    });
  out = out.replace(/(^|[\s`"':=])((?:file:\/\/|\/|\.\.?\/)[^\s`"'<>\])},;]+\.(?:pdf|html?|png|jpe?g|gif|webp|svg))(?=$|[\s`"',;])/gim,
    (match, prefix, value, offset, source) => {
      if (process.platform === "win32" && /[a-z][a-z0-9+.-]*:$/i.test(source.slice(0, offset + prefix.length))) return match;
      const ref = register(value);
      return ref ? `${prefix}[Mac 파일](${ref})` : match;
    });
  if (process.platform === "win32") {
    out = out.replace(/`((?:[a-z]:[\\/]|\\\\)[^`\n]+\.(?:pdf|html?|png|jpe?g|gif|webp|svg))`/gi,
      (match, value) => {
        const ref = register(value); return ref ? `[PC 파일](${ref})` : match;
      });
    out = out.replace(/(^|[\s"'=])((?:[a-z]:[\\/]|\\\\)[^\s`"'<>\])},;]+\.(?:pdf|html?|png|jpe?g|gif|webp|svg))(?=$|[\s"',;])/gim,
      (match, prefix, value) => {
        const ref = register(value); return ref ? `${prefix}[PC 파일](${ref})` : match;
      });
  }
  const refs = [];
  out = out.replace(/iris-media:[0-9a-f]{32}/g, (value) => {
    refs.push(value); return `REMOTE_MEDIA_LINK_${refs.length - 1}`;
  });
  return redactMacPaths(out).replace(/REMOTE_MEDIA_LINK_(\d+)/g, (match, index) => refs[Number(index)] || match);
}

export function resolveMedia(ref, agent, options) {
  const link = links.get(ref);
  return link?.agent === agent.ref && typeof link.value === "string"
    ? safeMediaUrl(link.value, { ...options, cwd: agent.source?.cwd }) : null;
}

// 대화 기록 속 이미지 → iris-image 주소. 폰은 바이트를 media.image 요청으로 받음
// - image: { file, ino, off, i, j, sig } 기록 파일 이름·inode·줄 위치·데이터 서명. 하나라도 다르면 내주지 않음
// - 같은 이미지에는 같은 주소. 첫 쪽과 실시간 알림이 같은 항목을 같은 글로 보내야 폰이 겹친 항목을 알아봄
// - 파일 링크(iris-media)와 다른 이름. 폰은 iris-image 만 받아 그리고 iris-media 는 Mac 에서 엶
const imageRefs = new Map();   // agent·위치 → ref
export function mediaImage(agent, image) {
  if (!agent?.ref) return null;
  const key = JSON.stringify([agent.ref, image.file, image.ino, image.off, image.i, image.j ?? null, image.sig ?? null]);
  let ref = imageRefs.get(key);
  if (!ref || links.get(ref)?.image === undefined) {
    ref = randomBytes(16).toString("hex");
    imageRefs.set(key, ref);
    while (imageRefs.size > 4096) imageRefs.delete(imageRefs.keys().next().value);
  }
  links.delete(ref);
  links.set(ref, { agent: agent.ref, image });
  while (links.size > 4096) links.delete(links.keys().next().value);
  return `iris-image:${ref}`;
}

export function resolveMediaImage(ref) {
  const link = links.get(ref);
  return link?.image ? { agent: link.agent, ...link.image } : null;
}
