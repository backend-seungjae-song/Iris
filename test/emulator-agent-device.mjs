import test from "node:test";
import assert from "node:assert/strict";
import { bootAllowed, chooseAgentDevice } from "../web/js/emulator/agent-device.js";

const ios = (udid, name, state = "Shutdown", extra = {}) => ({ udid, name, state, runtime: "iOS 18.2", isAvailable: true, ...extra });
const avd = (udid, state = "Shutdown", name = udid) => ({ udid, name, state, runtime: "Android", isAvailable: true });

test("기본 기기가 사용 중이면 같은 기종·런타임의 빈 기기만 재사용한다", () => {
  const devices = [ios("A", "iPhone 13", "Booted"), ios("SE", "iPhone SE"), ios("B", "iPhone 13 · 2")];
  assert.equal(chooseAgentDevice({devices, preferred:"A", inUse:["A"]}).udid, "B");
  assert.equal(chooseAgentDevice({devices, preferred:"A", inUse:["A","B"]}), null);
  assert.equal(chooseAgentDevice({devices:[devices[0],{...devices[2],runtime:"iOS 19"}], preferred:"A", inUse:["A"]}), null);
});

test("같은 iOS 기종은 이름 대신 모델 ID로 비교한다", () => {
  const devices = [ios("A","custom", "Shutdown", {modelId:"iphone13"}), ios("B","other", "Shutdown", {modelId:"iphone13"}),ios("C","custom", "Shutdown", {modelId:"iphone16"})];
  assert.equal(chooseAgentDevice({devices,preferred:"A",inUse:["A"]}).udid,"B");
  assert.equal(chooseAgentDevice({devices,preferred:"A",inUse:["A","B"]}),null);
});

test("Android는 AVD 별칭 사용 여부와 같은 하드웨어·시스템 이미지를 확인한다", () => {
  const devices=[{...avd("emulator-5554","Booted","Pixel_A"),persistentId:"Pixel_A",modelId:"pixel8",imageId:"api35"},
    {...avd("Pixel_B"),modelId:"pixel8",imageId:"api35"}, {...avd("Pixel_C"),modelId:"pixel8",imageId:"api34"}];
  assert.equal(chooseAgentDevice({devices,preferred:"Pixel_A",inUse:["Pixel_A"]}).udid,"Pixel_B");
  assert.equal(chooseAgentDevice({devices,preferred:"Pixel_A",inUse:["Pixel_A","Pixel_B"]}),null);
});

test("실제 Android폰·실행 불가·없는 저장 기기를 다른 모델로 대체하지 않는다", () => {
  const phone = avd("R5CT30XXXX", "Booted", "SM-S918N");
  const devices = [phone, ios("A", "iPhone 13")];
  assert.equal(chooseAgentDevice({devices,preferred:phone.udid}),null);
  assert.equal(chooseAgentDevice({devices,preferred:"missing"}),null);
  assert.equal(chooseAgentDevice({devices:devices.map(d=>({...d,runnable:false}))}),null);
  assert.deepEqual(bootAllowed({devices,device:devices[1],limit:1}),{ok:true,running:0});
});

test("꺼진 기기를 켤 때만 한도와 디스크를 보고, 켜는 중인 기기도 센다", () => {
  const devices = [ios("A", "iPhone 16", "Booted"), avd("emulator-5554", "Booted"), ios("C", "iPhone 15")];
  assert.deepEqual(bootAllowed({ devices, device: devices[0], limit: 1 }), { ok: true });
  assert.deepEqual(bootAllowed({ devices, device: devices[2], limit: 2 }), { ok: false, running: 2, reason: "limit" });
  assert.deepEqual(bootAllowed({ devices, device: devices[2], limit: 3 }), { ok: true, running: 2 });
  assert.deepEqual(bootAllowed({ devices, device: devices[2], limit: 3, booting: 1 }), { ok: false, running: 3, reason: "limit" });
  assert.deepEqual(bootAllowed({ devices, device: devices[2], limit: 3, diskOk: false }), { ok: false, running: 2, reason: "disk" });
});

test("기본 선택은 사용 가능한 iPhone 13을 우선하고 명시 설정은 유지한다", () => {
  const devices = [
    { udid: "fifteen", name: "iPhone 15", state: "Shutdown" },
    { udid: "thirteen", name: "iPhone 13 · 1", state: "Shutdown" },
  ];
  assert.equal(chooseAgentDevice({devices}).udid, "thirteen");
  assert.equal(chooseAgentDevice({devices, preferred: "fifteen"}).udid, "fifteen");
  assert.equal(chooseAgentDevice({devices: devices.map(d => ({...d,runnable:false}))}), null);
});
