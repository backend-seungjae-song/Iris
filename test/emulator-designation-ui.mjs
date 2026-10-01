import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import puppeteer from "puppeteer-core";

const { headlessLaunchOptions } = createRequire(import.meta.url)("../bin/headless-browser.cjs");
const web = path.resolve(import.meta.dirname, "../web");
const fixture = `
import { initCapability, panelHtml } from '/js/emulator/boot.js';
import { setCenterSpace } from '/js/center/tab-store.js';
const devices = ['ios-a', 'ios-b'].map(udid => ({udid, name:'iPhone', state:'Booted', runtime:'com.apple.CoreSimulator.SimRuntime.iOS-18-3', isAvailable:true}));
window.calls=[]; window.messages=[]; window.deferB=false;
const host = {
  getSettings:async()=>({ok:true,settings:{}}), setSettings:async settings=>({ok:true,settings}),
  rpc:async(method,args)=>{
    calls.push({method,args});
    if(method==='emulator.availability') return {ok:true,result:{platform:'darwin',simctl:{ok:true},serveSim:{ok:true},android:{},devices}};
    if(method==='emulator.listDevices') return {ok:true,result:devices.map(d=>({...d,id:d.udid,detail:d.runtime}))};
    if(method==='emulator.attach') {
      if(args.device==='ios-b' && deferB) await new Promise(resolve=>window.releaseB=resolve);
      return {ok:true,result:{attached:true,info:{deviceUdid:args.device,displayName:'iPhone',state:'Booted'}}};
    }
    return {ok:true,result:{}};
  },
  useVolume:async()=>({ok:true,volume:1,muted:false}),
  openWindow:async()=>({ok:true}),closeWindow:async()=>({ok:true}),
  onWindowClosed(){},onQuitting(){},onWindowBounds(){},onControlRequest(){},setPickState(){},setRecordState(){}
};
document.querySelector('#emu-panel').innerHTML=panelHtml;
setCenterSpace('space');
window.feature=initCapability({acHost:{emulator:host},getSelectedSpaceId:()=> 'space',getSpaces:()=>[{id:'space'}],spk:id=>id,renderTabs(){},showActiveTab(){},wsSend:m=>messages.push(m)});
feature.screen.enter(); window.ready=true;
`;

async function withPage(run) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      let content;
      if (pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        content = '<!doctype html><body class="layout-on emu-active"><main class="app"><aside id="emu-panel"></aside><div id="center"><div id="tabbar-row"></div><div id="emulatorview"></div></div></main><script type="module" src="/fixture.js"></script>';
      } else if (pathname === "/fixture.js") content = fixture;
      else {
        const file = path.resolve(web, `.${pathname}`);
        if (!file.startsWith(`${web}/`)) throw new Error("invalid path");
        content = await readFile(file);
      }
      if (pathname !== "/") res.setHeader("Content-Type", "text/javascript");
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await puppeteer.launch(headlessLaunchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    await page.waitForSelector(".emu-dp-row");
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function openRow(page, index, udid) {
  await page.evaluate((index) => document.querySelectorAll(".emu-dp-row")[index].click(), index);
  await page.waitForFunction((udid) => calls.some((call) => call.method === "emulator.attach" && call.args.device === udid), {}, udid);
  await page.waitForFunction((udid) => {
    feature.ws["emulator-ask"]({ kind: "list", id: "poll" });
    return messages.at(-1).tabs.some((tab) => tab.udid === udid);
  }, {}, udid);
}

test("동일한 이름의 iOS 기기를 UDID로 요청하면 기존 지정 기기를 바꾸지 않고 해당 탭을 반환한다", async () => withPage(async (page) => {
  await openRow(page, 0, "ios-a");
  await openRow(page, 1, "ios-b");
  const before = await page.evaluate(() => calls.filter((call) => call.method === "emulator.attach").length);
  await page.evaluate(() => {
    feature.ws["emulator-ask"]({ kind: "reown", id: "reown", devices: ["ios-a"], owner: "agent" });
    feature.ws["emulator-ask"]({ kind: "open", id: "open-b", device: "ios-b", owner: "agent" });
  });
  await page.waitForFunction(() => messages.some((message) => message.id === "open-b"));
  assert.equal(await page.evaluate(() => messages.find((message) => message.id === "open-b").udid), "ios-b");
  assert.equal(await page.evaluate(() => calls.filter((call) => call.method === "emulator.attach").length), before);
  await page.evaluate(() => feature.ws["emulator-ask"]({ kind: "list", id: "after" }));
  const tabs = await page.evaluate(() => messages.find((message) => message.id === "after").tabs);
  assert.equal(tabs.find((tab) => tab.udid === "ios-a").owner, "agent");
  assert.equal(tabs.length, 2);
  assert.deepEqual(await page.evaluate(() => calls.filter((call) => call.method === "emulator.shutdown")), []);
}));

test("지정한 iOS 기기를 다른 UDID로 바꾸는 요청은 새 기기의 attach 완료 전에 성공하지 않는다", async () => withPage(async (page) => {
  await openRow(page, 0, "ios-a");
  await page.evaluate(() => {
    feature.ws["emulator-ask"]({ kind: "reown", id: "reown", devices: ["ios-a"], owner: "agent" });
    deferB = true;
    feature.ws["emulator-ask"]({ kind: "open", id: "open-b", device: "ios-b", owner: "agent" });
  });
  await page.waitForFunction(() => typeof releaseB === "function");
  assert.equal(await page.evaluate(() => messages.some((message) => message.id === "open-b")), false);
  await page.evaluate(() => releaseB());
  await page.waitForFunction(() => messages.some((message) => message.id === "open-b"));
  assert.equal(await page.evaluate(() => messages.find((message) => message.id === "open-b").udid), "ios-b");
}));

test("AVD 이름으로 복귀한 화면은 backend 없는 기존 Android 세션 응답을 같은 기기로 확인한다", async () => withPage(async (page) => {
  await page.evaluate(async () => {
    const { mountEmulatorPane } = await import("/js/emulator/pane.js");
    const element = document.createElement("div");
    document.body.append(element);
    const rows = [{ id: "emulator-5554", name: "Pixel_API_35", state: "booted", detail: "Android" }];
    window.androidPane = mountEmulatorPane(element, { workspaceId: "iris:emulator:android", deviceId: "Pixel_API_35", fixedDevice: true,
      host: {
        getSettings: async () => ({ ok: true, settings: {} }),
        rpc: async (method) => ({ ok: true, result: method === "emulator.listDevices" ? rows
          : method === "emulator.attach" ? { attached: true, info: { deviceUdid: "emulator-5554" } }
          : {} }),
      },
    });
    androidPane.connect();
  });
  await page.waitForFunction(() => !androidPane.current().loading);
  assert.equal(await page.evaluate(() => androidPane.current().attached), true);
  assert.equal(await page.evaluate(() => androidPane.current().udid), "emulator-5554");
}));
