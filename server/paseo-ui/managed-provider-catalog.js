import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function writeManagedProviderCatalog(source, runtime, { embedded = false } = {}) {
  const require = createRequire(path.join(runtime, "package.json"));
  const { build } = createRequire(path.join(source, "package.json"))("esbuild");
  const server = require.resolve("@getpaseo/server");
  const builtin = path.join(path.dirname(server), "plugins", "builtin", "index.js");
  const { builtinPlugins, resolveBuiltinPluginsRoot } = await import(pathToFileURL(builtin).href);
  const root = resolveBuiltinPluginsRoot();
  const plugins = builtinPlugins.filter((id) => id.endsWith("-provider")).map((id) => {
    const directory = path.join(root, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "paseo-plugin.json"), "utf8"));
    if (manifest.id !== id) throw new Error(`Paseo 플러그인 ID가 일치하지 않습니다 (${id})`);
    return { id, entry: path.join(directory, "index.server.ts") };
  });
  const app = path.join(source, "packages", "app");
  const temp = fs.mkdtempSync(path.join(runtime, ".provider-catalog-"));
  try {
    const bundle = path.join(temp, "catalog.mjs");
    await build({
      stdin: {
        contents: catalogEntry(app, require.resolve("@getpaseo/protocol/provider-manifest"), plugins),
        resolveDir: runtime,
      },
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      external: ["@getpaseo/plugin/*", "zod"],
      tsconfigRaw: { compilerOptions: { baseUrl: app, paths: { "@/*": ["./src/*"] } } },
    });
    const { providers, overrides, pluginIds } = await collectProviders(await import(pathToFileURL(bundle).href));
    for (const [name, data] of [
      ["provider-overrides.json", overrides],
      ["provider-plugins.json", pluginIds],
      ["providers.json", providers],
    ]) {
      const staged = path.join(temp, name);
      fs.writeFileSync(staged, JSON.stringify(data));
      fs.renameSync(staged, path.join(runtime, name));
    }
    if (embedded) {
      const bundle = path.join(temp, "embedded-providers.mjs");
      await build({
        stdin: { contents: pluginEntries(plugins), resolveDir: runtime },
        outfile: bundle,
        bundle: true,
        format: "esm",
        platform: "node",
        packages: "external",
      });
      fs.renameSync(bundle, path.join(runtime, "embedded-providers.mjs"));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function catalogEntry(app, protocol, plugins) {
  const fromApp = (file) => JSON.stringify(path.join(app, "src", file));
  return `
export { AGENT_PROVIDER_DEFINITIONS } from ${JSON.stringify(protocol)};
export { ACP_PROVIDER_CATALOG } from ${fromApp("data/acp-provider-catalog.ts")};
export { buildAcpProviderConfigPatch } from ${fromApp("hooks/use-acp-provider-catalog.ts")};
${pluginEntries(plugins)}`;
}

function pluginEntries(plugins) {
  return `
${plugins.map(({ entry }, index) => `import contribute${index} from ${JSON.stringify(entry)};`).join("\n")}
export const plugins = [${plugins.map(({ id }, index) => `[${JSON.stringify(id)}, contribute${index}]`).join(", ")}];
`;
}

async function collectProviders({ AGENT_PROVIDER_DEFINITIONS, ACP_PROVIDER_CATALOG, buildAcpProviderConfigPatch, plugins }) {
  const menu = new Map();
  const pluginIds = Object.create(null);
  const overrides = Object.create(null);
  for (const { id, label, enabledByDefault } of AGENT_PROVIDER_DEFINITIONS) {
    menu.set(id, { id, label });
    if (enabledByDefault === false) overrides[id] = { enabled: true };
  }
  for (const [pluginId, contribute] of plugins) {
    const cleanup = await contribute({
      registerProvider({ id, label, requiresConfiguration }) {
        if (menu.has(id)) throw new Error(`Paseo 제공자 ID가 중복됩니다 (${id})`);
        pluginIds[id] = pluginId;
        menu.set(id, { id, label });
        if (requiresConfiguration) overrides[id] = { enabled: true };
      },
      registerUsageSource() {},
    });
    await cleanup?.();
  }

  for (const entry of ACP_PROVIDER_CATALOG) {
    const plugin = pluginIds[entry.id];
    if (menu.has(entry.id) && !plugin) continue;
    const { providers } = buildAcpProviderConfigPatch(entry, (feature) =>
      Boolean(plugin && feature === entry.bundledProvider?.hostFeature));
    overrides[entry.id] = providers[entry.id];
    menu.set(entry.id, { id: entry.id, label: entry.title });
  }
  return { providers: [...menu.values()], overrides, pluginIds };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [source, runtime] = process.argv.slice(2);
  if (process.argv.length !== 4 || !path.isAbsolute(source) || !path.isAbsolute(runtime)) {
    throw new Error("Paseo 소스와 실행 폴더의 절대 경로를 지정하세요.");
  }
  await writeManagedProviderCatalog(source, runtime);
}
