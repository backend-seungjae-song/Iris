// Windows 원격 상태 접근 제한
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { windowsPowerShellEnv } = require('../windows-powershell.cjs');

function privateCommand(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('remote state symlink rejected');
  const source = `$ErrorActionPreference='Stop'; $p=$env:IRIS_PRIVATE_PATH; $item=Get-Item -LiteralPath $p -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse point rejected' }; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=if($item.PSIsContainer){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=if($item.PSIsContainer){New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')}; $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`;
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    env: { ...windowsPowerShellEnv(), IRIS_PRIVATE_PATH: file }, windowsHide: true, timeout: 15000, stdio: 'pipe',
  }];
}

// 종료 시 동기 저장용 ACL 적용
function privatePath(file) {
  if (process.platform !== 'win32') return;
  execFileSync(...privateCommand(file));
}

// 초기화·저장 중 서버 응답 유지
async function privatePathAsync(file) {
  if (process.platform !== 'win32') return;
  const command = privateCommand(file);
  await new Promise((resolve, reject) => {
    execFile(...command, (error) => error ? reject(error) : resolve());
  });
}
module.exports = { privatePath, privatePathAsync };
