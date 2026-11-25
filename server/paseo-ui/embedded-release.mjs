import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEmbeddedRuntime } from "./embedded-runtime.mjs";
import { writeManagedProviderCatalog } from "./managed-provider-catalog.js";
import { nativeHandoffCommands, readNativeCommandTemplates } from "./native-commands.mjs";

const run = promisify(execFile);

export async function herdrProviderCatalog(providers, bin) {
  const catalog = [];
  for (const provider of providers) {
    let result;
    try {
      const { stdout } = await run(bin, ["agent", "explain", "--file", devNull, "--agent", provider.id, "--json"], {
        timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      result = JSON.parse(stdout);
    } catch {
      // Herdr 구버전은 파일 기반 판정을 지원하지 않으므로 릴리스의 제공자 이름을 사용
      return providers;
    }
    const id = result?.agent;
    catalog.push(result?.manifest_version && typeof id === "string" && id !== provider.id && /^[a-z][a-z0-9-]*$/.test(id)
      ? { ...provider, herdrId: id } : provider);
  }
  return catalog;
}

export async function prepareEmbeddedRuntime({ source, runtime, herdrBin = process.env.HERDR_BIN || "herdr" }) {
  await writeManagedProviderCatalog(source, runtime, { embedded: true });
  const overrides = JSON.parse(await readFile(join(runtime, "provider-overrides.json"), "utf8"));
  const pluginIds = JSON.parse(await readFile(join(runtime, "provider-plugins.json"), "utf8"));
  const commands = nativeHandoffCommands(await readNativeCommandTemplates(source), overrides, pluginIds);
  await writeFile(join(runtime, "native-handoff-commands.json"), JSON.stringify(commands));
  const stateDir = await mkdtemp(join(runtime, ".embedded-check-"));
  const embedded = createEmbeddedRuntime({ runtime, stateDir });
  try {
    const catalog = JSON.parse(await readFile(join(runtime, "providers.json"), "utf8"));
    const configured = await embedded.providers();
    if (catalog.some(({ id }) => !configured.includes(id))) throw new Error("Paseo 제공자 목록과 실행 코드가 일치하지 않습니다");
    await writeFile(join(runtime, "providers.json"), JSON.stringify(await herdrProviderCatalog(catalog, herdrBin)));
  } finally {
    await embedded.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [source, runtime, herdrBin] = process.argv.slice(2);
  if (![4, 5].includes(process.argv.length) || !isAbsolute(source) || !isAbsolute(runtime)) {
    throw new Error("Paseo 소스와 실행 폴더의 절대 경로를 지정하세요.");
  }
  await prepareEmbeddedRuntime({ source, runtime, herdrBin });
}
