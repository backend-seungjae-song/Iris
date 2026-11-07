// 앱 화면 모듈(web/js/*)을 헤드리스 브라우저에서 그대로 import 해 돌린다
// - ES 모듈은 file:// 에서 import 되지 않아 web/ 을 로컬 HTTP 로 내줌
// - overrides: { "/js/x.js": 고치기 전 판 소스 } 로 같은 검사를 이전 판에 돌림
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../../bin/headless-browser.cjs");
const WEB = path.resolve(import.meta.dirname, "..", "..", "web");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

export async function withWebPage(fn, { body = "", overrides = {} } = {}) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><body>${body}</body>`); return; }
    if (overrides[rel] != null) { res.writeHead(200, { "content-type": TYPES[path.extname(rel)] || "text/plain" }); res.end(overrides[rel]); return; }
    const file = path.join(WEB, path.normalize(rel));
    if (!file.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
    try { const data = readFileSync(file); res.writeHead(200, { "content-type": TYPES[path.extname(rel)] || "text/plain" }); res.end(data); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    return await fn(page);
  } finally { await browser.close(); server.close(); }
}

// 환경 변수에 적힌 파일이 있으면 그 내용으로 웹 경로 하나를 바꿈
export function overrideFromEnv(map) {
  const out = {};
  for (const [env, webPath] of Object.entries(map)) if (process.env[env]) out[webPath] = readFileSync(process.env[env], "utf8");
  return out;
}
