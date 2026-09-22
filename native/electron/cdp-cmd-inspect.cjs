// 페이지 상태를 읽고 판정·관찰하는 CDP command handler.
//
// 소유 범위
//   snapshot·eval·expect·text·a11y·locate·observe의 조회 순서, 판정과 응답 문구.
//
// 제공 API
//   createInspectCommands(ctx)가 명령 이름별 async handler 표를 준다. 원시 상태 컨테이너는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 snapshot/ref/hint/observation/download/중첩 실행 포트와 fs/path/캡처 폴더,
//   명령마다 넘기는 CDP send·Electron webContents. Electron이나 cdp-control.cjs를 직접 require하지 않는다.
//
// 유지 조건
//   snapshot ref의 탭·페이지 세대 결속, expect의 같은 순간 판정·증거, 프레임 합산 locate/text,
//   observe 버퍼 상한·지문 중복 억제와 비밀 비노출 결과 경로를 그대로 보존한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 snapshot/ref/hint/observation/download/dispatcher 조립과 frame sender다.
//   양방향 소비자는 cdp-control.cjs handler 표·default 안내, CLI/MCP 조회·판정·QA 보고 흐름이다.

function createInspectCommands({
  buildSnapshot,
  refRegistry,
  loginHint,
  humanHint,
  observation,
  downloadState,
  cdpExecRaw,
  webContentsMod,
  fs,
  path,
  shotsDir,
}) {
  return {
    async snapshot(send, wc, args) {
      // 예산·질의·이어보기를 그대로 넘긴다. ref는 자르기 전에 붙으므로 어느 조각을 봐도 같은
      // 번호가 같은 요소를 가리킨다.
      // 접근성 트리는 타깃 하나만 순회한다. 교차 출처 iframe은 별도 타깃이라, 최상위만 순회하면
      // 사용자에게 보이는 다른 출처의 iframe 안 화면이 통째로 빠진다.
      // 프레임 세션을 함께 넘겨 하나의 트리로 잇고 번호도 이어서 부여한다.
      const frameSenders = send.frames().filter(Boolean).map((sid) => ({ sid, send: send.on(sid) }));
      const s = await buildSnapshot(send, {
        budget: args.budget, cursor: args.cursor,
        role: args.role, name: args.name, region: args.region,
        frames: frameSenders,
      });
      refRegistry.recordSnapshot(wc.id, s.refMap); // ref는 이 탭·이 페이지 세대에만 유효
      const out = { url: wc.getURL(), title: wc.getTitle(), refCount: s.refs.length, snapshot: s.snapshot,
        lines: s.total, shown: s.shownCount, bytes: s.bytes,
        frames: frameSenders.length ? frameSenders.length + 1 : undefined,
        truncated: s.truncated || undefined, cursor: s.cursor ?? undefined, query: s.query || undefined };
      // 로그인 칸이 보이면 그 자리에서 알려 준다. 도구 목록만으로는 자동 로그인 가능 여부를 알 수
      // 없어 사람에게 넘기는 일이 있었다. 판단 근거를 결과에 함께 싣는다.
      const hint = await loginHint(send);
      if (hint) out.loginHint = hint;
      const hh = await humanHint(send);
      if (hh) out.humanHint = hh;
      return out;
    },
    async eval(send, _wc, args) {
      // userGesture: 파일 선택창·클립보드·전체화면처럼 사용자 활성화를 요구하는 API가 eval에서도
      // 동작하게 한다. 없으면 input[type=file].click()이 조용히 무시된다(확인 결과).
      const r = await send("Runtime.evaluate", { expression: args.expression || "", returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error");
      return { value: r.result ? r.result.value : undefined };
    },
    // 판정과 증거를 한 번에 만든다. 조건 확인과 스크린샷이 따로면 둘을 다시 이어붙여야 하고,
    // 그 사이에 화면이 바뀌면 증거가 판정과 다른 순간의 것이 된다. 여기서는 같은 순간을 쓴다.
    async expect(send, wc, args) {
      const sel = args.sel ? String(args.sel) : null;
      const want = args.text == null ? null : String(args.text);
      const mode = String(args.mode || (want == null ? "exists" : "contains"));
      // 프레임마다 확인한다. 없음 판정은 모든 프레임에서 없어야 참이고, 나머지는 찾은 프레임의
      // 답을 쓴다. 최상위에만 확인하면 iframe 안 문구가 통째로 요소 없음이 된다.
      const rs = await send.all("Runtime.evaluate", {
        expression: `(() => {
          const sel = ${JSON.stringify(sel)}, want = ${JSON.stringify(want)}, mode = ${JSON.stringify(mode)};
          // 선택자가 여러 곳에 맞을 때 첫 요소만 보고 판정하면 조용히 틀린다. 사이드바 버튼을
          // 보면서 팝업 버튼으로, 뒤에 있는 시트를 보면서 앞의 대화상자로 판정한 사례가 있다.
          // 맞은 것을 전부 보고, 몇 개였는지 함께 남긴다.
          const all = sel ? __acQA(sel) : [document.body];
          const n = all.length;
          if (!n) return JSON.stringify({ pass: mode === "absent", found: false, got: null, n: 0 });
          const labelOf = (e) => {
            const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const labelled = clean((e.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
            const name = labelled || clean(e.getAttribute("aria-label")) || clean(e.labels && Array.from(e.labels).map((l) => l.textContent).join(" "))
              || clean(e.getAttribute("alt")) || clean(e.getAttribute("title")) || clean(e.innerText || e.textContent);
            const kind = ({BUTTON:"버튼", A:"링크", INPUT:"입력칸", TEXTAREA:"입력칸", SELECT:"선택 목록", IMG:"이미지", SUMMARY:"펼침 항목", DETAILS:"상세 영역", BODY:"페이지", DIALOG:"대화상자"})[e.tagName] || "화면 요소";
            return name ? kind + " ‘" + name.slice(0, 64) + (name.length > 64 ? "…" : "") + "’" : "이름 없는 " + kind;
          };
          const textOf = (e) => (e.value != null && e.tagName === "INPUT" ? e.value : (e.innerText || e.textContent || "")).trim();
          // 없음을 확인할 때 글자를 함께 주면 그것은 요소가 아니라 그 글자가 없다는 확인이다.
          // 글자를 버리고 요소만 보면 화면에 그 글자가 없어도 있다는 판정이 나온다.
          // 맞은 것 전부에서 보이지 않아야 통과다.
          if (mode === "absent") {
            if (want == null) return JSON.stringify({ pass: false, found: true, got: textOf(all[0]).slice(0, 200), n, element: labelOf(all[0]) });
            let seen = -1;
            for (let i = 0; i < n; i++) { if (textOf(all[i]).includes(want)) { seen = i; break; } }
            return JSON.stringify({ pass: seen < 0, found: true, n, hit: seen >= 0 ? seen : null,
              got: seen >= 0 ? textOf(all[seen]).slice(0, 300) : null, element: labelOf(all[seen >= 0 ? seen : 0]) });
          }
          if (mode === "exists") return JSON.stringify({ pass: true, found: true, got: textOf(all[0]).slice(0, 200), n, element: labelOf(all[0]) });
          let hit = -1;
          for (let i = 0; i < n; i++) {
            const g = textOf(all[i]);
            if (mode === "equals" ? g === want : g.includes(want)) { hit = i; break; }
          }
          const el = all[hit >= 0 ? hit : 0];
          return JSON.stringify({ pass: hit >= 0, found: true, got: textOf(el).slice(0, 300), element: labelOf(el), n, hit: hit >= 0 ? hit : null });
        })()`, returnByValue: true,
      });
      const parsed = [];
      for (const r of rs) { try { parsed.push(JSON.parse(r.result.value)); } catch {} }
      // 찾은 프레임이 있으면 그 답이 정답이다. 어디에도 없으면 "없음"이고, 그때 absent 는 통과다.
      let v = parsed.find((p) => p && p.found);
      if (!v) v = { pass: mode === "absent", found: false, got: null };
      // 몇 개가 맞았는지를 판정문에 실어 둔다. 하나로 좁혀지지 않은 질문은 그 사실이 보고서에
      // 그대로 남아야 읽는 사람이 "무엇을 보고 내린 판정인가"를 되짚을 수 있다.
      const many = v.n > 1 ? ` (${v.n}곳 중${v.hit != null ? ` ${v.hit + 1}번째` : ""})` : "";
      const desc = (mode === "absent" ? (want == null ? `${sel} 없음` : `${sel}에 "${want}" 없음`)
        : mode === "exists" ? `${sel} 있음`
        : `${sel} ${mode === "equals" ? "=" : "⊃"} "${want}"`) + many;
      const target = v.element || "지정한 화면 요소";
      const readable = (mode === "absent" ? (want == null ? `${target}: 없어야 함` : `${target}: “${want}” 문구가 없어야 함`)
        : mode === "exists" ? `${target}: 있어야 함`
        : `${target}: ${mode === "equals" ? "전체 내용이" : "내용에"} “${want}”${mode === "equals" ? "와 같아야 함" : "가 있어야 함"}`) + many;
      // 판정이 무엇을 보고 내려졌는지 화면에 남긴다. 통과든 실패든 같은 순간의 증거다.
      const shot = await cdpExecRaw(webContentsMod(wc), wc.id, "screenshot", {
        mark: sel && v.found ? [{ sel, nth: v.hit != null ? v.hit : 0, label: readable,
          color: v.pass ? "#1B6B4A" : "#B3253F" }] : [],
        caption: `${v.pass ? "됨" : "안 됨"} · ${readable}${v.found ? "" : " (요소 없음)"}`,
        dpr: args.dpr, tab: args.tab,
      }).catch((e) => ({ error: String((e && e.message) || e) }));
      // 판정이 어디서 내려졌는가. 장면의 출처는 기록하면서 판정 위치는 기록하지 않고 있었다
      // (확인 결과: 판정 64건 전부 주소 없음). 그 줄이 무엇을 확인하는 화면인지는 장면이 아니라
      // 판정이 정한다. 지나가며 찍힌 화면은 여럿이고, 그중 무엇이 그 줄의 주제인지는
      // 판정 위치만 알려 준다.
      return { ok: true, pass: !!v.pass, expected: desc, displayExpected: readable, element: v.element || null, got: v.got, found: v.found, matched: v.n,
        url: wc.getURL(), shot: shot && shot.path, shotError: shot && shot.error };
    },
    // 눈으로 보이지 않는 결함: 이름 없는 버튼, alt 없는 이미지, 라벨 없는 입력칸, 너무 옅은 글자.
    // 위치까지 알아야 고칠 수 있으므로 찾은 자리를 그대로 표시한 증거를 함께 남긴다.
    async a11y(send) {
      const r = await send("Runtime.evaluate", {
        expression: `(() => {
          const out = [];
          const vis = (el) => { const b = el.getBoundingClientRect(); const c = getComputedStyle(el);
            return b.width > 0 && b.height > 0 && c.visibility !== "hidden" && c.display !== "none"; };
          const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") ||
            (el.getAttribute("aria-labelledby") ? (document.getElementById(el.getAttribute("aria-labelledby")) || {}).innerText : "") ||
            el.innerText || el.value || "").trim();
          const path = (el) => { const p = []; let n = el;
            while (n && n.nodeType === 1 && p.length < 4) { p.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\\s+/)[0] : "")); n = n.parentElement; }
            return p.join(">"); };
          for (const el of __acQA("button,a[href],[role=button]")) {
            if (vis(el) && !name(el)) out.push({ kind: "이름 없는 조작 요소", at: path(el) });
          }
          for (const el of __acQA("img")) {
            if (vis(el) && !el.alt && el.getAttribute("role") !== "presentation") out.push({ kind: "alt 없는 이미지", at: path(el) });
          }
          for (const el of __acQA("input:not([type=hidden]),select,textarea")) {
            if (!vis(el)) continue;
            const lab = el.labels && el.labels.length ? el.labels[0].innerText.trim() : "";
            if (!lab && !el.getAttribute("aria-label") && !el.getAttribute("placeholder")) out.push({ kind: "라벨 없는 입력칸", at: path(el) });
          }
          // 대비: 배경을 정확히 합성하지는 못하지만, 같은 배경 위 글자색이 지나치게 옅은 경우는 잡힌다.
          const lum = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return null;
            const f = m.slice(0, 3).map((v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
            return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
          let bgEl, seen = 0;
          for (const el of __acQA("p,span,li,td,label,h1,h2,h3,h4,a,button")) {
            if (seen > 400 || !vis(el) || !(el.innerText || "").trim()) continue;
            seen++;
            const cs = getComputedStyle(el); const fg = lum(cs.color);
            bgEl = el; let bg = null;
            while (bgEl && bg == null) { const b = getComputedStyle(bgEl).backgroundColor;
              if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) bg = lum(b); bgEl = bgEl.parentElement; }
            if (fg == null || bg == null) continue;
            const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
            const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
            if (ratio < (big ? 3 : 4.5)) out.push({ kind: "글자 대비 부족(" + ratio.toFixed(1) + ":1)", at: path(el) });
          }
          return JSON.stringify(out.slice(0, 60));
        })()`, returnByValue: true,
      });
      let list = []; try { list = JSON.parse(r.result.value); } catch {}
      return { ok: true, count: list.length, issues: list };
    },
    // 계획 러너가 조작 직전에 대상을 확정하는 자리. querySelector는 여럿이 맞아도 첫 요소를 조용히
    // 고르므로, 중복 클래스·조건부 목록에서 다른 항목을 눌러도 실행은 성공하고 판정까지 통과한다.
    // 조용히 틀리는 것이 멈추는 것보다 나쁘므로, 여기서는 몇 개가 맞았는지·보이는지·가려졌는지를
    // 세어서 돌려주고, 하나로 좁혀지지 않으면 러너가 그 시나리오를 중단한다.
    async locate(send, _wc, args) {
      const spec = {
        testid: args.testid == null ? null : String(args.testid),
        role: args.role == null ? null : String(args.role),
        name: args.name == null ? null : String(args.name),
        sel: args.sel == null ? null : String(args.sel),
        nth: args.nth == null ? null : Number(args.nth),
      };
      // 프레임마다 따로 확인한다. 교차 출처 iframe은 별도 타깃이라 최상위에서 한 번만 확인하면
      // 그 안의 요소는 없다고 돌아온다. 답은 아래에서 합친다.
      const rs = await send.all("Runtime.evaluate", {
        expression: `(() => {
          const spec = ${JSON.stringify(spec)};
          const vis = (el) => {
            const s = getComputedStyle(el), b = el.getBoundingClientRect();
            return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01
              && b.width > 0 && b.height > 0;
          };
          // 접근가능한 이름. 스냅샷이 쓰는 것과 같은 순서로 본다.
          const accName = (el) => {
            const lb = el.getAttribute("aria-label");
            if (lb) return lb.trim();
            const by = el.getAttribute("aria-labelledby");
            if (by) {
              const t = by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" ").trim();
              if (t) return t;
            }
            if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
              if (el.labels && el.labels.length) return (el.labels[0].innerText || "").trim();
              if (el.placeholder) return el.placeholder.trim();
            }
            if (el.tagName === "IMG") return (el.alt || "").trim();
            return (el.innerText || el.textContent || "").trim();
          };
          const IMPLICIT = { A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "combobox",
            TEXTAREA: "textbox", H1: "heading", H2: "heading", H3: "heading", H4: "heading",
            H5: "heading", H6: "heading", NAV: "navigation", MAIN: "main", TABLE: "table",
            UL: "list", OL: "list", LI: "listitem", FORM: "form", DIALOG: "dialog" };
          const roleOf = (el) => {
            const explicit = el.getAttribute("role");
            if (explicit) return explicit.trim().toLowerCase();
            if (el.tagName === "INPUT") {
              const t = (el.type || "text").toLowerCase();
              if (t === "checkbox") return "checkbox";
              if (t === "radio") return "radio";
              if (t === "submit" || t === "button" || t === "reset") return "button";
              return "textbox";
            }
            return IMPLICIT[el.tagName] || null;
          };
              if (${JSON.stringify(!!args.clear)}) {
            const ours = [...document.querySelectorAll("[data-ac-target]")].filter((e) => e.__acMarked);
            ours.forEach((e) => { e.removeAttribute("data-ac-target"); delete e.__acMarked; });
            return JSON.stringify({ cleared: ours.length, count: 0, total: 0, url: location.href });
          }
          let matched = [], how = null;
          if (spec.testid) {
            how = "testid";
            const q = ["data-testid", "data-test-id", "data-test", "data-qa"]
              .map((a) => "[" + a + "=" + JSON.stringify(spec.testid) + "]").join(",");
            matched = __acQA(q);
          } else if (spec.role || spec.name) {
            how = spec.role && spec.name ? "role+name" : spec.role ? "role" : "name";
            const want = spec.name == null ? null : spec.name.trim();
            matched = __acQA("*").filter((el) => {
              if (spec.role && roleOf(el) !== spec.role.toLowerCase()) return false;
              if (want == null) return true;
              const n = accName(el);
              return n === want || n.includes(want);
            });
            // 이름이 부모에도 그대로 흐르면 조상까지 다 맞는다. 가장 안쪽만 남긴다.
            matched = matched.filter((el) => !matched.some((o) => o !== el && el.contains(o)));
          } else if (spec.sel) {
            how = "css";
            matched = __acQA(spec.sel);
          } else {
            return JSON.stringify({ error: "locator가 비어 있다 — testid·role/name·sel 중 하나가 필요하다" });
          }
          const total = matched.length;
          const visible = matched.filter(vis);
          // 여럿이 맞아도 보이는 것이 하나면 그것으로 좁힌다. 숨은 템플릿·닫힌 모달이 흔하기 때문이다.
          let use = visible.length ? visible : matched;
          if (spec.nth != null) use = use[spec.nth] ? [use[spec.nth]] : [];
          const el = use.length === 1 ? use[0] : null;
          const out = {
            how, total, visibleCount: visible.length, count: use.length,
            url: location.href, title: document.title,
          };
          if (el) {
            const b = el.getBoundingClientRect();
            const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const top = document.elementFromPoint(cx, cy);
            out.tag = el.tagName.toLowerCase();
            out.role = roleOf(el);
            out.name = accName(el).slice(0, 120);
            out.visible = vis(el);
            out.inViewport = b.top < innerHeight && b.bottom > 0 && b.left < innerWidth && b.right > 0;
            // 가려짐은 "가운데 점에 있는 것이 나도 내 자손도 아니다"로 본다. 좌표 클릭이 다른
            // 요소에 떨어지는 경우가 정확히 이것이다.
            out.occluded = !!(top && top !== el && !el.contains(top) && !top.contains(el));
            out.text = (el.innerText || el.value || "").trim().slice(0, 120);
            out.disabled = !!(el.disabled || el.getAttribute("aria-disabled") === "true");
            // 확정한 그 요소를 다음 명령이 그대로 집어야 한다. 이름·역할은 선택자로 고정할 수
            // 없고, nth-child 경로로 고정하면 그 사이 화면이 다시 그려졌을 때 조용히 옆 요소를
            // 누른다. 표식을 남기면 다시 그려질 때 표식도 함께 사라져 다음 명령이 명확히
            // 실패한다. 조용히 틀리는 것보다 멈추는 것이 낫다.
            if (${JSON.stringify(!!args.mark)}) {
              // 페이지가 원래 이 속성을 쓰고 있으면 지우지 않는다. 기존 상태를 지우고 그 자리에
              // 우리 표시를 넣으면 검사 대상이 이미 우리가 바꾼 페이지가 된다.
              const foreign = [...document.querySelectorAll("[data-ac-target]")].filter((e) => !e.__acMarked);
              if (foreign.length) { out.markRefused = "페이지가 data-ac-target을 이미 쓰고 있다"; }
              else {
                document.querySelectorAll("[data-ac-target]").forEach((e) => {
                  e.removeAttribute("data-ac-target"); delete e.__acMarked;
                });
                el.setAttribute("data-ac-target", ""); el.__acMarked = true;
                out.css = "[data-ac-target]";
              }
            }
          } else if (use.length > 1) {
            out.candidates = use.slice(0, 6).map((e) => ({
              tag: e.tagName.toLowerCase(), role: roleOf(e),
              name: accName(e).slice(0, 60), visible: vis(e),
            }));
          }
          return JSON.stringify(out);
        })()`, returnByValue: true,
      });
      const vs = [];
      for (const r of rs) { try { const p = JSON.parse(r.result.value); if (p) vs.push(p); } catch {} }
      if (!vs.length) throw new Error("locator 해석 실패");
      const err = vs.find((p) => p.error);
      if (err) throw new Error(err.error);
      if (args.clear) return { ok: true, cleared: vs.reduce((a, p) => a + (p.cleared || 0), 0) };
      // 요소를 확정한 프레임의 답이 본체다. 여러 프레임이 각각 하나씩 잡았으면 그것은 확정이
      // 아니라 모호함이므로, 합계를 그대로 두어 아래 판정이 여러 개로 걸러내게 한다.
      const totalAll = vs.reduce((a, p) => a + (p.total || 0), 0);
      const countAll = vs.reduce((a, p) => a + (p.count || 0), 0);
      const visibleAll = vs.reduce((a, p) => a + (p.visibleCount || 0), 0);
      const hit = vs.find((p) => p.count === 1 && p.tag) || vs[0];
      const v = { ...hit, total: totalAll, count: countAll, visibleCount: visibleAll,
        frames: vs.length > 1 ? vs.length : undefined,
        candidates: countAll > 1 ? vs.flatMap((p) => p.candidates || []).slice(0, 6) : hit.candidates };
      // 판정은 여기서 내린다. 러너가 매번 같은 규칙을 다시 구현하면 호출 위치마다 달라진다.
      const reasons = [];
      if (v.count === 0) reasons.push(v.total ? `맞는 요소 ${v.total}개가 다 숨어 있다` : "맞는 요소가 없다");
      else if (v.count > 1) reasons.push(`${v.count}개가 맞는다 — 어느 것을 뜻하는지 정해지지 않았다`);
      else {
        if (!v.visible) reasons.push("요소가 보이지 않는다");
        if (v.occluded) reasons.push("다른 요소에 가려져 있다");
        if (v.disabled) reasons.push("요소가 비활성이다");
      }
      if (args.expectUrl && !String(v.url).includes(String(args.expectUrl)))
        reasons.push(`화면이 계획과 다르다 — 기대 "${args.expectUrl}", 실제 ${v.url}`);
      if (v.markRefused) reasons.push(v.markRefused + " — 이 페이지에서는 자국으로 지목할 수 없다");
      return { ok: true, ...v, unique: reasons.length === 0, reasons };
    },
    async text(send) {
      // 최상위 + 교차 출처 프레임까지 각각 물어서 이어 붙인다. 한 세션이 자기 안의 같은 출처
      // 프레임을 이미 훑으므로, 세션별 결과만 합치면 화면에 보이는 글이 다 들어온다.
      const rs = await send.all("Runtime.evaluate", { expression: "(function(){var d=window.__acDocs?window.__acDocs():[document],o=[];for(var i=0;i<d.length;i++){var b=d[i].body;if(b&&b.innerText)o.push(b.innerText);}return o.join('\\n');})()", returnByValue: true });
      const parts = rs.map((r) => (r && r.result && r.result.value) || "").filter((t) => t.trim());
      return { text: parts.join("\n") };
    },
    async observe(send, wc, args) {  // 닫힌 루프 QA: 현재 화면(스크린샷) + 콘솔 에러/예외 + 네트워크 실패를 한 번에 회신.
      const downloadStatus = downloadState.snapshot();
      const level = args.level || "error"; // "error" | "warn"(error+warning) | "all"
      const lim = Math.max(1, Number(args.limit) || 40);
      const seen = observation.observe(wc.id, level, lim);
      const out = {
        url: wc.getURL(), title: wc.getTitle(),
        console: seen.console,
        exceptions: seen.exceptions,
        network: seen.network,
        dialogs: seen.dialogs,
        // 잠깐 떴다 사라진 알림들. 사라진 뒤에는 화면 어디에도 없으므로 여기서 알려주지 않으면
        // 확인할 방법이 없다. 문구와 찍어 둔 장면을 함께 준다.
        moments: seen.moments,
        // 네이티브 모달이 떠 있으면 그 사실을 알려준다. 그러지 않으면 명령이 멈춘 이유를 알 수 없다.
        nativeModal: seen.fileChooser ? { kind: "file-chooser", mode: seen.fileChooser.mode }
          : (downloadStatus.pending ? { kind: "download", file: downloadStatus.pending } : null),
        downloadPlan: { dir: downloadStatus.dir, once: downloadStatus.once, last: downloadStatus.last },
        counts: seen.counts,
      };
      // 명령이 진행되지 않는 원인이 로그인일 때가 많으므로, 자동으로 채울 수 있음을 알려 준다.
      const lh = await loginHint(send);
      if (lh) out.loginHint = lh;
      const hh2 = await humanHint(send);
      if (hh2) out.humanHint = hh2;
      if (args.screenshot !== false) {
        try {
          const r = await send("Page.captureScreenshot", { format: "png" });
          const p = path.join(shotsDir, "shot-" + Date.now() + ".png");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, Buffer.from(r.data, "base64"));
          out.screenshot = p;
        } catch (e) { out.screenshotError = String((e && e.message) || e); }
      }
      if (args.clear) observation.clearDiagnostics(wc.id); // 다음 스텝 "이후 변화"만 보려면 clear
      return out;
    },
  };
}

module.exports = { createInspectCommands };
