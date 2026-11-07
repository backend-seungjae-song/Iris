import fs from "node:fs";
import path from "node:path";

import { bundleDifferences } from "./bundle-generation.mjs";
import { listFiles, relativePath } from "./util.mjs";

const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".json", ".html", ".css"];
const DYNAMIC_KINDS = ["threadEntrypoints", "workerModules", "executables", "platformScripts", "assets"];

function addFound(found, spec, kind, priority) {
  if (!spec) return;
  const previous = found.get(spec);
  if (!previous || priority > previous.priority) found.set(spec, { spec, kind, priority });
}

function matches(source, expression, callback) {
  for (const match of source.matchAll(expression)) callback(match);
}

export function extractDependencies(relative, source) {
  const found = new Map();
  if (relative.endsWith(".html")) {
    matches(source, /\b(?:src|href)\s*=\s*["']([^"']+)["']/g, (match) => addFound(found, match[1], "asset", 10));
  } else if (relative.endsWith(".css")) {
    matches(source, /(?:@import\s+|url\(\s*)["']?([^"')\s]+)["']?\s*\)?/g, (match) => addFound(found, match[1], "asset", 10));
  } else {
    matches(source, /\bfork\s*\(\s*(?:fileURLToPath\s*\(\s*)?new\s+URL\s*\(\s*["']([^"']+)["']/g, (match) => addFound(found, match[1], "childProcessEntrypoint", 120));
    matches(source, /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*["']([^"']+)["']/g, (match) => addFound(found, match[1], "threadEntrypoint", 100));
    matches(source, /\bworkerData\s*:\s*\{[\s\S]{0,800}?\bmodule\s*:\s*(?:String\s*\(\s*)?new\s+URL\s*\(\s*["']([^"']+)["']/g, (match) => addFound(found, match[1], "workerModule", 90));
    matches(source, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, (match) => addFound(found, match[1], "dynamicImport", 60));
    matches(source, /\brequire(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/g, (match) => addFound(found, match[1], "require", 60));
    matches(source, /\b(?:import|export)\s+(?:[^"'();]*?\s+from\s+)?["']([^"']+)["']/g, (match) => addFound(found, match[1], "import", 60));
    matches(source, /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g, (match) => addFound(found, match[1], "newUrl", 40));
    matches(source, /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["']([^"']+)["']/g, (match) => addFound(found, match[1], "executable", 30));
    matches(source, /\b(?:readFile|readFileSync)\s*\(\s*(?:new\s+URL\s*\(\s*)?["']([^"']+)["']/g, (match) => addFound(found, match[1], "asset", 20));
  }
  return [...found.values()].map(({ spec, kind }) => ({ spec, kind }));
}

function resolveDependency(root, from, spec) {
  const withoutSuffix = spec.replace(/[?#].*$/, "");
  if (!withoutSuffix || withoutSuffix.startsWith("node:") || /^[a-z]+:/i.test(withoutSuffix)) return null;
  let base;
  if (withoutSuffix.startsWith("/")) {
    if (!from.startsWith("web/")) return null;
    base = path.join(root, "web", withoutSuffix.slice(1));
  } else if (withoutSuffix.startsWith(".")) {
    base = path.resolve(root, path.dirname(from), withoutSuffix);
  } else {
    return null;
  }
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(root, candidate).replaceAll("\\", "/");
  }
  for (const extension of EXTENSIONS.slice(1)) {
    const candidate = path.join(base, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(root, candidate).replaceAll("\\", "/");
  }
  return null;
}

function dynamicKind(kind) {
  return {
    threadEntrypoint: "threadEntrypoints",
    workerModule: "workerModules",
    childProcessEntrypoint: "executables",
    executable: "executables",
    platformScript: "platformScripts",
    asset: "assets",
  }[kind];
}

function unitGraph(root, name, config, processEntryOwners) {
  const entrypoints = (config.entrypoints || []).map(relativePath);
  const queue = [];
  const paths = new Map();
  const missing = [];
  const dynamic = Object.fromEntries(DYNAMIC_KINDS.map((kind) => [kind, []]));
  const processBoundaries = [];
  const enqueue = (file, entrypoint, chain) => {
    if (paths.has(file)) return;
    paths.set(file, { unit: name, entrypoint, chain });
    queue.push(file);
  };
  for (const entrypoint of entrypoints) {
    if (fs.existsSync(path.join(root, entrypoint))) enqueue(entrypoint, entrypoint, []);
    else missing.push(entrypoint);
  }
  for (const kind of DYNAMIC_KINDS) {
    for (const raw of config.dynamic?.[kind] || []) {
      const file = relativePath(raw);
      if (!fs.existsSync(path.join(root, file))) { missing.push(file); continue; }
      dynamic[kind].push(file);
      enqueue(file, file, [{ from: null, to: file, kind }]);
    }
  }
  while (queue.length) {
    const current = queue.shift();
    const absolute = path.join(root, current);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`의존 그래프에 심볼릭 링크가 있습니다: ${current}`);
    if (!stat.isFile() || !/\.(?:[cm]?js|json|html|css)$/i.test(current)) continue;
    let source;
    try { source = fs.readFileSync(absolute, "utf8"); }
    catch { continue; }
    for (const dependency of extractDependencies(current, source)) {
      const target = resolveDependency(root, current, dependency.spec);
      if (!target) continue;
      const record = paths.get(current);
      const edge = { from: current, to: target, kind: dependency.kind };
      const targetOwners = processEntryOwners.get(target) || [];
      if (["childProcessEntrypoint", "newUrl"].includes(dependency.kind)
        && targetOwners.some((owner) => owner !== name)) {
        processBoundaries.push({ ...edge, targetUnits: targetOwners });
        continue;
      }
      const category = dynamicKind(dependency.kind);
      if (category && !dynamic[category].includes(target)) dynamic[category].push(target);
      enqueue(target, record.entrypoint, [...record.chain, edge]);
    }
  }
  for (const kind of DYNAMIC_KINDS) dynamic[kind].sort();
  return { entrypoints, files: [...paths.keys()].sort(), paths, dynamic, missing: [...new Set(missing)].sort(), processBoundaries };
}

export function defaultExecutionUnits(root) {
  const preload = listFiles(path.join(root, "native", "electron"))
    .filter((file) => /(?:^|-)preload\.cjs$/.test(file))
    .map((file) => `native/electron/${file}`);
  const workerCandidates = ["entry.js", "index.js", "index.mjs", "worker.js", "worker.mjs", "main.js", "entrypoint.mjs"]
    .map((file) => `server/mcp-worker/${file}`).filter((file) => fs.existsSync(path.join(root, file)));
  return {
    electron: { entrypoints: ["native/electron/main.cjs", ...preload] },
    server: { entrypoints: ["server/index.js"] },
    worker: {
      entrypoints: workerCandidates.length ? workerCandidates : ["server/mcp-worker/index.js"],
      dynamic: { executables: ["bin/mcp/report.mjs"] },
    },
    renderer: { entrypoints: ["web/index.html"] },
    mcp: { entrypoints: ["bin/iris-mcp.mjs", "bin/iris-qa.mjs"] },
  };
}

export function buildExecutionGraph({ root, units = defaultExecutionUnits(root) }) {
  const sourceRoot = path.resolve(root);
  const result = {};
  const membership = {};
  const processEntryOwners = new Map();
  for (const [name, config] of Object.entries(units)) {
    for (const raw of config.entrypoints || []) {
      const entrypoint = relativePath(raw);
      const owners = processEntryOwners.get(entrypoint) || [];
      owners.push(name);
      processEntryOwners.set(entrypoint, owners);
    }
  }
  for (const [name, config] of Object.entries(units)) {
    const graph = unitGraph(sourceRoot, name, config, processEntryOwners);
    result[name] = { entrypoints: graph.entrypoints, files: graph.files, dynamic: graph.dynamic, missing: graph.missing, processBoundaries: graph.processBoundaries };
    for (const [file, record] of graph.paths) (membership[file] ||= []).push(record);
  }
  for (const records of Object.values(membership)) records.sort((a, b) => a.unit.localeCompare(b.unit));
  return { root: sourceRoot, units: result, membership };
}

function chainText(record) {
  const steps = [record.entrypoint];
  for (const edge of record.chain) {
    if (edge.from === null && edge.to === record.entrypoint) continue;
    steps.push(`${edge.kind} → ${edge.to}`);
  }
  return `${record.unit}: ${steps.join(" → ")}`;
}

export function classifyChanges({ root, changedFiles, units, graph, sourceBundle, installedBundle, previousMembership = {} }) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) throw new Error("분류할 변경 파일이 없습니다.");
  const executionGraph = graph || buildExecutionGraph({ root, units });
  const differences = sourceBundle && installedBundle ? bundleDifferences(sourceBundle, installedBundle) : [{ field: "bundle", expected: sourceBundle, actual: installedBundle }];
  let action = differences.length ? "full-install" : "worker-replace";
  let reconnectRequired = false;
  const reasons = changedFiles.map((raw) => {
    const file = relativePath(raw);
    const currentRecords = executionGraph.membership[file] || [];
    const records = currentRecords.length ? currentRecords : (previousMembership[file] || [])
      .map(unit => ({ unit, entrypoint: "설치 bundle 기록", chain: [] }));
    const unitNames = records.map((record) => record.unit).sort();
    if (unitNames.includes("mcp")) reconnectRequired = true;
    // MCP 진입 프로세스는 저장소의 bin/iris-*.mjs 를 직접 실행 · 설치 앱을 바꾸지 않고 /mcp reconnect 로 반영
    // 그래서 worker 와 mcp 만 쓰는 파일은 worker 교체로 분류
    const installUnits = new Set(unitNames.filter(unit => unit !== "mcp"));
    let why;
    if (records.length === 0) {
      action = "full-install";
      why = "어느 실행 주체 그래프에도 속하지 않아 전체 설치로 보수 분류";
    } else if ([...installUnits].some(unit => unit !== "worker")) {
      action = "full-install";
      why = records.length > 1 ? `공유 파일: ${records.map(chainText).join(" | ")}` : chainText(records[0]);
    } else {
      why = records.length > 1 ? `worker·MCP 진입 공유 파일: ${records.map(chainText).join(" | ")}` : chainText(records[0]);
    }
    return { file, units: unitNames, why };
  });
  if (differences.length) reasons.unshift({
    file: null,
    units: [],
    why: `설치 bundle 세대 불일치: ${differences.map((item) => item.field).join(", ")}`,
  });
  return { action, reconnectRequired, bundleDifferences: differences, reasons, graph: executionGraph };
}
