import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { read, ROOT } from "./core.mjs";

// /Applications 의 Google Chrome 은 후보에 넣지 않는다. 사용자가 쓰는 앱 번들을 검사가 실행하면
// 업데이트 대기 중일 때 시작 직후 죽어 Dock 아이콘과 "예기치 않게 종료됨" 창이 뜬다.
export function headlessShellCandidates(home = homedir()) {
  const found = [];
  for (const [root, prefix] of [[path.join(home, ".cache/puppeteer/chrome-headless-shell"), ""],
    [path.join(home, "Library/Caches/ms-playwright"), "chromium_headless_shell-"]]) {
    let versions = [];
    try { versions = readdirSync(root).filter((name) => name.startsWith(prefix)); } catch { continue; }
    for (const version of versions) {
      let platforms = [];
      try { platforms = readdirSync(path.join(root, version)).filter((name) => name.startsWith("chrome-headless-shell-")); } catch { continue; }
      for (const platform of platforms) {
        const bin = path.join(root, version, platform, "chrome-headless-shell");
        if (existsSync(bin)) found.push({ bin, mtime: statSync(bin).mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.bin);
}

export async function runBrowserFileDropRuntime() {
  const executablePath = process.env.CHROME_BIN || [
    ...headlessShellCandidates(),
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  ].find((candidate) => existsSync(candidate));
  assert.ok(executablePath, "실제 드롭 검사에는 chrome-headless-shell 또는 CHROME_BIN이 필요합니다"
    + " (설치: npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer)");
  const scratch = mkdtempSync(path.join(tmpdir(), "iris-browser-drop-"));
  const file = path.join(scratch, "한글 #100%.txt"), folder = path.join(scratch, "folder.txt");
  writeFileSync(file, "browser drop fixture"); mkdirSync(folder);
  const files = { [path.basename(file)]: file };
  const html = `<style>body{margin:0}#tabstrip{height:50px}#browser-tab{margin-left:300px}#center-body{height:450px}#browserview{height:200px}iframe{border:0;width:750px;height:350px}#outside{height:60px}</style>
    <div id="tabstrip"><span id="browser-tab" data-tab="browser-tab">browser tab</span> tabs</div><div id="center-body"><div id="browserview">browser</div><div id="editor">editor</div></div><div id="outside">outside</div>`;
  const server = createServer((request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!pathname.startsWith("/web/js/") || pathname.includes("..")) { response.writeHead(404).end(); return; }
    try { response.setHeader("Content-Type", "text/javascript"); response.end(readFileSync(path.join(ROOT, pathname))); }
    catch { response.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath,
      headless: path.basename(executablePath) === "chrome-headless-shell" ? "shell" : true, userDataDir: path.join(scratch, "profile"),
      args: ["--no-first-run", "--disable-background-networking"], timeout: 15000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 750 });
    const cdp = await page.createCDPSession();
    const main = read("web/js/main.js");
    const mainStart = main.indexOf("if (!AUX_MODE" , main.indexOf("initCenterTabs({"));
    const mainEnd = main.indexOf("\n});", mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart);
    const mainBlock = main.slice(mainStart, mainEnd + 4);
    async function setup(browserMode, auxMode = browserMode) {
      await page.goto(origin);
      await page.evaluate(async ({ browserMode, auxMode, mainBlock, files }) => {
        const { initCenterFileDrop } = await import("/web/js/center/file-drop.js");
        window.opened = []; window.notices = []; window.hostDrops = 0;
        window.acHost = { getDroppedPath: (file) => files[file.name] };
        const deps = { AUX_MODE: auxMode, BROWSER_MODE: browserMode, initCenterFileDrop,
          $: (selector) => document.querySelector(selector), tabstrip: document.querySelector("#tabstrip"),
          browserview: document.querySelector("#browserview"), document, window,
          curTabs: () => [{ id: "browser-tab", kind: "browser" }],
          openFile: (path) => window.opened.push({ surface: "editor", path }),
          openDroppedLocal: (path) => window.opened.push({ surface: "browser", path }),
          showToast: (message) => window.notices.push(message), callHook: () => {} };
        new Function(...Object.keys(deps), mainBlock)(...Object.values(deps));
        document.addEventListener("drop", () => window.hostDrops++, true);
      }, { browserMode, auxMode, mainBlock, files });
    }
    async function drag(selector, paths = [file], frame = page) {
      const element = await frame.$(selector), box = await element.boundingBox();
      assert.ok(box, `놓을 자리 없음: ${selector}`);
      const point = { x: box.x + 20, y: box.y + Math.min(15, box.height / 2) };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await cdp.send("Input.dispatchDragEvent", { type, ...point, data: { items: [], files: paths, dragOperationsMask: 1 } });
      }
    }
    const opened = () => page.evaluate(() => window.opened);
    await setup(true);
    for (const selector of ["#tabstrip", "#browserview", "#outside"]) await drag(selector);
    assert.deepEqual(await opened(), Array.from({ length: 3 }, () => ({ surface: "browser", path: file })), "분리창 전체 파일 드롭");
    await setup(false);
    await drag("#browserview"); await drag("#tabstrip");
    assert.deepEqual(await opened(), Array.from({ length: 2 }, () => ({ surface: "browser", path: file })), "도킹 브라우저·탭 띠 파일 드롭");
    await page.evaluate(() => { document.querySelector("#browserview").hidden = true; });
    await drag("#editor"); await drag("#tabstrip");
    assert.deepEqual((await opened()).slice(2), Array.from({ length: 2 }, () => ({ surface: "editor", path: file })), "기존 편집기 드롭 보존");
    await drag("#browser-tab");
    assert.deepEqual((await opened()).at(-1), { surface: "browser", path: file }, "비활성 브라우저 탭도 브라우저로 연다");
    await drag("#editor", [folder]);
    assert.match((await page.evaluate(() => window.notices)).at(-1), /폴더/);
    await setup(false, true); await drag("#tabstrip");
    assert.deepEqual(await opened(), [], "메모 등 다른 AUX 창 제외");

    await setup(true);
    const factory = read("web/js/browser/webview-factory.js");
    const ipcStart = factory.indexOf('  el.addEventListener("ipc-message",');
    const ipcEnd = factory.indexOf("\n  });", ipcStart);
    assert.ok(ipcStart >= 0 && ipcEnd > ipcStart);
    await page.evaluate(async (ipcBlock) => {
      const { openDroppedEntries } = await import("/web/js/center/file-drop.js");
      const el = document.createElement("iframe"); el.id = "guest";
      el.srcdoc = `<style>body{margin:0}.zone{height:55px}input,textarea{display:block;height:35px}</style><div class="zone" id="plain">plain</div><input id="upload" type="file"><label class="zone" for="upload" id="label">upload label</label><div class="zone" id="custom">custom upload</div><textarea id="text"></textarea><div class="zone" id="editable" contenteditable>edit</div>`;
      document.querySelector("#browserview").replaceChildren(el);
      const deps = { el, openDroppedEntries, openDroppedLocal: (path) => window.opened.push({ surface: "browser", path }),
        showToast: (message) => window.notices.push(message) };
      new Function(...Object.keys(deps), ipcBlock)(...Object.values(deps));
    }, factory.slice(ipcStart, ipcEnd + 6));
    const frame = await (await page.$("#guest")).contentFrame();
    await frame.waitForSelector("#plain");
    const tree = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.childFrames[0].frame.id, worldName: "iris-drop-preload-test",
    });
    const preload = read("native/electron/webview-preload.cjs");
    const injected = await cdp.send("Runtime.evaluate", { contextId: executionContextId,
      expression: `window.receipts = []; const require = () => ({ipcRenderer: {on() {}, sendToHost(channel, entries) { if (channel === 'ac-file-drop') window.receipts.push({channel, entries}); }}, webUtils: {getPathForFile(file) { return (${JSON.stringify(files)})[file.name] || ''; }}});\n${preload}` });
    assert.ok(!injected.exceptionDetails, JSON.stringify(injected.exceptionDetails));
    await frame.evaluate(() => {
      window.received = [];
      document.addEventListener("drop", (event) => window.received.push({ target: event.target.id, trusted: event.isTrusted, files: event.dataTransfer.files.length }));
    });
    async function receipts() {
      const result = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: "window.receipts", returnByValue: true });
      return result.result.value;
    }
    await drag("#plain", [file], frame);
    assert.deepEqual(await receipts(), [{ channel: "ac-file-drop", entries: [{ path: file }] }], "실제 guest drop → isolated preload");
    assert.equal(await page.evaluate(() => window.hostDrops), 0, "guest drop은 host document에 직접 도달하지 않는다");
    assert.deepEqual(await frame.evaluate(() => window.received), [{ target: "plain", trusted: true, files: 1 }]);
    await page.evaluate((receipt) => {
      const event = new Event("ipc-message"); event.channel = receipt.channel; event.args = [receipt.entries];
      document.querySelector("#guest").dispatchEvent(event);
    }, (await receipts())[0]);
    assert.deepEqual(await opened(), [{ surface: "browser", path: file }], "실제 factory IPC 수신 → 열기");
    await drag("#upload", [file], frame);
    assert.equal(await frame.$eval("#upload", (input) => input.files.length), 1, "기본 input 파일 업로드 유지");
    for (const selector of ["#label", "#text", "#editable"]) await drag(selector, [file], frame);
    assert.equal((await receipts()).length, 1, "업로드 label 및 편집 칸 양보");
    for (const owner of ["document", "window", "stop", "over-only", "window-stop", "capture-late"]) {
      await frame.evaluate((owner) => {
        window.uploadCount = 0;
        const controller = new AbortController(); window.cleanupUpload?.();
        window.cleanupUpload = () => controller.abort();
        const target = owner.startsWith("window") ? window : document;
        if (owner === "capture-late") {
          for (const kind of ["dragover", "drop"]) window.addEventListener(kind, () => {
            window.addEventListener(kind, (event) => {
              event.preventDefault();
              if (kind === "drop") window.uploadCount += event.dataTransfer.files.length;
            }, { once: true, signal: controller.signal });
          }, { capture: true, signal: controller.signal });
          return;
        }
        target.addEventListener("dragover", (event) => {
          if (owner === "window-stop") return;
          event.preventDefault();
          if (owner === "stop") event.stopPropagation();
        }, { signal: controller.signal });
        target.addEventListener("drop", (event) => {
          if (owner !== "over-only" && owner !== "window-stop") event.preventDefault();
          if (owner === "stop" || owner === "window-stop") event.stopPropagation();
          window.uploadCount += event.dataTransfer.files.length;
        }, { signal: controller.signal });
      }, owner);
      await drag("#custom", [file], frame);
      assert.equal(await frame.evaluate(() => window.uploadCount), 1, `페이지 업로드 수신: ${owner}`);
      assert.equal((await receipts()).length, 1, `페이지 처리 우선: ${owner}`);
    }
    await frame.evaluate(() => window.cleanupUpload());
    await drag("#plain", [folder, file], frame);
    assert.deepEqual((await receipts()).at(-1).entries, [{ error: "directory" }, { path: file }], "게스트 폴더와 정상 파일을 구분");
    const before = (await receipts()).length;
    await frame.evaluate(() => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(["fake"], "fake.txt"));
      document.querySelector("#plain").dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
      window.postMessage({ channel: "ac-file-drop", entries: [{ path: "/tmp/fake" }] }, "*");
    });
    assert.equal((await receipts()).length, before, "합성·페이지 메시지는 파일 열기 권한이 없다");
    return { browserVersion: await browser.version(), hostSurfaces: ["detached-body", "detached-tabs", "docked-body", "docked-tabs", "inactive-browser-tab", "editor"],
      guestEvents: await frame.evaluate(() => window.received), guestReceipts: await receipts(),
      uploadOwners: ["native-input", "label", "textarea", "contenteditable", "document", "window", "stop", "over-only", "window-stop", "capture-late"] };
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
}
