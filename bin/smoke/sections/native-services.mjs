// 소유 범위: download-state·audio-diagnostics·cert-trust·chrome-import·credential-service·ui-state·native-ax.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이고,
//   분리하면서 검사 본문을 바꾸지 않았고, 인구조사 해시가 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/native-services.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  browserRuntime, browserWindowManagerSource, cdpTransportSource, main, mainWindowSource,
  memoWindowManagerSource, nativeAx, pick, record, web, webview,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

export default async function run() {
  console.log("[네이티브 곁일 — 다운로드·오디오·인증서·자격증명·UI 상태]");
  {
    check("다운로드 계획의 상태 전이", () => {
      const ds = require_("../native/electron/download-state.cjs");
      ds.disarm();
      if (ds.snapshot().dir !== null) throw new Error("disarm 뒤에도 폴더가 남는다");
      ds.arm("/tmp/a", false);
      ds.claim("/tmp/a/f.txt");
      if (ds.snapshot().dir !== "/tmp/a") throw new Error("한 번만이 아닌데 폴더가 풀렸다");
      if (ds.snapshot().pending !== "/tmp/a/f.txt") throw new Error("진행 중 경로를 안 잡는다");
      ds.complete("/tmp/a/f.txt", "interrupted");
      const done = ds.snapshot();
      // 실패도 완료로 처리한다. 비우지 않으면 다음 다운로드가 이전 경로를 그대로 쓴다.
      if (done.pending !== null) throw new Error("완료(실패)인데 진행 중 경로가 남는다");
      if (!done.last || done.last.state !== "interrupted") throw new Error("마지막 결과에 실패가 안 남는다");
      ds.arm("/tmp/b", true);
      ds.claim("/tmp/b/g.txt");
      if (ds.snapshot().dir !== null || ds.snapshot().once !== false) throw new Error("한 번만인데 안 풀렸다");
      ds.disarm();
      return true;
    });

    check("AudioService 진단의 env gate와 증가·종료 전이", () => {
      const { createAudioDiagnostics } = require_("../native/electron/audio-diagnostics.cjs");
      const offEvents = {}, offIntervals = [];
      const off = createAudioDiagnostics({
        app: {
          getAppMetrics: () => [],
          on: (name, fn) => { offEvents[name] = fn; },
          once: (name, fn) => { offEvents[name] = fn; },
        },
        env: {},
        log: () => { throw new Error("꺼진 진단이 로그를 남긴다"); },
        setIntervalFn: (fn) => { offIntervals.push(fn); return { unref() {} }; },
      });
      off.start();
      if (offIntervals.length || Object.keys(offEvents).length) throw new Error("env로 껐는데 timer나 listener를 만든다");

      const events = {}, intervals = [], logs = [];
      let metrics = [{ pid: 7, creationTime: 11, type: "Utility", serviceName: "Audio Service", memory: { workingSetSize: 10 } }];
      const diag = createAudioDiagnostics({
        app: {
          getAppMetrics: () => metrics,
          on: (name, fn) => { events[name] = fn; },
          once: (name, fn) => { events[name] = fn; },
        },
        env: { IRIS_AUDIO_DIAG: "1" },
        log: (...args) => logs.push(args.join(" ")),
        setIntervalFn: (fn) => { intervals.push(fn); return { unref() {} }; },
      });
      diag.start();
      if (intervals.length !== 1) throw new Error(`켜진 진단 timer가 ${intervals.length}개`);
      const memoryLogs = () => logs.filter((line) => line.includes('"event":"audio-service-memory"')).length;
      if (memoryLogs() !== 1) throw new Error("첫 AudioService 기준 표본을 안 남긴다");
      metrics = [{ pid: 7, creationTime: 11, type: "Utility", serviceName: "Audio Service", memory: { workingSetSize: 8 } }];
      diag.sample();
      if (memoryLogs() !== 1) throw new Error("감소 표본까지 남긴다");
      metrics = [{ pid: 7, creationTime: 11, type: "Utility", serviceName: "Audio Service", memory: { workingSetSize: 12 } }];
      diag.sample();
      if (memoryLogs() !== 2) throw new Error("증가 표본을 남기지 않는다");
      events["child-process-gone"](null, { type: "Utility", serviceName: "Network Service", reason: "clean-exit" });
      if (logs.some((line) => line.includes("Network Service") && line.includes("audio-service-gone"))) throw new Error("AudioService 아닌 종료를 남긴다");
      events["child-process-gone"](null, { type: "Utility", serviceName: "Audio Service", reason: "crashed" });
      if (!logs.some((line) => line.includes('"event":"audio-service-gone"'))) throw new Error("AudioService 종료를 남기지 않는다");
      return true;
    });

    check("인증서 신뢰는 로컬 자체서명 범위와 한 번의 사람 질문에 묶인다", () => {
      const { createCertificateTrust } = require_("../native/electron/certificate-trust.cjs");
      const handlers = {}, prompts = [];
      const trust = createCertificateTrust({
        appUrl: "http://127.0.0.1:4291/",
        fetchImpl: (url) => { prompts.push(url); return new Promise(() => {}); },
      });
      trust.installCertificateTrust({ on: (name, fn) => { handlers[name] = fn; } });
      const handle = handlers["certificate-error"];
      if (typeof handle !== "function") throw new Error("certificate-error handler를 설치하지 않는다");
      const rejected = (url, error) => {
        let prevented = false, callbackCalled = false;
        const result = handle({ preventDefault: () => { prevented = true; } }, { id: 17 }, url, error,
          { fingerprint: "AA:BB" }, () => { callbackCalled = true; });
        if (prevented || callbackCalled || result !== null) throw new Error(`범위 밖 인증서를 가로챈다: ${url} ${error}`);
      };
      rejected("https://example.com/", "ERR_CERT_AUTHORITY_INVALID");
      rejected("http://localhost:4443/", "ERR_CERT_AUTHORITY_INVALID");
      rejected("https://localhost:4443/", "ERR_CERT_DATE_INVALID");
      if (prompts.length) throw new Error("로컬 자체서명 범위 밖에서 사람에게 묻는다");

      let prevented = 0;
      const event = { preventDefault: () => { prevented++; } };
      const first = handle(event, { id: 17 }, "https://dev.localhost:4443/", "ERR_CERT_AUTHORITY_INVALID",
        { fingerprint: "AA:BB" }, () => {});
      const second = handle(event, { id: 18 }, "https://dev.localhost:4443/", "ERR_CERT_AUTHORITY_INVALID",
        { fingerprint: "AA:BB" }, () => {});
      if (!first || first !== second) throw new Error("같은 host와 지문의 질문 Promise를 함께 쓰지 않는다");
      if (prevented !== 2) throw new Error("허용 후보 certificate-error를 기본 거절에서 인계받지 않는다");
      if (prompts.length !== 1) throw new Error(`같은 host를 ${prompts.length}번 묻는다`);
      if (!prompts[0].includes("/dialog-ask?noplan=1&")) throw new Error("prompt URL에서 noplan=1이 사라졌다");
      return true;
    });

    check("Chrome import 장부는 cid 중복·저장 복원·깨진 파일을 보존한다", () => {
      const { createChromeImportRegistry } = require_("../native/electron/chrome-import-registry.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-chrome-imports-"));
      try {
        const make = () => createChromeImportRegistry({ stateDir: dir, fs: { ...require_("node:fs") }, path, now: () => 123 });
        const entry = { browser: { id: "chrome" }, profile: "Default", label: "Work", account: "", gaia: "" };
        const first = make();
        if (first.profileCid(entry) !== "chrome:Default") throw new Error("cid가 browser.id와 profile 조합이 아니다");
        first.note(entry, "persist:acprof:a");
        first.note(entry, "persist:acprof:b");
        if (first.list().length !== 2 || !first.latestForPartition("persist:acprof:a")) throw new Error("다른 partition의 연결을 덮어썼다");
        if (first.latestForPartition("persist:acprof:b")?.cid !== "chrome:Default") throw new Error("최신 partition 연결을 못 찾는다");
        const restored = make().list();
        if (restored.length !== 2 || restored.some((row) => row.cid !== "chrome:Default")) {
          throw new Error("저장했다 다시 읽은 장부가 다르다");
        }
        if (existsSync(path.join(dir, "chrome-imports.json.tmp"))) throw new Error("원자 저장 tmp가 남는다");
        writeFileSync(path.join(dir, "chrome-imports.json"), "{broken");
        if (make().list().length !== 0) throw new Error("깨진 파일을 빈 장부로 읽지 않는다");
        return true;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    check("자격증명 서비스는 비밀번호 비노출·정확 조회·읽기 실패 보존을 지킨다", () => {
      const { createCredentialService } = require_("../native/electron/credential-service.cjs");
      const fsMod = require_("node:fs");
      const safe = {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from("enc:" + text),
        decryptString: (buf) => {
          const text = buf.toString("utf8");
          if (!text.startsWith("enc:")) throw new Error("깨진 암호문");
          return text.slice(4);
        },
      };
      const dir = mkdtempSync(path.join(tmpdir(), "iris-credential-service-"));
      try {
        const service = createCredentialService({ stateDir: dir, fs: fsMod, safeStorage: safe });
        service.set("persist:acprof:a", [
          { origin: "https://a.test", url: "https://a.test/one", username: "alice", password: "old" },
          { origin: "https://a.test", url: "https://a.test/two", username: "alice", password: "new" },
          { origin: "https://b.test", url: "https://b.test/", username: "bob", password: "other" },
        ]);
        const listed = service.listForOrigin("persist:acprof:a", "https://a.test");
        if (listed.length !== 1 || listed[0].username !== "alice") throw new Error("정확한 origin 목록이 아니다");
        if (listed.some((row) => Object.prototype.hasOwnProperty.call(row, "password"))) throw new Error("목록에 password가 실린다");
        if (service.passwordFor("persist:acprof:a", "https://a.test", "alice") !== "new") throw new Error("정확한 계정의 마지막 값을 못 찾는다");
        if (service.passwordFor("persist:acprof:a", "https://b.test", "alice") !== undefined) throw new Error("다른 origin에 password를 준다");
        if (service.passwordFor("persist:acprof:a", "https://a.test", "bob") !== undefined) throw new Error("다른 계정에 password를 준다");

        const lockedDir = path.join(dir, "locked");
        fsMod.mkdirSync(lockedDir);
        const lockedFile = path.join(lockedDir, "creds.enc");
        const original = Buffer.from('enc:{"persist:old":[]}');
        fsMod.writeFileSync(lockedFile, original);
        const locked = createCredentialService({
          stateDir: lockedDir,
          fs: fsMod,
          safeStorage: { ...safe, decryptString: () => { throw new Error("Keychain 잠김"); } },
          now: () => new Date(2026, 7, 19, 17, 5, 9),
        });
        locked.set("persist:new", [{ origin: "https://new.test", username: "new", password: "secret" }]);
        const kept = lockedFile + ".unreadable-20260819-170509";
        if (!existsSync(kept) || !fsMod.readFileSync(kept).equals(original)) throw new Error("읽을 수 없는 vault 원본을 보존하지 않는다");
        return true;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    check("UI 상태는 부분 patch를 병합하고 깨진 파일을 비운다", () => {
      const store = require_("../native/electron/ui-state-store.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-ui-state-"));
      try {
        writeFileSync(path.join(dir, "ui-state.json"), JSON.stringify({ kept: 1, nested: { left: true } }));
        store.writeUiState(dir, { added: 2 });
        const merged = store.readUiState(dir);
        if (merged.kept !== 1 || merged.added !== 2 || merged.nested?.left !== true) {
          throw new Error("부분 patch가 기존 값을 보존하지 않는다");
        }
        writeFileSync(path.join(dir, "ui-state.json"), "{broken");
        const broken = store.readUiState(dir);
        if (!broken || Object.keys(broken).length) throw new Error("깨진 파일을 빈 상태로 읽지 않는다");
        return true;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    check("네이티브 창 조회가 실행 파일 이름을 따라간다", () => {
      // `"Electron"`으로 고정되면 설치된 앱(프로세스 이름 `Iris`)에서 이 경로가 언제나
      // "앱 프로세스를 찾지 못했습니다"가 된다. 상수로 되돌리면 같은 실패가 재발한다.
      return /const AX_APP = path\.basename\(process\.execPath\);/.test(nativeAx)
        // 음성 조건은 native 전체를 본다. 한 파일로 좁히면 다른 모듈에 상수가 생겨도 통과한다.
        && !/const AX_APP = "(Electron|Iris)"/.test(readAll("native"));
    });
  }
}
