// 소유 범위: Mac 원격 화면에서 하는 Tailscale 준비(설치·서비스 켜기·로그인·연결 상태)
// 제공 API: createTailscaleSetup(options)
// 의존 대상: network.js 의 CLI 탐색, brew·osascript·open 실행 파일
// 유지 조건: 실행 인자는 고정 경로와 검사한 사용자 이름만. 관리자 권한은 macOS 암호 창으로만
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { windowsPowerShellEnv } from "../windows-powershell.cjs";
import { findTailscaleExecutable } from "./network.js";

const execFile = promisify(execFileCallback);
const BREW_EXECUTABLES = Object.freeze(["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
// 휴대폰 Tailscale 설치 주소
export const PHONE_INSTALL_URL = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
const LOGIN_LIMIT_MS = 5 * 60_000;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function failure(code) {
  return { ok: false, error: code };
}

export function createTailscaleSetup(options = {}) {
  const windows = (options.platform || process.platform) === "win32";
  const run = options.execFile || execFile;
  const spawn = options.spawn || spawnChild;
  const access = options.access || fs.access;
  const findCli = options.findExecutable || (() => findTailscaleExecutable({ access }));
  const username = options.username || os.userInfo().username;
  const onChange = options.onChange || (() => {});
  let busy = null;
  let loginChild = null;
  let loginTimer = null;
  let lastError = null;

  async function findBrew() {
    if (windows) {
      try { await run("winget.exe", ["--version"], { timeout: 5000 }); return "winget.exe"; } catch { return null; }
    }
    for (const candidate of BREW_EXECUTABLES) {
      try { await access(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
    return null;
  }

  async function cliOrNull() {
    try { return await findCli(); } catch { return null; }
  }

  async function status() {
    const base = { busy, loginPending: !!loginChild, error: lastError };
    const cli = await cliOrNull();
    if (!cli) return { ...base, phase: "not-installed", canInstall: !!await findBrew() };
    let parsed;
    try {
      const { stdout } = await run(cli, ["status", "--json"], { timeout: 3_000, maxBuffer: 1024 * 1024 });
      parsed = JSON.parse(String(stdout || ""));
    } catch {
      return { ...base, phase: "daemon-off" };
    }
    const state = parsed?.BackendState;
    if (state === "Running") {
      const address = (parsed.Self?.TailscaleIPs || []).find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value)) || null;
      const tailnet = typeof parsed.CurrentTailnet?.Name === "string" ? parsed.CurrentTailnet.Name : null;
      // 같은 tailnet 의 휴대폰. 연결 순서의 휴대폰 Tailscale 단계 판정용
      const phones = Object.values(parsed.Peer || {})
        .filter((peer) => /^(android|ios)$/i.test(String(peer?.OS || "")))
        .map((peer) => ({ name: String(peer.HostName || "").slice(0, 80), online: peer.Online === true }));
      return { ...base, phase: "running", address, tailnet, phones };
    }
    if (state === "NeedsLogin" || state === "NoState") {
      // 로그인 주소는 이 Mac 의 Iris 화면이 Iris 탭으로 열도록 전달
      const authUrl = typeof parsed.AuthURL === "string" && /^https:\/\/[A-Za-z0-9.-]+\/\S*$/.test(parsed.AuthURL)
        ? parsed.AuthURL : null;
      return { ...base, phase: "needs-login", authUrl };
    }
    if (state === "Stopped") return { ...base, phase: "stopped" };
    if (state === "NeedsMachineAuth") return { ...base, phase: "needs-approval" };
    return { ...base, phase: "starting" };
  }

  async function exclusive(name, task) {
    if (busy) return failure("tailscale-busy");
    busy = name;
    lastError = null;
    onChange();
    try {
      const result = await task();
      if (result?.ok === false) lastError = result.error;
      return result;
    } catch {
      lastError = `tailscale-${name}-failed`;
      return failure(lastError);
    } finally {
      busy = null;
      onChange();
    }
  }

  function install() {
    return exclusive("install", async () => {
      if (await cliOrNull()) return { ok: true, unchanged: true };
      const brew = await findBrew();
      if (!brew) return failure(windows ? "tailscale-winget-not-found" : "tailscale-brew-not-found");
      if (windows) {
        await run(brew, ["install", "--id", "Tailscale.Tailscale", "--exact", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements"], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
        return await cliOrNull() ? { ok: true } : failure("tailscale-cli-not-found");
      }
      await run(brew, ["install", "tailscale"], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true };
    });
  }

  function start() {
    return exclusive("start", async () => {
      const cli = await cliOrNull();
      if (!cli) return failure("tailscale-cli-not-found");
      if (windows) {
        const inner = "$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); Start-Service -Name Tailscale";
        const encoded = Buffer.from(inner, "utf16le").toString("base64");
        const script = `$p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
        await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 5 * 60_000, maxBuffer: 64 * 1024, env: windowsPowerShellEnv() });
        return { ok: true };
      }
      if (cli === APP_CLI) {
        await run("/usr/bin/open", ["-a", "Tailscale"], { timeout: 10_000 });
        return { ok: true };
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username)) return failure("tailscale-start-failed");
      const daemon = path.join(path.dirname(cli), "tailscaled");
      try { await access(daemon, fs.constants.X_OK); } catch { return failure("tailscale-daemon-not-found"); }
      // 서비스 등록 뒤 이 사용자에게 로그인·연결 권한 부여(이후 명령은 암호 없이)
      const script = [
        `${shellQuote(daemon)} install-system-daemon`,
        `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do ${shellQuote(cli)} set --operator=${shellQuote(username)} >/dev/null 2>&1 && exit 0; sleep 0.5; done`,
        "exit 1",
      ].join("; ");
      try {
        await run("/usr/bin/osascript", ["-e", `do shell script ${appleScriptString(script)} with administrator privileges`],
          { timeout: 5 * 60_000, maxBuffer: 64 * 1024 });
      } catch (cause) {
        // osascript 의 사용자 취소 번호
        if (/-128/.test(String(cause?.stderr || cause?.message || ""))) return failure("tailscale-start-cancelled");
        return failure("tailscale-start-failed");
      }
      return { ok: true };
    });
  }

  function stopLogin() {
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    if (loginChild) {
      try { loginChild.kill(); } catch {}
      loginChild = null;
    }
  }

  // 로그인 주소 받기(로그인 전) 또는 연결(로그인 뒤). 주소는 status() 의 authUrl 로 전달
  function connect() {
    return exclusive("connect", async () => {
      const cli = await cliOrNull();
      if (!cli) return failure("tailscale-cli-not-found");
      if (loginChild) return { ok: true };
      const child = spawn(cli, ["up", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
      loginChild = child;
      loginTimer = setTimeout(stopLogin, LOGIN_LIMIT_MS);
      let output = "";
      let announced = false;
      // tailscale up 은 주소를 받기까지 수십 초 걸림. 받으면 화면에 바로 알림
      const onData = (chunk) => {
        output = (output + chunk).slice(-64 * 1024);
        if (!announced && /AuthURL|https:\/\//.test(output)) {
          announced = true;
          onChange();
        }
      };
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", () => {
        if (loginChild === child) {
          loginChild = null;
          if (loginTimer) clearTimeout(loginTimer);
          loginTimer = null;
          onChange();
        }
      });
      // 로그인 완료는 브라우저에서 끝나므로 시작 결과만 반환. 이후 상태는 status() 로 확인
      const early = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 1_500);
        child.on("error", () => { clearTimeout(timer); resolve("spawn"); });
        child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? null : "exit"); });
      });
      if (early === "spawn") return failure("tailscale-connect-failed");
      if (early === "exit") {
        if (/access denied|operator/i.test(output)) return failure("tailscale-operator-required");
        return failure("tailscale-connect-failed");
      }
      return { ok: true };
    });
  }

  function close() {
    stopLogin();
  }

  return { status, install, start, connect, close };
}
