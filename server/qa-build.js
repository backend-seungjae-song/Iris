import path from "node:path";
import { execFileSync } from "node:child_process";

// 소비 코드가 다른 저장소에 있는 제품용 관련 저장소 목록. 각 경로는 git 저장소 최상위
function relatedRepos(list, repo) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("build.related: 저장소 절대 경로 목록이 필요합니다.");
  return list.map((item) => {
    if (typeof item !== "string" || !path.isAbsolute(item)) throw new Error("build.related: 저장소 절대 경로가 필요합니다.");
    const dir = path.resolve(item);
    let root;
    try { root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 }).trim(); }
    catch { throw new Error(`build.related: git 저장소가 아닙니다: ${dir}`); }
    if (path.resolve(root) !== dir) throw new Error(`build.related: 저장소 최상위 경로가 필요합니다: ${dir}`);
    return dir;
  }).filter((dir) => dir !== repo);
}

// 서버가 읽은 빌드 출처
export function captureQaBuild(build) {
  if (build == null) return undefined;
  if (!build || typeof build.repo !== "string" || !path.isAbsolute(build.repo)) throw new Error("build.repo: 저장소 절대 경로가 필요합니다.");
  const repo = path.resolve(build.repo);
  const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
  try {
    const root = git(["rev-parse", "--show-toplevel"]);
    if (path.resolve(root) !== repo) throw new Error("저장소 최상위 경로가 필요합니다.");
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const related = relatedRepos(build.related, repo).map((dir) => {
      const run = args => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
      const name = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      return { repo: dir, head: run(["rev-parse", "HEAD"]), branch: name === "HEAD" ? null : name, dirty: Boolean(run(["status", "--porcelain"])) };
    });
    return { repo, head: git(["rev-parse", "HEAD"]), branch: branch === "HEAD" ? null : branch,
      dirty: Boolean(git(["status", "--porcelain"])), at: Date.now(), ...(related.length ? { related } : {}) };
  } catch (error) { throw new Error(`QA 빌드 출처를 읽지 못했습니다: ${error.message}`); }
}
