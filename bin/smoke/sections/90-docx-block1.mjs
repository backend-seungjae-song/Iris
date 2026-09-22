// 소유 범위: DOCX Block 1의 라우팅·전송·안전장치 검사와 뒤 블록이 공유하는 probe/helper.
// 제공 API: runDocxBlock1Checks 이름 export, DOCX-only로 제한된 기본 run, Block 5+용 helper.
// 의존 대상: core의 공유 계수·옵션·파일 읽기, sources의 renderer 문자열, Node와 docx/jszip 패키지.
// 유지 조건: 카드 필터·검사 이름·순서·문구, fixture 바이트, 임시 파일 정리, 일반 smoke 무출력.
// 영향 범위: 러너와 91-docx-block5plus가 양방향으로 이 export 계약에 기대므로 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/90-docx-block1.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";

import {
  cannotMeasure, check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT,
} from "../core.mjs";
import { renderer } from "../sources.mjs";

// ── DOCX Block 1 RED: 라우팅·전송·안전장치 ───────────────────────────────
// 실제 편집기 mount(엔진 로드·렌더)는 Block 6 소유다. 여기서는 원본 바이트 전달, 사용자 대면 오류,
// 두 진입점의 수렴, 읽기 전용, 재열람, stale 응답 격리까지만 고정한다.
export function docxSourceFunction(src, name) {
  const needle = "function " + name + "(";
  // 같은 이름의 정의가 소스에 둘 이상이면 첫 번째를 고르는 데 근거가 없다. 앱 셸과 기능이
  // 같은 이름을 각각 쓰는 경우가 있어(fileviewClickHandler: 앱 셸은 글자 탭용, 뷰어는
  // 문서·표용), 앱 셸 쪽을 검사하면서 뷰어 계약을 주장하게 된다. 잘못된 결과 대신 멈추고,
  // 호출하는 쪽이 어느 파일의 정의인지 지정하게 한다.
  let count = 0;
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) count++;
  if (count > 1) cannotMeasure(`${name} 정의가 말뭉치에 ${count} 개다 — 어느 파일 것인지 대라`);
  const from = src.indexOf(needle);
  if (from < 0) return "";
  // "\nfunction "만 찾으면 다음 함수가 "export function "/"export async function "/
  // "async function "으로 선언된 경우 경계를 찾지 못하고, 그 함수와 그 뒤 전부를 함께
  // 포함하게 된다. 그래서 네 가지 선언 형태를 모두 경계 후보로 찾고 그중 가장 앞의
  // 위치를 끝으로 삼는다.
  const boundaries = ["\nfunction ", "\nasync function ", "\nexport function ", "\nexport async function "]
    .map((needle) => src.indexOf(needle, from + 20))
    .filter((idx) => idx > from);
  const to = boundaries.length ? Math.min(...boundaries) : -1;
  return src.slice(from, to > from ? to : from + 12000);
}
// 주석을 제거한 소스. "이 이름이 여기 없어야 한다"를 검사할 때 주석에 남은 옛 이름이
// 그대로 걸리기 때문이다. 줄 전체가 주석인 줄만 제거한다. 문자열·정규식 안의 // 를
// 건드리지 않으려면 이 기준이 안전하다.
export function docxCodeOnly(src) {
  return src.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
}
export function docxRenderBranch(src, render) {
  // docx 렌더는 renderFileViewBody 안의 t.docxMode 분기가 아니라, 스페이스 브라우저 탭처럼
  // 보이도록 분리한 renderDocxPanelBody 함수와 docxview 패널이 담당한다
  // (renderFileViewBody는 docx를 처리하지 않는다). render 매개변수는 기존 호출부와의 호환을
  // 위해 남겨 두고 사용하지 않으며, src에서 renderDocxPanelBody를 직접 찾는다.
  const branch = docxSourceFunction(src, "renderDocxPanelBody");
  if (!branch) return "";
  const call = branch.match(/\b([A-Za-z_$][\w$]*docx[\w$]*)\s*\(/i);
  return branch + (call ? "\n" + docxSourceFunction(src, call[1]) : "");
}
export function docxMessageBranch(src, type) {
  const needles = [`} else if (m.type === "${type}")`, `else if (m.type === "${type}")`];
  const from = Math.max(...needles.map((needle) => src.indexOf(needle)));
  if (from < 0) return "";
  const to = src.indexOf('\n    } else if (m.type === "', from + 20);
  return src.slice(from, to > from ? to : from + 9000);
}
// 기능이 자기 ws 등록표에 이름을 등록하고 앱 셸이 그 표를 순회한다. 표를 읽어 그 이름의
// 함수를 반환한다. 함수 이름을 검사에 직접 적으면 이름이 바뀌는 날 검사가 아무것도 찾지
// 못하고, 그 뒤 assert 는 모두 빈 문자열을 검사하게 되어 실제로 검사하는 것이 없어진다
// (결과는 통과가 아니라 잘못된 실패다).
// 앱 셸은 훅 이름을 호출하고 기능이 그 이름을 채운다. 이름을 채우는 provide 의 몸통에서
// 그 기능의 함수를 찾아 반환한다. 함수 이름을 검사에 직접 적으면 이름이 바뀌는 날
// 아무것도 찾지 못한다.
// 이름을 채우는 provide 호출 자체를 잘라 낸다. 채우는 쪽이 별도 함수 없이 그 자리에서
// 처리하는 경우가 있어(viewer.leaveTab), 그때는 이 몸통이 검사 대상이 된다.
export function docxProvideBody(src, hook) {
  const head = `provide("${hook}"`;
  const at = src.indexOf(head);
  if (at < 0) return "";
  let depth = 0, end = at;
  for (let i = src.indexOf("(", at); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(at, end + 1);
}
export function docxHookedFunction(src, hook, prefer) {
  const body = docxProvideBody(src, hook);
  if (!body) return "";
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (name === "provide" || (prefer && !name.toLowerCase().includes(prefer))) continue;
    const fn = docxSourceFunction(src, name);
    if (fn) return fn;
  }
  return "";
}
export function docxWsHandler(src, type, prefer) {
  // 표에 등록하는 형태가 한 가지가 아니라 `"docx": (m, e) => handleDocxMessage(...)` 도 있고
  // `"file": dispatchWs(handleFileMessage)` 도 있다. 값 쪽에 나오는 이름을 모두 모은 뒤,
  // dispatchWs 같은 래퍼가 먼저 잡히지 않도록 그 종류를 뜻하는 이름부터 확인한다.
  const at = src.search(new RegExp(`["']${type}["']\\s*:`));
  if (at >= 0) {
    const value = src.slice(at, at + 260);
    const names = [...new Set([...value.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]))];
    const want = (prefer || type).toLowerCase();
    const ordered = [...names.filter((n) => n.toLowerCase().includes(want)), ...names];
    for (const name of ordered) {
      const body = docxSourceFunction(src, name);
      if (body) return body;
    }
  }
  // 아직 옛 switch 에 남아 있는 종류는 그대로 찾는다.
  return docxMessageBranch(src, type);
}
export function docxDispatchedHandler(entrySrc, ownerSrc, type) {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const call = entrySrc.match(new RegExp(`msg\\.type\\s*===\\s*["']${escaped}["']\\s*\\)\\s*([A-Za-z_$][\\w$]*)\\s*\\(`));
  if (!call) return "";
  return docxSourceFunction(ownerSrc, call[1]);
}
function docxConstRegex(src, name) {
  // 모듈로 분리되면서 선언이 `export const` 형태가 되므로 export 접두사를 떼고 찾는다.
  const line = src.split("\n").find((value) => {
    const head = value.trimStart().replace(/^export\s+/, "");
    return head.startsWith(`const ${name} = `);
  });
  if (!line) return null;
  const equalAt = line.indexOf("="), semicolonAt = line.lastIndexOf(";");
  if (equalAt < 0 || semicolonAt <= equalAt) return null;
  const literal = line.slice(equalAt + 1, semicolonAt).trim();
  try { return Function("return (" + literal + ")")(); } catch { return null; }
}
export function docxAssert(value, message) { if (!value) throw new Error(message); }
// Block 11: @docx-editor.dev/core의 서버 자동화 호스트(createServerAutomationHost, DOM 불필요,
// automation.d.ts의 "How a headless host opens a document")로 실제 편집을 실행하고, 그 결과 바이트를
// server/docx.js의 writeDocxRaw/readDocxRaw에 통과시킨다. 전체 파이프라인(엔진 편집→원자적
// 쓰기→재읽기→재파싱)에서 "건드리지 않은 문단"이 텍스트 수준에서 보존되는지 확인한다.
// 유효한 zip이 열리는지가 아니라 실제 내용을 자동화 API로 다시 읽어 비교하므로
// round-trip 무결성을 직접 확인한다.
export function docxRoundTripProbe() {
  const docxModuleUrl = new URL("../../../server/docx.js", import.meta.url).href;
  const script = String.raw`
    const out = {};
    try {
      const { createServerAutomationHost } = await import("@docx-editor.dev/core/automation");
      const { Document, Packer, Paragraph, TextRun, AlignmentType } = await import("docx");
      const serverDocx = await import(process.env.IRIS_DOCX_MODULE_URL);
      const fs = await import("node:fs/promises");
      const crypto = await import("node:crypto");
      const os = await import("node:os");
      const path = await import("node:path");

      const paraTexts = [
        "UNTOUCHED PARAGRAPH ZERO — plain text before the edit target.",
        "EDIT TARGET paragraph — automation will insert text at its start.",
        "UNTOUCHED PARAGRAPH TWO — plain, comes right after the edited one.",
        "UNTOUCHED PARAGRAPH THREE — bold/italic formatted run below.",
        "UNTOUCHED PARAGRAPH FOUR — represents the back half of a longer document.",
      ];
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ children: [new TextRun(paraTexts[0])] }),
            new Paragraph({ children: [new TextRun(paraTexts[1])] }),
            new Paragraph({ children: [new TextRun(paraTexts[2])] }),
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: paraTexts[3], bold: true, italics: true })] }),
            new Paragraph({ children: [new TextRun(paraTexts[4])] }),
          ],
        }],
      });
      const originalBytes = Buffer.from(await Packer.toBuffer(doc));

      const openHost = (bytes) => {
        const r = createServerAutomationHost(new Uint8Array(bytes));
        if (!r.ok) throw new Error("automation host open 실패: " + r.reason + (r.detail ? " — " + r.detail : ""));
        return r.host;
      };
      const readAllParagraphTexts = (host) => {
        const rev = host.revision();
        const docHandle = host.execute({ expectedRevision: rev, operations: [{ op: "getDocument" }] }).results[0].value.handle;
        const bodyHandle = host.execute({ expectedRevision: host.revision(), operations: [{ op: "getBody", document: docHandle }] }).results[0].value.handle;
        const paras = host.execute({ expectedRevision: host.revision(), operations: [{ op: "getParagraphs", body: bodyHandle }] }).results[0].value;
        return paras.handles.map((ph) =>
          host.execute({ expectedRevision: host.revision(), operations: [{ op: "getText", target: ph }] }).results[0].value.text);
      };

      const host1 = openHost(originalBytes);
      const textsBefore = readAllParagraphTexts(host1);
      const rev1 = host1.revision();
      const docHandle1 = host1.execute({ expectedRevision: rev1, operations: [{ op: "getDocument" }] }).results[0].value.handle;
      const bodyHandle1 = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getBody", document: docHandle1 }] }).results[0].value.handle;
      const paras1 = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getParagraphs", body: bodyHandle1 }] }).results[0].value.handles;
      const editResp = host1.execute({
        expectedRevision: host1.revision(),
        operations: [{ op: "insertText", at: { paragraph: paras1[1], at: "start" }, text: "EDITED-> " }],
      });
      out.editOk = editResp.ok && editResp.results.every((r) => r.status === "ok");
      const saveResp = host1.save();
      if (!saveResp.ok) throw new Error("automation save 실패: " + JSON.stringify(saveResp.error));
      const editedBytes = Buffer.from(saveResp.bytes);
      host1.dispose();

      // 실제 server/docx.js 파이프라인: 디스크에 원본을 두고(baseline), writeDocxRaw로 편집된
      // 바이트를 원자적으로 덮어쓴 뒤, readDocxRaw로 다시 읽어 revision·base64가 정합하는지 확인.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-docx-b11-"));
      const tmpPath = path.join(tmpDir, "roundtrip.docx");
      await fs.writeFile(tmpPath, originalBytes);
      const baselineRevision = crypto.createHash("sha256").update(originalBytes).digest("hex");
      const writeRevision = await serverDocx.writeDocxRaw(tmpPath, editedBytes, { baselineRevision });
      const expectedRevision = crypto.createHash("sha256").update(editedBytes).digest("hex");
      out.writeRevisionMatches = writeRevision === expectedRevision;

      const readResult = await serverDocx.readDocxRaw(tmpPath);
      const readBytes = Buffer.from(readResult.data, "base64");
      out.readRevisionMatches = readResult.revision === expectedRevision;
      out.readBytesMatchWritten = Buffer.compare(readBytes, editedBytes) === 0;

      await fs.rm(tmpDir, { recursive: true, force: true });

      // 서버를 거쳐 왕복한 바이트를 자동화 호스트로 다시 열어 문단 내용을 확인한다. 유효한 zip인지가
      // 아니라 실제 파싱 가능한 내용으로 보존을 확인하기 위해서다.
      const host2 = openHost(readBytes);
      const textsAfter = readAllParagraphTexts(host2);
      host2.dispose();

      // 파서가 저장 전부터 문단을 누락·재정렬했다면 이후 "before === after" 비교는 손상된 값끼리
      // 비교해 통과한다. 그래서 최초 로드 결과를 fixture 원문과 직접 대조해 그 경우를
      // 검출한다.
      out.textsBeforeMatchesFixture = textsBefore.length === paraTexts.length
        && paraTexts.every((t, i) => textsBefore[i] === t);
      out.paraCountMatches = textsBefore.length === textsAfter.length;
      out.untouchedPreserved = [0, 2, 3, 4].every((i) => textsBefore[i] === textsAfter[i]);
      out.editedChanged = textsAfter[1] !== textsBefore[1] && textsAfter[1].startsWith("EDITED-> ") && textsAfter[1].includes(textsBefore[1]);
      out.originalVsEditedDiffer = Buffer.compare(originalBytes, editedBytes) !== 0;
    } catch (error) {
      out._error = String((error && error.stack) || error);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 20000, maxBuffer: 40 * 1024 * 1024, cwd: ROOT,
      env: { ...process.env, IRIS_DOCX_MODULE_URL: docxModuleUrl },
    });
    return JSON.parse(raw);
  } catch (e) {
    return { _error: String((e && e.stdout) || (e && e.message) || e) };
  }
}
// docxRoundTripProbe(T1/T2)는 문단 텍스트만 확인한다. core 직렬화기는 파싱된 XML part 전체를
// 다시 쓰고 원본 binary part만 복사하므로, 서식(bold/italic/정렬)·표·
// 목록(numbering.xml)·이미지(media)·hyperlink(rels)가 각각 독립적인 손상 지점이다. 이 probe는
// 그 5개 지점을 자동화 API(getFont/getParagraphFormat)와 직접 OOXML part 대조(JSZip, media
// sha256·numbering.xml·rels 문자열)로 각각 검증한다.
export function docxRichRoundTripProbe() {
  const script = String.raw`
    const out = {};
    try {
      const { createServerAutomationHost } = await import("@docx-editor.dev/core/automation");
      const {
        Document, Packer, Paragraph, TextRun, AlignmentType,
        Table, TableRow, TableCell, WidthType, ImageRun, ExternalHyperlink,
        Header, Footer, PageNumber,
      } = await import("docx");
      const JSZip = (await import("jszip")).default;
      const crypto = await import("node:crypto");

      // 1x1 red PNG. 실제 media part(word/media/*.png)를 만들기 위한 최소 이미지다.
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      );
      const hyperlinkTarget = "https://example.invalid/untouched-link";

      const doc = new Document({
        sections: [{
          headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun("UNTOUCHED HEADER TEXT")] })] }) },
          footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })] })] }) },
          children: [
            new Paragraph({ children: [new TextRun("SENTINEL EDIT TARGET — automation edits only this paragraph.")] }),
            new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "UNTOUCHED bold italic centered paragraph.", bold: true, italics: true })] }),
            new Paragraph({ children: [new TextRun("UNTOUCHED bullet item one")], bullet: { level: 0 } }),
            new Paragraph({ children: [new TextRun("UNTOUCHED bullet item two")], bullet: { level: 0 } }),
            new Table({
              width: { size: 4000, type: WidthType.DXA },
              columnWidths: [2000, 2000],
              rows: [new TableRow({ children: [
                new TableCell({ width: { size: 2000, type: WidthType.DXA }, children: [new Paragraph("R1C1")] }),
                new TableCell({ width: { size: 2000, type: WidthType.DXA }, children: [new Paragraph("R1C2")] }),
              ] })],
            }),
            new Paragraph({ children: [new ImageRun({ type: "png", data: pngBytes, transformation: { width: 20, height: 20 } })] }),
            new Paragraph({ children: [new ExternalHyperlink({ link: hyperlinkTarget, children: [new TextRun("UNTOUCHED link text")] })] }),
          ],
        }],
      });
      const originalBytes = Buffer.from(await Packer.toBuffer(doc));

      const openHost = (bytes) => {
        const r = createServerAutomationHost(new Uint8Array(bytes));
        if (!r.ok) throw new Error("automation host open 실패: " + r.reason + (r.detail ? " — " + r.detail : ""));
        return r.host;
      };

      const host1 = openHost(originalBytes);
      const docHandle1 = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getDocument" }] }).results[0].value.handle;
      const bodyHandle1 = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getBody", document: docHandle1 }] }).results[0].value.handle;
      const paras1 = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getParagraphs", body: bodyHandle1 }] }).results[0].value.handles;
      // paras1[1]은 bold/italic/centered 문단이다. fixture 순서가 고정이고 reading order는
      // protocol d.ts가 보장한다.
      const fontBefore = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getFont", span: { paragraph: paras1[1] } }] }).results[0].value.font;
      const formatBefore = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getParagraphFormat", paragraph: { paragraph: paras1[1] } }] }).results[0].value.format;
      const tableCellTextsBefore = [paras1[4], paras1[5]].map((p) =>
        host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getText", target: p }] }).results[0].value.text);
      const hyperlinkTextBefore = host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "getText", target: paras1[7] }] }).results[0].value.text;

      const readFurnitureText = (host, docHandle, kind) => {
        const sectionH = host.execute({ expectedRevision: host.revision(), operations: [{ op: "getSections", document: docHandle }] }).results[0].value.handles[0];
        const bodyH = host.execute({ expectedRevision: host.revision(), operations: [{ op: "getFurniture", section: sectionH, kind, variant: "default" }] }).results[0].value.handle;
        const p = host.execute({ expectedRevision: host.revision(), operations: [{ op: "getParagraphs", body: bodyH }] }).results[0].value.handles[0];
        return host.execute({ expectedRevision: host.revision(), operations: [{ op: "getText", target: p }] }).results[0].value.text;
      };
      const headerTextBefore = readFurnitureText(host1, docHandle1, "header");
      const footerTextBefore = readFurnitureText(host1, docHandle1, "footer");

      // sentinel(문단 0)만 편집하고 나머지는 건드리지 않는다.
      host1.execute({ expectedRevision: host1.revision(), operations: [{ op: "insertText", at: { paragraph: paras1[0], at: "start" }, text: "EDITED-> " }] });
      const saveResp = host1.save();
      if (!saveResp.ok) throw new Error("automation save 실패: " + JSON.stringify(saveResp.error));
      const editedBytes = Buffer.from(saveResp.bytes);
      host1.dispose();

      async function extractParts(bytes) {
        const zip = await JSZip.loadAsync(bytes);
        const mediaNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir && n.startsWith("word/media/")).sort();
        const mediaHashes = {};
        for (const name of mediaNames) {
          const buf = await zip.file(name).async("nodebuffer");
          mediaHashes[name] = crypto.createHash("sha256").update(buf).digest("hex");
        }
        const numbering = zip.file("word/numbering.xml") ? await zip.file("word/numbering.xml").async("string") : null;
        const rels = zip.file("word/_rels/document.xml.rels") ? await zip.file("word/_rels/document.xml.rels").async("string") : null;
        return { mediaNames, mediaHashes, numbering, rels };
      }
      const partsBefore = await extractParts(originalBytes);
      const partsAfter = await extractParts(editedBytes);

      // 재직렬화는 XML 선언 제거와 xmlns·속성 순서 재배열까지 하지만
      // (abstractNumId·numId·lvl·numFmt·lvlText·indent 등) 의미 내용은 유지한다. 문서
      // 전체 sha256이 재직렬화로 달라지는 것과 같은 표현 차이다. 그래서 numbering.xml은
      // 바이트 동일이 아니라 태그별 속성을 정렬해 순서와 무관하게 비교한다(전체 문서와 같은
      // "의미 수준" 보존 기준이며, design.md가 명시적으로 허용한다).
      const canonicalizeXml = (xml) => (xml || "")
        .replace(/^<\?xml[^>]*\?>/, "")
        .replace(/<[^>]+>/g, (tag) => {
          const isClose = tag.startsWith("</");
          const selfClose = tag.endsWith("/>");
          const inner = tag.replace(/^<\/?/, "").replace(/\/?>$/, "");
          const parts = inner.match(/[^\s]+|"[^"]*"/g) || [];
          const name = parts[0] || "";
          const attrs = parts.slice(1).join(" ").match(/[\w:.-]+="[^"]*"/g) || [];
          attrs.sort();
          return "<" + (isClose ? "/" : "") + name + (attrs.length ? " " + attrs.join(" ") : "") + (selfClose ? "/" : "") + ">";
        });
      out.mediaNamesMatch = JSON.stringify(partsBefore.mediaNames) === JSON.stringify(partsAfter.mediaNames);
      out.mediaHashesMatch = partsBefore.mediaNames.length > 0
        && partsBefore.mediaNames.every((n) => partsBefore.mediaHashes[n] === partsAfter.mediaHashes[n]);
      out.numberingPreserved = !!partsBefore.numbering
        && canonicalizeXml(partsBefore.numbering) === canonicalizeXml(partsAfter.numbering);
      out.hyperlinkRelPreservedBefore = (partsBefore.rels || "").includes(hyperlinkTarget);
      out.hyperlinkRelPreservedAfter = (partsAfter.rels || "").includes(hyperlinkTarget);

      const host2 = openHost(editedBytes);
      const docHandle2 = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getDocument" }] }).results[0].value.handle;
      const bodyHandle2 = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getBody", document: docHandle2 }] }).results[0].value.handle;
      const paras2 = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getParagraphs", body: bodyHandle2 }] }).results[0].value.handles;
      out.paraCountMatches = paras1.length === paras2.length;

      const sentinelTextAfter = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getText", target: paras2[0] }] }).results[0].value.text;
      out.sentinelEditApplied = sentinelTextAfter.startsWith("EDITED-> ") && sentinelTextAfter.includes("SENTINEL EDIT TARGET");

      const fontAfter = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getFont", span: { paragraph: paras2[1] } }] }).results[0].value.font;
      const formatAfter = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getParagraphFormat", paragraph: { paragraph: paras2[1] } }] }).results[0].value.format;
      out.boldPreserved = fontBefore.bold === true && fontAfter.bold === true;
      out.italicPreserved = fontBefore.italic === true && fontAfter.italic === true;
      out.alignmentPreserved = formatBefore.alignment === "Centered" && formatAfter.alignment === formatBefore.alignment;

      const tableCellTextsAfter = [paras2[4], paras2[5]].map((p) =>
        host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getText", target: p }] }).results[0].value.text);
      out.tableCellsPreserved = JSON.stringify(tableCellTextsBefore) === JSON.stringify(tableCellTextsAfter)
        && tableCellTextsBefore[0] === "R1C1" && tableCellTextsBefore[1] === "R1C2";

      const bulletTextsAfter = [paras2[2], paras2[3]].map((p) =>
        host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getText", target: p }] }).results[0].value.text);
      out.bulletTextsPreserved = bulletTextsAfter[0] === "UNTOUCHED bullet item one" && bulletTextsAfter[1] === "UNTOUCHED bullet item two";

      const hyperlinkTextAfter = host2.execute({ expectedRevision: host2.revision(), operations: [{ op: "getText", target: paras2[7] }] }).results[0].value.text;
      out.hyperlinkTextPreserved = hyperlinkTextAfter === hyperlinkTextBefore && hyperlinkTextBefore === "UNTOUCHED link text";

      const headerTextAfter = readFurnitureText(host2, docHandle2, "header");
      const footerTextAfter = readFurnitureText(host2, docHandle2, "footer");
      out.headerPreserved = headerTextAfter === headerTextBefore && headerTextBefore === "UNTOUCHED HEADER TEXT";
      // PageNumber.CURRENT는 정적 텍스트가 아니라 동적 필드라 렌더 시 치환 문자(U+FFFC)로
      // 직렬화된다. 그래서 "Page " 리터럴 접두사와 필드 존재만 확인한다.
      out.footerPreserved = footerTextAfter === footerTextBefore && footerTextBefore.startsWith("Page ") && footerTextBefore.length > "Page ".length;

      host2.dispose();
    } catch (error) {
      out._error = String((error && error.stack) || error);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 20000, maxBuffer: 40 * 1024 * 1024, cwd: ROOT,
    });
    return JSON.parse(raw);
  } catch (e) {
    return { _error: String((e && e.stdout) || (e && e.message) || e) };
  }
}
export function docxB5WasmInventory(vendorEsmPath) {
  if (!existsSync(vendorEsmPath)) return [];
  const bundle = readFileSync(vendorEsmPath, "utf8");
  const found = new Set();
  // 경로가 섞인 참조("wasm/foo.wasm")도 vendor 조회는 flat 디렉터리 기준이라 basename만 취한다.
  const re = /["']([^"']*\.wasm)["']/g;
  let m;
  while ((m = re.exec(bundle))) {
    const base = m[1].split("/").pop();
    if (base) found.add(base);
  }
  return [...found].sort();
}
export function docxB5PackageInventory(metaPath) {
  if (!existsSync(metaPath)) return [];
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const names = new Set();
  for (const key of Object.keys(meta.inputs || {})) {
    const idx = key.lastIndexOf("node_modules/");
    if (idx === -1) continue;
    const rest = key.slice(idx + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    names.add(name);
  }
  return [...names].sort();
}
// 이름 → 버전. pnpm 경로는 `node_modules/.pnpm/<name>@<version>/...` 이고 scope 의 `/` 는 `+` 다.
// 해당 위치에 버전이 없는 경로(hoist 된 심링크 등)는 집계하지 않는다.
export function docxB5PackageVersions(metaPath) {
  if (!existsSync(metaPath)) return [];
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const versions = new Map();
  for (const key of Object.keys(meta.inputs || {})) {
    const hit = /node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@+]+)@(\d[^/_]*)/.exec(key);
    if (hit) versions.set(hit[1].replace("+", "/"), hit[2]);
  }
  return [...versions].sort(([a], [b]) => a.localeCompare(b));
}
function docxDigest(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
async function docxSizedFixture(baseBytes, size) {
  const zip = await JSZip.loadAsync(baseBytes);
  const paddingName = "word/media/smoke-padding.bin";
  zip.file(paddingName, Buffer.alloc(0), { compression: "STORE" });
  const empty = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  docxAssert(empty.length <= size, `DOCX fixture 기본 크기가 목표보다 큼: ${empty.length} > ${size}`);
  zip.file(paddingName, Buffer.alloc(size - empty.length), { compression: "STORE" });
  const result = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  docxAssert(result.length === size, `DOCX fixture 크기가 정확하지 않음: ${result.length} !== ${size}`);
  return result;
}
function docxModuleProbe(cases) {
  const moduleUrl = new URL("../../../server/docx.js", import.meta.url).href;
  const script = String.raw`
    const out = {};
    try {
      const mod = await import(process.env.IRIS_DOCX_MODULE_URL);
      const named = mod.readDocxRaw || mod.readDocx || mod.loadDocxRaw;
      const found = Object.entries(mod).find(([name, value]) => typeof value === "function"
        && /(?:read|load).*docx|docx.*(?:read|load)/i.test(name));
      const readDocx = named || (found && found[1]);
      if (!readDocx) throw new Error("DOCX raw read export가 없습니다");
      for (const [key, file] of Object.entries(JSON.parse(process.env.IRIS_DOCX_CASES))) {
        try {
          const value = await readDocx(file);
          if (value && typeof value === "object" && value.error) out[key] = { ok: false, error: String(value.error) };
          else out[key] = { ok: true, data: typeof value === "string" ? value : value && value.data };
        } catch (error) { out[key] = { ok: false, error: String(error && error.message || error) }; }
      }
    } catch (error) { out._setup = String(error && error.message || error); }
    process.stdout.write(JSON.stringify(out));
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 12000, maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_MODULE_URL: moduleUrl, IRIS_DOCX_CASES: JSON.stringify(cases) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _setup: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
function docxLiveProbe(cases) {
  if (!LIVE) return null;
  const script = String.raw`
    import { WebSocket } from "ws";
    const cases = JSON.parse(process.env.IRIS_DOCX_CASES);
    const out = {}, pending = new Map();
    const ws = new WebSocket("ws://127.0.0.1:" + (process.env.IRIS_PORT || "4271") + "/");
    const finish = () => {
      try { ws.close(); } catch {}
      process.stdout.write(JSON.stringify(out), () => { process.exit(0); });
    };
    const timer = setTimeout(() => { out._timeout = [...pending.keys()]; finish(); }, 5000);
    ws.on("open", () => {
      for (const [key, file] of Object.entries(cases)) {
        if (key === "reopen") continue;
        const requestId = "docx-smoke-" + key;
        pending.set(requestId, key);
        ws.send(JSON.stringify({ type: "docx.read", path: file, requestId, space: "docx-smoke", tabId: "file:" + file, reason: "open" }));
      }
    });
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type !== "docx" || !pending.has(msg.requestId)) return;
      const key = pending.get(msg.requestId); pending.delete(msg.requestId); out[key] = msg;
      if (key === "normal" && cases.reopen) {
        const requestId = "docx-smoke-reopen"; pending.set(requestId, "reopen");
        ws.send(JSON.stringify({ type: "docx.read", path: cases.reopen, requestId, space: "docx-smoke", tabId: "file:" + cases.reopen, reason: "open" }));
      }
      if (!pending.size) { clearTimeout(timer); finish(); }
    });
    ws.on("error", (error) => { clearTimeout(timer); out._connection = String(error && error.message || error); finish(); });
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 15000, maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_CASES: JSON.stringify(cases) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _connection: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
export function docxWriteProbe(steps) {
  if (!LIVE) return null;
  const script = String.raw`
    import { WebSocket } from "ws";
    const steps = JSON.parse(process.env.IRIS_DOCX_WRITE_STEPS);
    const out = {};
    const ws = new WebSocket("ws://127.0.0.1:" + (process.env.IRIS_PORT || "4271") + "/");
    let i = 0;
    const finish = () => { try { ws.close(); } catch {} process.stdout.write(JSON.stringify(out), () => { process.exit(0); }); };
    const timer = setTimeout(() => { out._timeout = steps.slice(i).map((s) => s.requestId); finish(); }, 8000);
    const sendNext = () => {
      if (i >= steps.length) { clearTimeout(timer); finish(); return; }
      ws.send(JSON.stringify({ space: "docx-smoke", tabId: "file:" + steps[i].path, reason: "open", ...steps[i] }));
    };
    ws.on("open", sendNext);
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (!steps[i] || msg.requestId !== steps[i].requestId) return;
      out[steps[i].requestId] = msg;
      i++;
      sendNext();
    });
    ws.on("error", (error) => { clearTimeout(timer); out._connection = String(error && error.message || error); finish(); });
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 12000, maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_WRITE_STEPS: JSON.stringify(steps) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _connection: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
// 두 WS 연결이 같은 baselineRevision으로 동시에(barrier로 정렬해 둘 다 응답 전에 보낸다) 저장을
// 시도했을 때 정확히 하나만 성공하는지 확인한다. docxWriteProbe는 순차 실행이라 이 경합을
// 재현하지 못한다.
export function docxConcurrentWriteProbe(path1, baselineRevision, payloads) {
  if (!LIVE) return null;
  const script = String.raw`
    import { WebSocket } from "ws";
    const { path: p, baselineRevision, payloads } = JSON.parse(process.env.IRIS_DOCX_CONCURRENT);
    const out = {};
    let opened = 0, done = 0;
    const sockets = payloads.map((_, i) => new WebSocket("ws://127.0.0.1:" + (process.env.IRIS_PORT || "4271") + "/"));
    const finish = () => { for (const s of sockets) { try { s.close(); } catch {} } process.stdout.write(JSON.stringify(out), () => process.exit(0)); };
    const timer = setTimeout(() => { out._timeout = true; finish(); }, 8000);
    sockets.forEach((ws, i) => {
      ws.on("open", () => {
        opened++;
        if (opened === sockets.length) {
          sockets.forEach((s, j) => s.send(JSON.stringify({ type: "docx.write", path: p, requestId: "concurrent-" + j, baselineRevision, data: payloads[j], space: "docx-smoke", tabId: "file:" + p, reason: "save" })));
        }
      });
      ws.on("message", (data) => {
        let msg; try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.requestId !== "concurrent-" + i) return;
        out["r" + i] = msg;
        done++;
        if (done === sockets.length) { clearTimeout(timer); finish(); }
      });
      ws.on("error", (error) => { clearTimeout(timer); out._connection = String(error && error.message || error); finish(); });
    });
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 12000, maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_CONCURRENT: JSON.stringify({ path: path1, baselineRevision, payloads }) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _connection: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
// docxConcurrentWriteProbe의 변형이다. 모든 소켓이 같은 문자열 path를 쓰는 대신 소켓마다 다른
// path 문자열(같은 실제 파일을 가리키는 별칭, 예: "dir/file.docx" vs "dir/./file.docx")을 써서
// enqueuePathIo의 큐 키가 경로 문자열을 정규화하는지 검증한다(경로 별칭이 직렬화를 우회할 위험).
export function docxAliasedConcurrentWriteProbe(paths, baselineRevision, payloads) {
  if (!LIVE) return null;
  const script = String.raw`
    import { WebSocket } from "ws";
    const { paths, baselineRevision, payloads } = JSON.parse(process.env.IRIS_DOCX_ALIASED);
    const out = {};
    let opened = 0, done = 0;
    const sockets = payloads.map((_, i) => new WebSocket("ws://127.0.0.1:" + (process.env.IRIS_PORT || "4271") + "/"));
    const finish = () => { for (const s of sockets) { try { s.close(); } catch {} } process.stdout.write(JSON.stringify(out), () => process.exit(0)); };
    const timer = setTimeout(() => { out._timeout = true; finish(); }, 8000);
    sockets.forEach((ws, i) => {
      ws.on("open", () => {
        opened++;
        if (opened === sockets.length) {
          sockets.forEach((s, j) => s.send(JSON.stringify({ type: "docx.write", path: paths[j], requestId: "aliased-" + j, baselineRevision, data: payloads[j], space: "docx-smoke", tabId: "file:" + paths[j], reason: "save" })));
        }
      });
      ws.on("message", (data) => {
        let msg; try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.requestId !== "aliased-" + i) return;
        out["r" + i] = msg;
        done++;
        if (done === sockets.length) { clearTimeout(timer); finish(); }
      });
      ws.on("error", (error) => { clearTimeout(timer); out._connection = String(error && error.message || error); finish(); });
    });
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 12000, maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_ALIASED: JSON.stringify({ paths, baselineRevision, payloads }) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _connection: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
// 대용량·malformed payload는 env var로 넘기면 너무 크거나 인코딩이 깨지므로 child 안에서 직접
// 만든다. 그래서 정상 크기 payload만 쓰는 docxWriteProbe와 분리한다.
export function docxSizedWriteProbe(fixturePath, spec) {
  if (!LIVE) return null;
  const script = String.raw`
    import { WebSocket } from "ws";
    const spec = JSON.parse(process.env.IRIS_DOCX_SIZED_SPEC);
    const out = {};
    const ws = new WebSocket("ws://127.0.0.1:" + (process.env.IRIS_PORT || "4271") + "/");
    const finish = () => { try { ws.close(); } catch {} process.stdout.write(JSON.stringify(out), () => process.exit(0)); };
    const timer = setTimeout(() => { out._timeout = true; finish(); }, 15000);
    let i = 0;
    const buildPayload = (step) => {
      if (step.kind === "malformedBase64") return "not-valid-base64!!!@@@***";
      const buf = Buffer.alloc(step.bytes, 65);
      return buf.toString("base64");
    };
    const sendNext = () => {
      if (i >= spec.steps.length) { clearTimeout(timer); finish(); return; }
      const step = spec.steps[i];
      const data = buildPayload(step);
      ws.send(JSON.stringify({ type: "docx.write", path: spec.path, requestId: "sized-" + i, baselineRevision: step.baselineRevision, data, space: "docx-smoke", tabId: "file:" + spec.path, reason: "save" }));
    };
    ws.on("open", sendNext);
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.requestId !== "sized-" + i) return;
      out["s" + i] = msg;
      i++;
      sendNext();
    });
    ws.on("error", (error) => { clearTimeout(timer); out._connection = String(error && error.message || error); finish(); });
  `;
  try {
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 20000, maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, IRIS_DOCX_SIZED_SPEC: JSON.stringify({ path: fixturePath, steps: spec }) },
    });
    return JSON.parse(raw || "{}");
  } catch (error) {
    return { _connection: String((error.stderr || "") + (error.stdout || "") + (error.message || error)).slice(0, 500) };
  }
}
export async function runDocxBlock1Checks() {
  if (DOCX_CARD.toUpperCase().startsWith("B2-")) return;
  console.log("\n[DOCX Block 1 RED] 라우팅·전송·안전장치");
  const selected = DOCX_CARD ? DOCX_CARD.toUpperCase() : "";
  const card = (id, name, fn) => { if (!selected || selected === id) check(`[DOCX-B1-${id}] ${name}`, fn); };
  const srv = read("server/index.js");
  const docxHandlers = read("server/docx-handlers.js");
  const docxPath = path.join(ROOT, "server/docx.js");
  const docx = existsSync(docxPath) ? readFileSync(docxPath, "utf8") : "";
  const temp = mkdtempSync(path.join(tmpdir(), "ac-docx-block1-"));
  const fixture = path.join(temp, "fixture.docx");
  const large = path.join(temp, "over-20mb.docx");
  const exact = path.join(temp, "exactly-20mb.docx");
  const localOutside = path.join(temp, "outside-allowed-root.docx");
  const missing = path.join(temp, "deleted-before-read.docx");
  const integrity = path.join(temp, "readonly.docx");
  const fixtureBytes = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph("DOCX Block 1 fixture")] }],
  }));
  docxAssert(fixtureBytes.length > 0 && fixtureBytes.subarray(0, 2).toString("ascii") === "PK", "생성한 DOCX fixture가 유효한 ZIP이 아님");
  writeFileSync(fixture, fixtureBytes);
  writeFileSync(large, Buffer.alloc(20 * 1024 * 1024 + 1, 0x41));
  writeFileSync(exact, await docxSizedFixture(fixtureBytes, 20 * 1024 * 1024));
  writeFileSync(localOutside, fixtureBytes);
  writeFileSync(integrity, readFileSync(fixture));
  const before = { mtimeNs: statSync(integrity, { bigint: true }).mtimeNs.toString(), sha256: docxDigest(integrity) };
  const probes = docxModuleProbe({ normal: fixture, large, missing, integrity });
  const after = { mtimeNs: statSync(integrity, { bigint: true }).mtimeNs.toString(), sha256: docxDigest(integrity) };
  let live;
  const liveResult = () => { if (live === undefined) live = docxLiveProbe({ normal: fixture, large, missing, integrity, reopen: fixture }); return live; };
  let exactProbe, exactLive;
  const exactProbeResult = () => { if (exactProbe === undefined) exactProbe = docxModuleProbe({ exact }); return exactProbe; };
  const exactLiveResult = () => { if (exactLive === undefined) exactLive = docxLiveProbe({ exact }); return exactLive; };
  let localOutsideProbe, localOutsideLive;
  const localOutsideProbeResult = () => { if (localOutsideProbe === undefined) localOutsideProbe = docxModuleProbe({ localOutside }); return localOutsideProbe; };
  const localOutsideLiveResult = () => { if (localOutsideLive === undefined) localOutsideLive = docxLiveProbe({ localOutside }); return localOutsideLive; };
  const docxRe = docxConstRegex(renderer, "DOCX_RE");
  const binaryRe = docxConstRegex(renderer, "BINARY_RE");
  const sheetRe = docxConstRegex(renderer, "SHEET_RE");
  // 요청은 두 단계다. 앱 셸이 등록표에 묻고(requestFileContent), 무엇을 어떻게 읽을지와
  // 세대 번호는 각 종류가 처리한다(viewer/kinds.js 의 read). 첫 단계만 보면
  // "docx.read 를 보내지 않음"으로 항상 실패한다. 종류의 read 는 이름으로 적지 않고 등록표를
  // 실제로 호출해 꺼낸다. 이름을 적으면 이름이 바뀌는 날 아무것도 찾지 못한다.
  const fkm = await import(new URL("../../../web/js/core/file-kinds.js", import.meta.url).href);
  const { registerViewerKinds } = await import(new URL("../../../web/js/viewer/kinds.js", import.meta.url).href);
  fkm.clearFileKinds();
  registerViewerKinds();
  const kindReads = fkm.fileKinds().map((spec) => String(spec.read || "")).join("\n");
  if (fkm.fileKinds().length < 2 || kindReads.length < 200) {
    cannotMeasure(`등록표에서 읽기 경로를 못 꺼냈다: 종류 ${fkm.fileKinds().length} · 글자 ${kindReads.length}`);
  }
  const request = docxSourceFunction(renderer, "requestFileContent") + "\n" + kindReads;
  const render = docxSourceFunction(renderer, "renderFileViewBody");
  const docxRender = docxRenderBranch(renderer, render);
  const response = docxWsHandler(renderer, "docx");
  const fileResponse = docxWsHandler(renderer, "file");
  const terminal = docxSourceFunction(renderer, "openTerminalPath");
  // openFile은 docx/sheet를 로컬 탭이 아니라 openDocInSpaceBrowser(스페이스
  // 브라우저 영역)로 보내는 분기만 담당한다. 탭을 다시 열 때 read 를 재요청하는 로직은
  // openFileLocal(도킹 시 그대로 재사용하는 기존 openFile 본문)에 있다. PDF/HTML처럼
  // 🌐 영역으로 가고 뷰어 쪽 로컬 탭은 만들지 않는다.
  const open = docxSourceFunction(renderer, "openFileLocal");

  try {
    card("T1", "정상 DOCX는 base64 응답과 빈 문서 컨테이너로 열린다", () => {
      docxAssert(docxRe && docxRe.test("report.DOCX") && !docxRe.test("legacy.doc"), "DOCX_RE가 .docx만 분류하지 않음");
      docxAssert(/type\s*:\s*["']docx\.read["']/.test(request), "파일 열기가 docx.read를 보내지 않음");
      docxAssert(/msg\.type\s*===\s*["']docx\.read["']/.test(srv), "서버 dispatcher가 docx.read를 받지 않음");
      docxAssert(existsSync(docxPath), "server/docx.js가 없음");
      docxAssert(probes.normal?.ok && probes.normal.data === readFileSync(fixture).toString("base64"), "정상 파일의 원본 base64가 반환되지 않음: " + (probes._setup || probes.normal?.error || "응답 없음"));
      docxAssert(response && /\bm\.data\b/.test(response) && !/\[열 수 없음\]/.test(response), "docx 성공 응답이 전용 상태로 수렴하지 않음");
      docxAssert(docxRender && /(?:<\s*(?:div|section|article)\b|createElement\s*\(\s*["'](?:div|section|article)["'])/i.test(docxRender)
        && !/\[열 수 없음\]/.test(docxRender), "DOCX 전용 빈 컨테이너가 없거나 '[열 수 없음]' 경로로 샘");
      if (LIVE) {
        const got = liveResult();
        docxAssert(got?.normal?.type === "docx" && got.normal.data === readFileSync(fixture).toString("base64"), "live docx.read 정상 응답 실패: " + (got?._connection || JSON.stringify(got?._timeout || got?.normal || {})));
      }
      return true;
    });

    card("T11", "20MB 초과 DOCX는 이유를 보이고 다른 화면을 멈추지 않는다", () => {
      docxAssert(!probes.large?.ok && /20\s*MB|20MB|너무 큽니다|초과/.test(probes.large?.error || ""), "20MB 초과가 명시적 오류로 거절되지 않음: " + (probes._setup || probes.large?.error || "응답 없음"));
      docxAssert(response && /\bm\.error\b/.test(response)
        && (/showToast\s*\([\s\S]{0,200}m\.error/.test(response)
          || /(?:textContent|innerHTML)\s*=[\s\S]{0,200}(?:m\.error|docxError)/.test(response + render)),
      "DOCX 크기 오류 이유를 토스트나 문서 오류 영역에 표시하지 않음");
      if (LIVE) {
        const got = liveResult();
        docxAssert(got?.large?.type === "docx" && /20\s*MB|20MB|너무 큽니다|초과/.test(got.large.error || ""), "live 대용량 오류 응답 실패: " + (got?._connection || JSON.stringify(got?._timeout || got?.large || {})));
      }
      return true;
    });

    card("T12", "파일시스템에서 사라진 DOCX는 읽기 오류를 보인다(OOXML 파싱 아님)", () => {
      docxAssert(!probes.missing?.ok && !!probes.missing?.error, "존재하지 않는 파일이 읽기 실패로 수렴하지 않음: " + (probes._setup || "응답 없음"));
      docxAssert(response && /\bm\.error\b/.test(response)
        && (/showToast\s*\([\s\S]{0,200}m\.error/.test(response)
          || /(?:textContent|innerHTML)\s*=[\s\S]{0,200}(?:m\.error|docxError)/.test(response + render)),
      "파일시스템 오류 이유를 토스트나 문서 오류 영역에 표시하지 않음");
      if (LIVE) {
        const got = liveResult();
        docxAssert(got?.missing?.type === "docx" && !!got.missing.error, "live 파일시스템 오류 응답 실패: " + (got?._connection || JSON.stringify(got?._timeout || got?.missing || {})));
      }
      return true;
    });

    card("T13", "XLSX 표 뷰어와 구형 DOC 차단은 그대로다", () => {
      docxAssert(sheetRe?.test("book.xlsx") && /type\s*:\s*["']sheet\.read["']/.test(request), ".xlsx가 기존 sheet.read 경로를 유지하지 않음");
      docxAssert(binaryRe?.test("legacy.doc"), ".doc 구형 바이너리 차단이 사라짐");
      docxAssert(/if\s*\(m\.binary\)/.test(fileResponse) && /revealInFinder/.test(fileResponse)
        && /뷰어로 열 수 없는 형식/.test(fileResponse), ".doc의 Finder 전환과 기존 차단 안내가 보존되지 않음");
      // .docx 는 BINARY_RE 에 그대로 있고, 등록표가 먼저 판정해 뷰어로 보내는 것이 보장
      // 조건이다. 그래서 BINARY_RE 를 사용하는 위치마다 그 앞에 등록표에 묻는 줄이 있는지
      // 순서를 검사한다. 그 줄이 없으면 .docx 가 "열 수 없는 형식"으로 분류되어 Finder 로
      // 열린다.
      docxAssert(docxRe?.test("modern.docx"), "등록표의 DOCX 판정이 .docx 를 안 잡음");
      const routing = read("web/js/center/file-routing.js");
      const binaryUses = [...routing.matchAll(/BINARY_RE\.test\(/g)].map((m) => m.index);
      docxAssert(binaryUses.length >= 2, `BINARY_RE 사용을 ${binaryUses.length} 곳만 셌다 — 거르개가 말뭉치를 먹었다`);
      for (const at of binaryUses) {
        const before = routing.slice(Math.max(0, at - 700), at);
        docxAssert(/fileKindOf\s*\(/.test(before),
          "BINARY_RE 를 등록표보다 먼저 묻는 자리가 있다 — .docx 가 뷰어 대신 Finder 로 샌다");
      }
      return true;
    });

    card("T14", "DOCX 열람은 원본 mtime과 sha256을 바꾸지 않는다", () => {
      docxAssert(probes.integrity?.ok, "DOCX raw read가 성공하지 않음: " + (probes._setup || probes.integrity?.error || "응답 없음"));
      docxAssert(before.mtimeNs === after.mtimeNs, `mtime 변경: ${before.mtimeNs} -> ${after.mtimeNs}`);
      docxAssert(before.sha256 === after.sha256, `sha256 변경: ${before.sha256} -> ${after.sha256}`);
      // 이 검사의 의도는 "읽기 함수(readDocxRaw)가 쓰기 연산을 하지 않는다"이다. 파일
      // 전체가 읽기 전용이던 때는 파일 전체를 스캔해도 같은 뜻이었다. 그러나 같은 파일에
      // 설계상 반드시 필요한 쓰기 함수 writeDocxRaw 가 추가되면서, "전체 파일에 쓰기
      // 키워드가 없어야 한다"는 조건은 원래 의도와 맞지 않게 됐다. destructuring alias 로
      // 이 조건을 피해 가는 방법은 쓰기 함수의 이름이 바뀌면 그대로 깨지므로 해결이
      // 아니다. 그래서 readDocxRaw 함수 본문만 스캔하도록 범위를 좁힌다. 읽기 함수가
      // 쓰기를 하는 실제 위반에 대한 탐지력은 유지되고, 별도 함수인 writeDocxRaw 는 검사
      // 대상에서 정당하게 제외된다.
      const readFnOnly = docxSourceFunction(docx, "readDocxRaw") || docx;
      docxAssert(!/\b(?:writeFile|appendFile|truncate|rename|unlink|rm)(?:Sync)?\s*\(/.test(readFnOnly), "readDocxRaw에 쓰기 계열 파일 연산이 있음");
      if (LIVE) {
        const got = liveResult();
        docxAssert(got?.integrity?.type === "docx" && !got.integrity.error, "live 읽기 전용 요청 실패: " + (got?._connection || JSON.stringify(got?._timeout || got?.integrity || {})));
      }
      return true;
    });

    card("T15", "터미널 DOCX 경로 클릭은 Finder 대신 같은 뷰어로 간다", () => {
      // 여기서는 확장자를 직접 검사하지 않고 등록표에 묻는다. 순서가 뒤집히면 .docx 가
      // "열 수 없는 형식"으로 분류되어 Finder 로 열리므로 순서까지 검사한다.
      const docxAt = terminal.indexOf("fileKindOf(p)"), binaryAt = terminal.indexOf("BINARY_RE.test(p)");
      docxAssert(docxAt >= 0, "터미널 경로 열기가 종류를 등록표에 묻지 않음");
      docxAssert(binaryAt > docxAt, "등록표에 묻는 자리가 BINARY_RE보다 먼저 있지 않음 — .docx 가 Finder 로 샌다");
      const branch = terminal.slice(docxAt, binaryAt);
      docxAssert(/openFile\(p\)/.test(branch) && !/revealTerminalPath|revealInFinder/.test(branch), "터미널 DOCX 클릭이 openFile로만 수렴하지 않음");
      docxAssert(/type\s*:\s*["']docx\.read["']/.test(request) && !!docxRender
        && response && !/\[열 수 없음\]/.test(response), "터미널 진입점이 T1의 전송·컨테이너 결과로 이어지지 않음");
      if (LIVE) {
        const got = liveResult();
        docxAssert(got?.normal?.type === "docx" && got.normal.data === readFileSync(fixture).toString("base64"), "터미널 경로와 같은 live docx.read가 성공하지 않음: " + (got?._connection || JSON.stringify(got?._timeout || got?.normal || {})));
      }
      return true;
    });

    card("T16", "DOCX 탭을 닫았다 다시 열면 새 read와 컨테이너를 만든다", () => {
      // 탭 목록은 tab-store 질의 뒤에 있으므로 객체 이름(tabsBySpace)이 아니라 순서를
      // 검사한다. "이미 있는 탭인가"를 먼저 묻고 없을 때만 read 를 다시 보낸다. 무조건
      // 보내면 탭을 다시 열 때마다 서버 왕복이 늘고, 보내지 않으면 본문이 표시되지 않는다.
      const missAt = open.search(/if\s*\(\s*![\s\S]{0,120}?\.find\(/);
      docxAssert(missAt >= 0, "없는 탭인지 묻는 자리를 찾지 못함");
      const reads = [...open.matchAll(/requestFileContent\(path\)/g)].map((m) => m.index);
      docxAssert(reads.length === 1, `read 재요청을 ${reads.length} 곳에서 센다 — 한 곳이어야 한다`);
      docxAssert(reads[0] > missAt, "없는 탭인지 묻기 전에 read 를 보낸다 — 탭을 다시 열 때마다 헛 왕복이 는다");
      docxAssert(/type\s*:\s*["']docx\.read["']/.test(request) && !!docxRender, "재열람이 DOCX 전송·컨테이너 경로로 이어지지 않음");
      if (LIVE) {
        const got = liveResult();
        docxAssert(got?.reopen?.type === "docx" && got.reopen.data === readFileSync(fixture).toString("base64"), "두 번째 live docx.read가 성공하지 않음: " + (got?._connection || JSON.stringify(got?._timeout || got?.reopen || {})));
      }
      return true;
    });

    card("T20", "정확히 20MB인 DOCX는 거절 없이 원본 base64를 반환한다", () => {
      const got = exactProbeResult();
      const expected = readFileSync(exact).toString("base64");
      docxAssert(got?.exact?.ok && !got.exact.error && got.exact.data === expected,
        "정확히 20MB인 DOCX가 원본 base64로 반환되지 않음: " + (got?._setup || got?.exact?.error || "응답 없음"));
      if (LIVE) {
        const liveGot = exactLiveResult();
        docxAssert(liveGot?.exact?.type === "docx" && !liveGot.exact.error && liveGot.exact.data === expected,
          "live 정확히 20MB DOCX 응답 실패: " + (liveGot?._connection || JSON.stringify(liveGot?._timeout || liveGot?.exact || {})));
      }
      return true;
    });

    card("T21", "대문자 .DOCX도 DOCX_RE로 분류된다", () => {
      docxAssert(docxRe?.test("REPORT.DOCX") === true, "DOCX_RE가 대문자 .DOCX를 분류하지 않음");
      return true;
    });

    card("T22", "로컬 DOCX 읽기는 fsPathAllowed 밖 경로도 연다", () => {
      const handler = docxDispatchedHandler(srv, docxHandlers, "docx.read");
      docxAssert(!localOutside.startsWith(ROOT + path.sep), "로컬 예외 fixture가 워크스페이스 안에 생성됨");
      docxAssert(/!ws\._local\s*&&\s*!fsPathAllowed\(\s*p\s*\)/.test(handler), "docx.read가 로컬 연결의 fsPathAllowed 예외를 보존하지 않음");
      const got = localOutsideProbeResult();
      const expected = readFileSync(localOutside).toString("base64");
      docxAssert(got?.localOutside?.ok && got.localOutside.data === expected,
        "fsPathAllowed 밖 로컬 DOCX raw read가 성공하지 않음: " + (got?._setup || got?.localOutside?.error || "응답 없음"));
      if (LIVE) {
        const liveGot = localOutsideLiveResult();
        docxAssert(liveGot?.localOutside?.type === "docx" && !liveGot.localOutside.error && liveGot.localOutside.data === expected,
          "live 로컬 경계 밖 DOCX 응답 실패: " + (liveGot?._connection || JSON.stringify(liveGot?._timeout || liveGot?.localOutside || {})));
      }
      return true;
    });

    // "generation 이라는 문자열이 있는가"로 검사하면 세대 번호를 상수 0 으로 바꾸거나
    // 응답의 대조식을 지워도 그 문자열이 남아 있어, 가드가 없어도 검사가 통과한다. 그래서
    // 계약을 그대로 검사한다. 요청은 매번 새 번호를 매겨 탭에 기록하고, 응답은 그 번호가
    // 다르면 상태를 변경하기 전에 반환한다.
    card("STALE", "늦은 DOCX 응답은 최신 탭 화면을 덮지 않는다", () => {
      docxAssert(/\.docxGeneration\s*=/.test(request), "요청이 탭에 세대 번호를 안 새김");
      docxAssert(/\+\+\s*[A-Za-z_$][\w$]*/.test(request),
        "세대 번호가 매번 새로 매겨지지 않음 — 늘 같은 값이면 늦은 응답과 최신 응답을 못 가른다");
      const responseGuard = response.search(/\.docxGeneration\s*!==[\s\S]{0,80}?(?:return|continue)/);
      const mutation = response.search(/\bm\.data\b|\.docx[A-Za-z_$]*\s*=/i);
      docxAssert(responseGuard >= 0, "응답이 탭의 세대 번호를 대조하고 돌아서지 않음");
      docxAssert(mutation >= 0 && responseGuard < mutation, "stale 세대 응답을 상태 변경 전에 폐기하지 않음");
      return true;
    });

    card("REMOTE", "원격 DOCX 읽기는 fsPathAllowed 경계를 우회하지 않는다", () => {
      const handler = docxDispatchedHandler(srv, docxHandlers, "docx.read");
      docxAssert(/!ws\._local\s*&&\s*!fsPathAllowed\(\s*p\s*\)/.test(handler), "원격 docx.read에 fsPathAllowed 경계가 없음");
      docxAssert(["requestId", "space", "tabId", "reason"].every((field) => new RegExp(field + "\\s*:\\s*msg\\." + field).test(handler)), "DOCX 오류/성공 응답이 correlation envelope를 보존하지 않음");
      return true;
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export default async function run() {
  await runDocxBlock1Checks();
}
