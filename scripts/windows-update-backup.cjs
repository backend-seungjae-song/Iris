const fs = require('node:fs');
const path = require('node:path');

const markerName = '.iris-update-processes.json';

function validateBackup(directory, backup) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(backup)) throw new Error('백업 절대 경로 필요');
  const installed = path.resolve(directory);
  const target = path.resolve(backup);
  const prefix = path.basename(installed) + '.old-';
  const name = path.basename(target);
  if (path.dirname(installed) !== path.dirname(target) || !name.startsWith(prefix)
    || !/^[a-f0-9]{32}$/.test(name.slice(prefix.length))) throw new Error('설치 폴더 형제의 .old 백업만 정리 가능');
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('백업의 링크·junction 정리 금지');
    if (current === target && !stat.isDirectory()) throw new Error('백업 폴더 필요');
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
    }
  }
  return target;
}

function backupInUse(backup, previousProcesses, processes) {
  const prefix = backup.replaceAll('/', '\\').toLowerCase() + '\\';
  return processes.some((current) => {
    const executable = String(current.ExecutablePath || '').replaceAll('/', '\\').toLowerCase();
    const command = String(current.CommandLine || '').replaceAll('/', '\\').toLowerCase();
    if (executable.startsWith(prefix) || command.includes(prefix)) return true;
    return previousProcesses.some((previous) => Number(previous.ProcessId) === Number(current.ProcessId)
      && (!previous.CreationDate || !current.CreationDate || previous.CreationDate === current.CreationDate));
  });
}

// 준비 확인을 마친 설치본의 이전 폴더만 정리
function cleanupBackups(directory, backup, previousProcesses, processes) {
  if (!path.isAbsolute(directory)) throw new Error('설치 폴더 절대 경로 필요');
  if (!Array.isArray(previousProcesses) || !Array.isArray(processes)) throw new Error('프로세스 목록 확인 실패');
  const installed = path.resolve(directory);
  if (backup) {
    const target = validateBackup(directory, backup);
    fs.writeFileSync(path.join(target, markerName), JSON.stringify({ directory: installed, processes: previousProcesses }));
  }
  const results = [];
  for (const name of fs.readdirSync(path.dirname(installed))) {
    if (!name.startsWith(path.basename(installed) + '.old-')) continue;
    const candidate = path.join(path.dirname(installed), name);
    try {
      const target = validateBackup(directory, candidate);
      const marker = JSON.parse(fs.readFileSync(path.join(target, markerName), 'utf8'));
      if (marker.directory !== installed || !Array.isArray(marker.processes)) throw new Error('백업 소유 기록 불일치');
      if (backupInUse(target, marker.processes, processes)) {
        results.push({ path: target, status: 'in-use' });
        continue;
      }
      fs.rmSync(target, { recursive: true });
      results.push({ path: target, status: 'removed' });
    } catch (error) { results.push({ path: candidate, status: 'retained', reason: error.message }); }
  }
  return results;
}

module.exports = { validateBackup, backupInUse, cleanupBackups };

if (require.main === module) {
  try {
    if (process.platform !== 'win32') throw new Error('Windows 전용 백업 정리');
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    console.log(JSON.stringify(cleanupBackups(process.argv[2], process.argv[3] || null, input.previousProcesses, input.processes)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
