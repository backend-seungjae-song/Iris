// 소유 범위: DOCX 엔진 vendor 3종(ESM 번들·WASM·CSS)의 존재와 실제 HTTP 제공, bare import 부재.
// 제공 API: 이름 export runDocxBlock5Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-vendor-gate.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT } from "../core.mjs";
import { aiTabs, dock, fileRouting, httpHandler, tabClose, renderer } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5PackageVersions, docxB5WasmInventory,
  docxConcurrentWriteProbe, docxDispatchedHandler, docxMessageBranch, docxRenderBranch,
  docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe,
} from "./90-docx-block1.mjs";


// ── DOCX Block 5 RED: Vendor/runtime gate ────────────────────────────────
// round 5 재설계(design/design.md rev.2): SuperDoc/docx-preview를 폐기하고
// @docx-editor.dev/core(Apache 2.0)로 교체. core는 UMD가 없어 esbuild
// `--bundle --format=esm --platform=browser --external:module --minify`로 직접
// 번들링한 단일 ESM 파일(+harfbuzz.wasm+editor.css)을 web/vendor/에 커밋해 쓴다.
function docxHttpProbe(paths) {
  const script = String.raw`
    const port = process.env.IRIS_PORT || "4271";
    const paths = JSON.parse(process.env.IRIS_DOCX_HTTP_PATHS);
    const out = {};
    for (const p of paths) {
      try {
        const res = await fetch("http://127.0.0.1:" + port + p);
        const buf = Buffer.from(await res.arrayBuffer());
        out[p] = { status: res.status, contentType: res.headers.get("content-type") || "", length: buf.length };
      } catch (error) { out[p] = { error: String(error && error.message || error) }; }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 8000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_HTTP_PATHS: JSON.stringify(paths) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _error: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
export async function runDocxBlock5Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B5-")) return;
  console.log("\n[DOCX Block 5 RED] Vendor/runtime gate");
  const card = (id, name, fn) => { if (!selected || selected === `B5-${id}`) check(`[DOCX-B5-${id}] ${name}`, fn); };

  const vendorEsm = path.join(ROOT, "web/vendor/docx-editor-core.esm.js");
  const vendorWasm = path.join(ROOT, "web/vendor/harfbuzz.wasm");
  const vendorCss = path.join(ROOT, "web/vendor/docx-editor-core.css");
  const vendorNotice = path.join(ROOT, "web/vendor/docx-editor-core.NOTICE.md");
  const gitignore = read(".gitignore");
  const srv = httpHandler;

  card("T1", "엔진 vendor 3종(ESM 번들·WASM·CSS)이 web/vendor/에 존재한다", () => {
    docxAssert(existsSync(vendorEsm), "web/vendor/docx-editor-core.esm.js가 없음(esbuild 번들 산출물 미생성)");
    docxAssert(existsSync(vendorWasm), "web/vendor/harfbuzz.wasm이 없음(harfbuzzjs WASM 미배치)");
    docxAssert(existsSync(vendorCss), "web/vendor/docx-editor-core.css가 없음(core README가 명시하는 유일한 stylesheet)");
    if (existsSync(vendorEsm)) {
      const bundle = readFileSync(vendorEsm, "utf8");
      docxAssert(/createDocxEditor/.test(bundle), "번들에 createDocxEditor export가 없음");
      // 텍스트 정규식으로 bare import 를 찾으면 미니파이된 번들 안의 무관한 문자열
      // ("sql-delete-from", `"from" in e`)을 import 로 오탐한다. esbuild 가 산출하는 metafile 의
      // external import 목록이 더 정밀하므로 그쪽을 우선 신뢰한다.
      const metaPath = path.join(ROOT, "web/vendor/docx-editor-core.meta.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        const externals = Object.values(meta.outputs || {})
          .flatMap((o) => (o.imports || []).filter((i) => i.external).map((i) => i.path));
        const unexpected = [...new Set(externals)].filter((p) => p !== "module");
        docxAssert(unexpected.length === 0, `번들에 예상 밖 external import가 있음(node_modules 해석 불가): ${unexpected.join(", ")}`);
      } else {
        docxAssert(!/from\s*['"](?!\.)[^'"]+['"]/.test(bundle.replace(/from\s*['"]module['"]/g, "")),
          "web/vendor/docx-editor-core.meta.json이 없어 정밀 검사 불가 — 텍스트 검사에서도 잔존 bare import 의심 패턴 발견");
      }
    }
    return true;
  });

  card("T2", "엔진 배포 자산(ESM·CSS·NOTICE·WASM 전부)이 실제로 git에 추적된다", () => {
    // git check-ignore 의 성공·실패 분기를 잘못 매핑하면 어떤 상태에서도 통과할 수 없는 영구
    // 실패가 된다(exit 0/1 둘 다 catch 안팎에서 true 로 수렴). git ls-files --error-unmatch 는
    // tracked 면 exit 0, untracked 면 throw 라 분기가 명확하다.
    const required = docxB5WasmInventory(vendorEsm).map((w) => `web/vendor/${w}`)
      .concat(["web/vendor/docx-editor-core.esm.js", "web/vendor/docx-editor-core.css", "web/vendor/docx-editor-core.NOTICE.md", "web/vendor/docx-editor-core.meta.json"]);
    for (const f of required) {
      let tracked = false;
      try { execFileSync("git", ["ls-files", "--error-unmatch", f], { cwd: ROOT, stdio: "pipe" }); tracked = true; } catch { tracked = false; }
      docxAssert(tracked, `${f}가 git에 추적되지 않음 — web/vendor/ 부모 디렉터리 자체가 .gitignore 대상이라 단순 !패턴 negation으로는 안 살아남는다(gitignore 규칙), .gitignore 재구성 또는 git add -f 필요`);
    }
    return true;
  });

  card("T3", "서버 MIME 테이블이 .wasm을 application/wasm으로 서빙한다", () => {
    docxAssert(/["']\.wasm["']\s*:\s*["']application\/wasm["']/.test(srv),
      "server/http-handler.js의 MIME 테이블에 .wasm→application/wasm 매핑이 없음(현재 text/plain으로 새어나가 streaming compile 실패 가능)");
    return true;
  });

  card("T4", "module↔classic 브리지가 단일 Promise로 준비 상태를 노출한다", () => {
    // classic script 는 즉시 실행, module script 는 파싱 후 실행이라 순서 경합이 있다.
    // 할당만 하는 브리지로는 경합을 막지 못하고, 소비자가 await 할 단일 Promise 가 필요하다.
    docxAssert(/window\.__docxEditorCoreReady\s*=[\s\S]{0,200}import\s*\(\s*["']\/vendor\/docx-editor-core\.esm\.js["']\s*\)/.test(renderer),
      "window.__docxEditorCoreReady = import(...)... 형태의 단일 Promise 브리지가 없음(단순 할당은 module/classic 로드 순서 경합을 못 막음)");
    docxAssert(/__docxEditorCoreReady[\s\S]{0,300}\.then\s*\(/.test(renderer), "브리지 Promise가 .then으로 window.__docxEditorCore를 채우지 않음");
    return true;
  });

  card("T5", "NOTICE가 metafile 기반 의존성 인벤토리와 실제로 대응한다", () => {
    // "prosemirror"/"harfbuzz" 문자열 존재만 보거나 7개 고정 키워드만 찾으면 실질 라이선스
    // 게이트가 아니다. metafile 을 실제로 읽지 않으면 재빌드로 의존성이 바뀌어도 오래된 NOTICE
    // 를 잡지 못한다. metafile 의 inputs 에서 도출한 패키지 인벤토리 전체와 대조한다.
    docxAssert(existsSync(vendorNotice), "web/vendor/docx-editor-core.NOTICE.md가 없음(Apache 2.0/MIT 저작권고지 의무)");
    if (existsSync(vendorNotice)) {
      const notice = readFileSync(vendorNotice, "utf8");
      const metaPath = path.join(ROOT, "web/vendor/docx-editor-core.meta.json");
      if (existsSync(metaPath)) {
        const packages = docxB5PackageInventory(metaPath);
        docxAssert(packages.length > 0, "metafile에서 패키지 인벤토리를 도출하지 못함(inputs 없음?)");
        const lowerNotice = notice.toLowerCase();
        const missing = packages.filter((name) => !lowerNotice.includes(name.toLowerCase()));
        docxAssert(missing.length === 0, `NOTICE에 metafile 기준 다음 패키지 고지가 없음: ${missing.join(", ")}`);
        // 이름만 보면 버전이 바뀌어도 통과한다. 표의 버전 칸도 metafile 의 실제
        // 경로(…/<name>@<version>/…)와 맞아야 한다.
        const stale = docxB5PackageVersions(metaPath).filter(([name, version]) => {
          const row = new RegExp(`^\\|\\s*\`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`\\s*\\|\\s*([^|]+?)\\s*\\|`, "m").exec(notice);
          return !row || row[1] !== version;
        });
        docxAssert(stale.length === 0, `NOTICE 표의 버전이 실제 번들과 다름: ${stale.map(([n, v]) => `${n}@${v}`).join(", ")}`);
        docxAssert(/apache/i.test(notice) && /\bmit\b/i.test(notice), "NOTICE에 Apache/MIT 라이선스 종류 표기가 없음");
      } else {
        const required = ["@docx-editor.dev/core", "Apache", "prosemirror", "fflate", "fast-xml-parser", "harfbuzz", "MIT"];
        for (const name of required) {
          docxAssert(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(notice), `NOTICE에 "${name}" 고지가 없음(metafile 없어 텍스트 검사로 fallback)`);
        }
      }
    }
    return true;
  });

  card("T8", "vendor 빌드가 정확한 버전 고정 하에 재현 가능하다", () => {
    // esbuild/코어 버전이 범위 지정(^~)이면 재빌드 시 다른 산출물이 나올 수 있다.
    const pkg = JSON.parse(read("package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    docxAssert(deps["esbuild"] && !/^[\^~]/.test(deps["esbuild"]), "package.json의 esbuild가 정확히 고정되지 않음(^ 또는 ~ 범위 지정 발견)");
    docxAssert(existsSync(path.join(ROOT, "pnpm-lock.yaml")), "pnpm-lock.yaml이 없음(frozen install 불가)");
    docxAssert(pkg.scripts && Object.values(pkg.scripts).some((s) => /esbuild[\s\S]*docx-editor-core/.test(s)),
      "package.json에 vendor 재빌드 script가 없음(정확한 커맨드가 재현 가능하게 고정돼야 함)");
    return true;
  });

  card("T10", "번들이 실제로 참조하는 WASM 전부가 vendor에 있다(하드코딩 아님)", () => {
    // harfbuzz-subset.wasm 은 현재 조합에서 불필요하지만 의존성이 바뀌면 필요한 WASM 집합도
    // 바뀐다. 파일명을 고정하지 말고 번들 내용에서 도출해야 한다.
    if (!existsSync(vendorEsm)) { docxAssert(false, "web/vendor/docx-editor-core.esm.js가 없어 WASM 인벤토리를 도출할 수 없음"); return true; }
    const inventory = docxB5WasmInventory(vendorEsm);
    docxAssert(inventory.length > 0, "번들에서 참조하는 WASM 파일을 하나도 찾지 못함(파싱 실패 또는 WASM 미사용?)");
    for (const w of inventory) {
      docxAssert(existsSync(path.join(ROOT, "web/vendor", w)), `번들이 참조하는 ${w}가 web/vendor/에 없음`);
    }
    return true;
  });

  if (LIVE) {
    card("T6", "live: 개발 서버가 엔진 vendor 파일을 올바른 Content-Type으로 서빙한다", () => {
      const got = docxHttpProbe(["/vendor/docx-editor-core.esm.js", "/vendor/harfbuzz.wasm", "/vendor/docx-editor-core.css"]);
      docxAssert(got["/vendor/docx-editor-core.esm.js"]?.status === 200, "ESM 번들이 200이 아님: " + JSON.stringify(got["/vendor/docx-editor-core.esm.js"]));
      docxAssert(got["/vendor/harfbuzz.wasm"]?.status === 200 && got["/vendor/harfbuzz.wasm"]?.contentType === "application/wasm",
        "harfbuzz.wasm이 200+application/wasm이 아님: " + JSON.stringify(got["/vendor/harfbuzz.wasm"]));
      docxAssert(got["/vendor/docx-editor-core.css"]?.status === 200, "CSS가 200이 아님: " + JSON.stringify(got["/vendor/docx-editor-core.css"]));
      return true;
    });
  }

  // T7(실제 마운트+콘솔/네트워크 오류 없음), T9(module↔classic race 를 지연 상황에서 검증),
  // T12(pnpm install:app 후 4271 설치 앱에서 서버 재시작까지 마치고 재검증. 4291 개발 서버
  // 통과는 설치 앱 통과의 증거가 아니다)는 시각·런타임·설치 확인이라 code_test 로 할 수 없다.
  // verify_method: browser_test 로 Feature Validation 단계에 이연한다.
}


export default async function run() {
  await runDocxBlock5Checks();
}
