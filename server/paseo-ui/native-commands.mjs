// Paseo 릴리스 소스에서 기본 터미널 명령을 확인할 수 있는 제공자만 수록
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { geminiCliPin } from "./gemini-history.mjs";

export async function readNativeCommandTemplates(source) {
  const require = createRequire(path.join(source, "package.json"));
  const { build } = require("esbuild");
  const app = path.join(source, "packages/app");
  const { outputFiles } = await build({
    stdin: {
      contents: `export { PROVIDER_COMMAND_TEMPLATES as commands } from "./src/utils/provider-command-templates.ts";`,
      resolveDir: app,
    },
    bundle: true, write: false, platform: "node", format: "esm",
  });
  const { commands } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
  return Object.fromEntries(Object.entries(commands).flatMap(([id, command]) => {
    const argv = command.resume?.split(/\s+/);
    return /^[a-z][a-z0-9-]*$/.test(id) && argv?.[0] === id && argv.at(-1) === "{sessionId}" &&
      argv.slice(1, -1).every((token) => /^[A-Za-z0-9-]+$/.test(token)) ? [[id, argv]] : [];
  }));
}

export function nativeHandoffArgs(provider, sessionId, empty, commands) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || "")) throw new Error("제공자 세션 ID를 확인할 수 없습니다");
  const command = commands[provider];
  if (!command) return null;
  const template = empty ? command.start : command.resume;
  return template?.map((part) => part === "{sessionId}" ? sessionId : part) ?? null;
}

export function nativeHandoffCommands(templates, overrides, pluginIds = {}) {
  const result = Object.fromEntries(Object.entries(templates).map(([id, resume]) => [id, { resume }]));
  if (result.claude) result.claude.start = ["claude", "--session-id", "{sessionId}"];
  const gemini = overrides.gemini?.command;
  if (geminiCliPin(gemini)) {
    const command = gemini.slice(0, -1);
    result.gemini = { resume: [...command, "--resume", "{sessionId}"], start: [...command, "--session-id", "{sessionId}"] };
  }
  if (pluginIds.antigravity === "antigravity-provider") result.antigravity = { resume: ["agy", "--conversation", "{sessionId}"] };
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [source, output] = process.argv.slice(2);
  await writeFile(output, JSON.stringify(Object.keys(await readNativeCommandTemplates(source))));
}
