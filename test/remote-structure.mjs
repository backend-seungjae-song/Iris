import assert from "node:assert/strict";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = path.join(ROOT, "server", "remote");

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(full) : [full];
  });
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function absolute(file) {
  return path.resolve(ROOT, file.split("/").join(path.sep));
}

async function analyze() {
  const resolutions = [];
  const built = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: filesBelow(REMOTE).filter((file) => file.endsWith(".js")
      || file.endsWith(".cjs") || file === path.join(REMOTE, "agent-endpoint.mjs")).map(relative),
    bundle: true,
    write: false,
    metafile: true,
    outdir: "out",
    outbase: ".",
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
    plugins: [{
      name: "remote-imports",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind !== "entry-point") {
            resolutions.push({
              importer: args.importer ? (path.isAbsolute(args.importer) ? args.importer : path.resolve(ROOT, args.importer)) : null,
              path: args.path,
            });
          }
          return null;
        });
      },
    }],
  });
  const inputs = new Map();
  for (const [name, info] of Object.entries(built.metafile.inputs)) {
    inputs.set(absolute(name), {
      imports: info.imports.map((item) => ({ ...item, target: item.external ? null : absolute(item.path) })),
    });
  }
  return { inputs, resolutions };
}

test("게이트웨이 import는 gateway와 contract 안에만 머문다", async () => {
  const analysis = await analyze();
  const gatewayRoot = path.join(REMOTE, "gateway");
  const contractRoot = path.join(REMOTE, "contract");
  const entry = path.join(gatewayRoot, "child.js");
  const within = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const item of analysis.inputs.get(file)?.imports || []) {
      if (item.external) {
        assert.equal(isBuiltin(item.path) || item.path === "ws", true, `${file}: ${item.path}`);
      } else {
        assert.ok(item.target && (within(item.target, gatewayRoot) || within(item.target, contractRoot)), `${file}: ${item.path}`);
        stack.push(item.target);
      }
    }
  }
});

test("원격 상태 파일은 stateHome 경로만 사용한다", async () => {
  const analysis = await analyze();
  const stateHomeFile = path.join(ROOT, "server", "state-home.cjs");
  const networkFile = path.join(REMOTE, "network.js");
  const installerFile = path.join(REMOTE, "installer.js");
  const tailscaleSetupFile = path.join(REMOTE, "tailscale-setup.js");
  const sourceControlFeatureFile = path.join(REMOTE, "features", "source-control.js");
  const suppliedPathHelpers = new Map([
    [path.join(REMOTE, "windows-private.cjs"), /fs\.lstatSync\(file\)/g],
    [path.join(REMOTE, "agent-endpoint.mjs"), /fs\.readFileSync\(socketPath, 'utf8'\)/g],
  ]);
  const executableEnvironment = new Map([
    [networkFile, /\bprocess\.env\.(?:PATH|ProgramFiles)\b/g],
    [sourceControlFeatureFile, /\bprocess\.env\.PATH\b/g],
  ]);
  for (const [file, info] of analysis.inputs) {
    if (file !== REMOTE && !file.startsWith(`${REMOTE}${path.sep}`)) continue;
    const source = fs.readFileSync(file, "utf8");
    const external = new Set(info.imports.filter((item) => item.external).map((item) => item.path));
    const importsFs = [...external].some((name) => ["fs", "fs/promises", "node:fs", "node:fs/promises"].includes(name));
    const importsStateHome = info.imports.some((item) => item.target === stateHomeFile);
    if (suppliedPathHelpers.has(file)) {
      // 호출자가 지정한 경로만 사용하는 Windows 도우미
      const calls = [...source.matchAll(/\bfs\.\w+\s*\(/g)];
      assert.equal(calls.length, 1, file);
      assert.equal([...source.matchAll(suppliedPathHelpers.get(file))].length, 1, file);
      assert.equal(info.imports.some((item) => ["path", "node:path", "os", "node:os"].includes(item.path)), false, file);
    } else if (importsFs && file !== networkFile && file !== installerFile && file !== tailscaleSetupFile
      && file !== sourceControlFeatureFile) assert.equal(importsStateHome, true, file);
    const environmentRead = /\bprocess\s*(?:\?\.|\.)\s*env\b/;
    if (executableEnvironment.has(file)) {
      // Windows 실행 파일 탐색용 환경변수와 macOS 기존 계약
      for (const [, method] of source.matchAll(/\bfs\s*\.\s*(\w+)/g)) {
        assert.ok(["access", "accessSync", "constants"].includes(method), `${file}: fs.${method}`);
      }
      assert.equal(environmentRead.test(source.replace(executableEnvironment.get(file), "executableDirectory")), false, file);
      const mac = await esbuild.transform(source, { define: { "process.platform": '"darwin"' }, minifySyntax: true });
      assert.equal(environmentRead.test(mac.code), false, `${file}: macOS`);
    } else assert.equal(environmentRead.test(source), false, file);
    assert.equal(/["']~(?:[\\/]|["'])/.test(source), false, file);
  }
});

test("원격 외부 의존성은 게이트웨이·QR·Windows 인증서에만 허용한다", async () => {
  const analysis = await analyze();
  const gatewayRoot = path.join(REMOTE, "gateway");
  const pairingFile = path.join(REMOTE, "pairing.js");
  const certificateFile = path.join(REMOTE, "certificate.js");
  for (const item of analysis.resolutions) {
    if (!item.importer || (item.importer !== REMOTE && !item.importer.startsWith(`${REMOTE}${path.sep}`))) continue;
    assert.equal(path.isAbsolute(item.path), false, `${item.importer}: ${item.path}`);
  }
  for (const [file, info] of analysis.inputs) {
    if (file !== REMOTE && !file.startsWith(`${REMOTE}${path.sep}`)) continue;
    for (const item of info.imports) {
      if (!item.external || isBuiltin(item.path)) continue;
      assert.equal((file.startsWith(`${gatewayRoot}${path.sep}`) && item.path === "ws")
        || (file === pairingFile && item.path === "uqr")
        || (file === certificateFile && item.kind === "dynamic-import"
          && ["asn1js", "pkijs"].includes(item.path)), true, `${file}: ${item.path}`);
    }
  }
});
