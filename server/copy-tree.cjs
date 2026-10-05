const fs = require("node:fs");
const path = require("node:path");

function copyError(code, source, destination) {
  return Object.assign(new Error(`${code}: ${source} -> ${destination}`), {
    code, path: source, dest: destination, syscall: "cp",
  });
}

function inside(source, destination) {
  const relative = path.relative(source, destination);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function destinationPath(destination) {
  try { return fs.realpathSync(destination); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(destination);
    if (parent === destination) throw error;
    return path.join(destinationPath(parent), path.basename(destination));
  }
}

// Windows 네이티브 디렉터리 복사 우회. 현재 호출부의 옵션만 지원.
function copyTreeWindowsSync(source, destination, options = {}) {
  const { recursive = false, force = true, errorOnExist = false, filter,
    dereference = false } = options;
  for (const key of Object.keys(options)) {
    if (!["recursive", "force", "errorOnExist", "filter", "dereference"].includes(key)) {
      throw new TypeError(`지원하지 않는 복사 옵션: ${key}`);
    }
  }
  if (dereference) throw new TypeError("링크 대상의 재귀 복사는 지원하지 않습니다");
  const src = path.resolve(source), dest = path.resolve(destination);

  function copy(from, to) {
    if (filter) {
      const accepted = filter(from, to);
      if (accepted && typeof accepted.then === "function") throw new TypeError("복사 필터는 동기 함수여야 합니다");
      if (!accepted) return;
    }
    const sourceStat = fs.lstatSync(from, { bigint: true });
    const destStat = fs.lstatSync(to, { bigint: true, throwIfNoEntry: false });
    if (from === to || (destStat && sourceStat.ino !== 0n && sourceStat.ino === destStat.ino && sourceStat.dev === destStat.dev)) {
      throw copyError("ERR_FS_CP_EINVAL", from, to);
    }
    if (sourceStat.isDirectory()) {
      if (!recursive) throw copyError("ERR_FS_EISDIR", from, to);
      if (inside(from, to) || inside(fs.realpathSync(from), destinationPath(to))) {
        throw copyError("ERR_FS_CP_EINVAL", from, to);
      }
      if (destStat && !destStat.isDirectory()) throw copyError("ERR_FS_CP_DIR_TO_NON_DIR", from, to);
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
      if (!destStat) fs.chmodSync(to, Number(sourceStat.mode));
      return;
    }
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) throw copyError("ERR_FS_CP_UNKNOWN", from, to);
    if (destStat?.isDirectory()) throw copyError("ERR_FS_CP_NON_DIR_TO_DIR", from, to);
    if (destStat && !force) {
      if (errorOnExist) throw copyError("ERR_FS_CP_EEXIST", from, to);
      return;
    }
    let target, linkType;
    if (sourceStat.isSymbolicLink()) {
      target = path.resolve(path.dirname(from), fs.readlinkSync(from));
      const targetStat = fs.statSync(from, { throwIfNoEntry: false });
      linkType = targetStat?.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file";
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (destStat) fs.unlinkSync(to);
    if (sourceStat.isSymbolicLink()) fs.symlinkSync(target, to, linkType);
    else {
      // 검사 뒤 생성된 대상 파일의 덮어쓰기 방지.
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, Number(sourceStat.mode));
    }
  }
  return copy(src, dest);
}

function copyTreeSync(source, destination, options) {
  if (process.platform !== "win32") return fs.cpSync(source, destination, options);
  return copyTreeWindowsSync(source, destination, options);
}

module.exports = { copyTreeSync, copyTreeWindowsSync };
