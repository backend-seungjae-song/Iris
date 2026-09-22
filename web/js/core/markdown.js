// 경량 마크다운 처리기. 파일·메모의 같은 원문을 같은 HTML로 변환한다.
//
// 소유 범위
//   mdToHtml 의 줄 단위 블록 파싱과 인라인 마크업 변환 규칙.
//
// 제공 API
//   initMarkdown({ esc }): HTML escape 함수를 받는다. main 이 한 번 호출한다.
//   mdToHtml(src): 헤딩·강조·코드·리스트·링크·인용·hr을 HTML로 변환한다.
//   isMarkdownExtension(ext): md·markdown 확장자의 공통 판정.
//
// 의존 대상
//   esc 를 init 에서 주입받는다. main 에서 import 하지 않는다. core 가 main 을 참조하면 순환이 생긴다.
//
// 유지 조건
//   파일 미리보기·메모·별도 메모 창이 반드시 같은 처리기를 쓴다.
//   입력 HTML은 인라인 마크업을 적용하기 전에 escape 한다.
//
// 영향 범위
//   파일 미리보기, panel 메모 미리보기, 별도 메모 창 미리보기, 메모 관리 화면.

let escapeHtml = null;

export function isMarkdownExtension(ext) {
  return /^(md|markdown)$/i.test(String(ext || ""));
}

export function initMarkdown(deps) {
  escapeHtml = deps.esc;
}

// 경량 마크다운 → HTML (헤딩·강조·코드·리스트·링크·인용·hr).
// 줄 단위 파서다. 빈 줄(\n{2,})로 블록을 나누면 헤딩·리스트 사이에 빈 줄이 없는 문서에서
// 첫 헤딩만 인식되고 나머지가 literal로 깨지므로, 줄 단위로 블록을 인식한다.
export function mdToHtml(src) {
  const inline = (source) => {
    const escaped = escapeHtml(source), codes = [];
    let placeholder = "\u0000";
    while (escaped.includes(placeholder)) placeholder += "\u0000";
    return escaped.replace(/`([^`]+)`/g, (match, code) => {
      codes.push(`<code>${code}</code>`);
      return `${placeholder}${codes.length - 1}${placeholder}`;
    })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(new RegExp(`${placeholder}(\\d+)${placeholder}`, "g"), (match, index) => codes[Number(index)]);
  };
  const isTableSep = (s) => s.includes("|") && s.includes("-") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s);
  const isHr = (s) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(s);
  const isHeading = (s) => /^(#{1,6})\s+/.test(s);
  const isList = (s) => /^\s*([-*+]|\d+\.)\s+/.test(s);
  const isQuote = (s) => /^\s*>\s?/.test(s);
  const isFence = (s) => /^\s*```/.test(s);
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*$/.test(ln)) { i++; continue; }
    if (isFence(ln)) { // 펜스 코드: 닫는 ```까지
      i++; const body = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; html += `<pre class="md-code">${escapeHtml(body.join("\n"))}</pre>`; continue;
    }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>${inline(h[2].replace(/\s+#+\s*$/, ""))}</h${h[1].length}>`; i++; continue; }
    if (isHr(ln)) { html += "<hr>"; i++; continue; }
    if (ln.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) { // 테이블
      const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const head = cells(ln); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      html += "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"
        + rows.map((r) => "<tr>" + head.map((_, j) => `<td>${inline(r[j] || "")}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
      continue;
    }
    if (isQuote(ln)) { // 인용(연속)
      const q = [];
      while (i < lines.length && isQuote(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      html += `<blockquote>${inline(q.join("\n")).replace(/\n/g, "<br>")}</blockquote>`; continue;
    }
    if (isList(ln)) { // 리스트(연속)
      const ordered = /^\s*\d+\.\s/.test(ln); const items = [];
      while (i < lines.length && isList(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")); i++; }
      html += `<${ordered ? "ol" : "ul"}>` + items.map((item) => {
        const task = /^\[([ xX])\] (.*)$/.exec(item);
        return task ? `<li class="md-task"><input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""} aria-label="${task[1] === " " ? "미완료" : "완료"}"><span>${inline(task[2])}</span></li>` : `<li>${inline(item)}</li>`;
      }).join("") + `</${ordered ? "ol" : "ul"}>`;
      continue;
    }
    const para = []; // 단락: 다음 블록 시작·빈 줄 전까지
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isFence(lines[i]) && !isHeading(lines[i])
           && !isQuote(lines[i]) && !isList(lines[i]) && !isHr(lines[i])
           && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i]); i++;
    }
    if (para.length) html += `<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`;
    else i++;
  }
  return html;
}
