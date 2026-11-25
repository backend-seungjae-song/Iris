import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("릴리스의 기본 제공자와 ACP 설정, 플러그인 ID를 세션 실행 파일로 만든다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-paseo-providers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const esbuild = path.dirname(createRequire(import.meta.url).resolve("esbuild/package.json"));
  fs.mkdirSync(path.join(root, "source", "node_modules"), { recursive: true });
  fs.symlinkSync(esbuild, path.join(root, "source", "node_modules", "esbuild"), "junction");
  write("source/packages/app/src/data/acp-provider-catalog.ts", `
    export const ACP_PROVIDER_CATALOG = [
      { id: "fixture", title: "Fixture ACP", command: ["fixture", "acp"] },
      { id: "bundled", title: "Bundled ACP", bundledProvider: { hostFeature: "bundledFeature" } },
    ];
  `);
  write("source/packages/app/src/hooks/use-acp-provider-catalog.ts", `
    export function buildAcpProviderConfigPatch(entry, hostSupports) {
      const patch = entry.bundledProvider && hostSupports(entry.bundledProvider.hostFeature)
        ? { enabled: true }
        : { extends: "acp", command: entry.command, env: { FIXTURE: "upstream" } };
      return { providers: { [entry.id]: patch } };
    }
  `);
  const modules = "runtime/node_modules/@getpaseo";
  write(`${modules}/protocol/package.json`, '{"type":"module","exports":{"./provider-manifest":"./manifest.js"}}');
  write(`${modules}/protocol/manifest.js`, `export const AGENT_PROVIDER_DEFINITIONS = [
    { id: "native", label: "Fixture Native" },
    { id: "opt-in", label: "Fixture Opt-in", enabledByDefault: false },
  ];`);
  write(`${modules}/server/package.json`, '{"type":"module","main":"exports.js"}');
  write(`${modules}/server/exports.js`, "");
  write(`${modules}/server/plugins/builtin/index.js`, `
    import { fileURLToPath } from "node:url";
    export const builtinPlugins = ["fixture-provider"];
    export const resolveBuiltinPluginsRoot = () => fileURLToPath(new URL("../../builtin-plugins/", import.meta.url));
  `);
  write(`${modules}/server/builtin-plugins/fixture-provider/paseo-plugin.json`, '{"id":"fixture-provider"}');
  write(`${modules}/server/builtin-plugins/fixture-provider/index.server.ts`, `
    export default function contribute({ registerProvider }) {
      registerProvider({ id: "bundled", label: "Fixture Plugin", requiresConfiguration: true });
    }
  `);
  const command = fileURLToPath(new URL("../server/paseo-ui/managed-provider-catalog.js", import.meta.url));

  await promisify(execFile)(process.execPath, [command, path.join(root, "source"), path.join(root, "runtime")]);

  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, "runtime", file), "utf8"));
  assert.deepEqual(read("providers.json"), [
    { id: "native", label: "Fixture Native" }, { id: "opt-in", label: "Fixture Opt-in" },
    { id: "bundled", label: "Bundled ACP" }, { id: "fixture", label: "Fixture ACP" },
  ]);
  assert.deepEqual(read("provider-overrides.json"), {
    "opt-in": { enabled: true }, bundled: { enabled: true },
    fixture: { extends: "acp", command: ["fixture", "acp"], env: { FIXTURE: "upstream" } },
  });
  assert.deepEqual(read("provider-plugins.json"), { bundled: "fixture-provider" });
});
