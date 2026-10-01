import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateHome } from "../state-home.cjs";
import { redactMacPaths } from "./public-text.js";

const links = new Map();
const MEDIA = /\.(?:pdf|html?|png|jpe?g|gif|webp|svg)$/i;
const inside = (root, file) => file.startsWith(root + path.sep);

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
    (match, prefix, value) => {
      const ref = register(value);
      return ref ? `${prefix}[Mac 파일](${ref})` : match;
    });
  const refs = [];
  out = out.replace(/iris-media:[0-9a-f]{32}/g, (value) => {
    refs.push(value); return `REMOTE_MEDIA_LINK_${refs.length - 1}`;
  });
  return redactMacPaths(out).replace(/REMOTE_MEDIA_LINK_(\d+)/g, (match, index) => refs[Number(index)] || match);
}

export function resolveMedia(ref, agent, options) {
  const link = links.get(ref);
  return link?.agent === agent.ref ? safeMediaUrl(link.value, { ...options, cwd: agent.source?.cwd }) : null;
}
