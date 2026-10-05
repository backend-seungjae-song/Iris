// 호스트 경로 계산. Windows 판정은 Electron preload 값만 사용.
export const isHostWindows = () => (globalThis.acHost || globalThis.window?.acHost)?.platform === "win32";

export function isAbsolutePath(value) {
  const p = String(value || "");
  return isHostWindows() ? /^[A-Za-z]:[\\/]/.test(p) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(p) : p.startsWith("/");
}

function windowsRoot(p) {
  const drive = p.match(/^([A-Za-z]:)\//);
  if (drive) return { root: drive[1] + "/", rest: p.slice(3) };
  const unc = p.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (unc) return { root: `//${unc[1]}/${unc[2]}/`, rest: p.slice(unc[0].length) };
  return { root: p.startsWith("/") ? "/" : "", rest: p.replace(/^\/+/, "") };
}

export function normalizePath(value) {
  let p = String(value || "");
  const win = isHostWindows();
  if (win) p = p.replace(/\\/g, "/");
  const { root, rest } = win ? windowsRoot(p) : { root: p.startsWith("/") ? "/" : "", rest: p };
  const parts = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length && parts.at(-1) !== "..") parts.pop(); else if (!root) parts.push(part); }
    else parts.push(part);
  }
  const result = root + parts.join("/");
  return win ? result.replace(/\//g, "\\") : result;
}

export function pathBasename(value) {
  const p = String(value || "");
  return isHostWindows() ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "" : p.split("/").pop();
}

export function pathDirname(value) {
  const p = String(value || "");
  if (!isHostWindows()) return p.slice(0, p.lastIndexOf("/"));
  const normalized = normalizePath(p), slash = normalized.lastIndexOf("\\");
  const root = windowsRoot(normalized.replace(/\\/g, "/")).root.replace(/\//g, "\\");
  return slash < root.length ? root : normalized.slice(0, slash);
}

export function joinPath(base, child) {
  const sep = isHostWindows() ? "\\" : "/";
  return normalizePath(String(base || "").replace(isHostWindows() ? /[\\/]+$/ : /\/+$/, "") + sep + String(child || ""));
}

export function samePath(a, b) {
  if (!isHostWindows()) return a === b;
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

export function pathWithin(root, child) {
  if (!root || !child) return false;
  if (!isHostWindows()) return child === root || child.startsWith(root.endsWith("/") ? root : root + "/");
  const r = normalizePath(root).toLowerCase(), p = normalizePath(child).toLowerCase();
  return p === r || p.startsWith(r.endsWith("\\") ? r : r + "\\");
}

export function relativePath(root, child) {
  if (!pathWithin(root, child)) return null;
  if (!isHostWindows()) return child.slice(root.endsWith("/") ? root.length : root.length + 1);
  const r = normalizePath(root), p = normalizePath(child);
  return samePath(r, p) ? "" : p.slice(r.endsWith("\\") ? r.length : r.length + 1);
}

export function toFileUrl(value) {
  const p = String(value || "");
  if (!isHostWindows()) return "file://" + p.split("/").map(encodeURIComponent).join("/");
  if (!isAbsolutePath(p)) return null;
  const normalized = normalizePath(p).replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    const [host, ...parts] = normalized.slice(2).split("/");
    return "file://" + host + "/" + parts.map(encodeURIComponent).join("/");
  }
  return "file:///" + normalized.slice(0, 2) + normalized.slice(2).split("/").map(encodeURIComponent).join("/");
}

export function fromFileUrl(value) {
  try {
    if (!isHostWindows()) return decodeURIComponent(String(value).replace(/^file:\/\//i, "").replace(/[?#].*$/, ""));
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const p = decodeURIComponent(url.pathname);
    const path = url.hostname && url.hostname !== "localhost" ? `\\\\${url.hostname}${p.replace(/\//g, "\\")}` : p.replace(/^\/([A-Za-z]:\/)/, "$1").replace(/\//g, "\\");
    return isAbsolutePath(path) ? normalizePath(path) : null;
  } catch { return null; }
}
