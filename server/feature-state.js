import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateHome } from "./state-home.cjs";
import { readFeatureState, FEATURE_ID } from "./feature-state-read.cjs";

// 비교와 rename 사이에 await를 두지 않는다. 상태 폴더 잠금을 가진 서버만 쓴다.
export function handleFeatureState(req, res, local) {
  const reply = (code, value) => res.writeHead(code, {
    "content-type": "application/json", "cache-control": "no-store",
  }).end(JSON.stringify(value));
  const current = () => ({ ...readFeatureState(), local });
  if (req.method === "GET") { reply(200, current()); return; }
  if (req.method !== "PUT") { reply(405, { error: "method not allowed" }); return; }
  if (!local) { reply(403, { error: "local only" }); return; }
  let body = "";
  req.on("data", (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => {
    let input;
    try { input = JSON.parse(body); } catch { reply(400, { error: "bad json" }); return; }
    if (!input || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0
      || !Array.isArray(input.hidden) || input.hidden.length > 1000
      || input.hidden.some((id) => typeof id !== "string" || !FEATURE_ID.test(id))
      || (input.shown !== undefined && (!Array.isArray(input.shown) || input.shown.length > 1000
        || input.shown.some((id) => typeof id !== "string" || !FEATURE_ID.test(id))))) {
      reply(400, { error: "invalid feature state" }); return;
    }
    const before = current();
    if (input.baseRevision !== before.revision) { reply(409, before); return; }
    // shown 을 보내지 않는 요청(옛 설정 옮기기)은 사용자가 켠 기본 꺼짐 기능을 지우지 않는다.
    const shown = [...new Set(input.shown === undefined ? before.shown : input.shown)];
    const value = { version: 1, revision: before.revision + 1, hidden: [...new Set(input.hidden)], shown };
    const home = stateHome();
    const temp = path.join(home, `features.${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, path.join(home, "features.json"));
      reply(200, { exists: true, revision: value.revision, hidden: value.hidden, shown: value.shown, local });
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      reply(500, { error: "feature state write failed" });
    }
  });
}
