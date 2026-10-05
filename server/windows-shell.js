// Windows 터미널 셸별 인용
import { request } from './win-native.cjs';

export function quoteWindows(value, shell) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('터미널 인자에 줄바꿈을 넣을 수 없습니다');
  if (shell === 'powershell') return `'${text.replaceAll("'", "''")}'`;
  if (shell === 'cmd') {
    if (/["%!]/.test(text)) throw new Error('cmd에서 안전하게 입력할 수 없는 경로입니다. PowerShell을 사용하세요');
    return `"${text}"`;
  }
  if (shell === 'posix') return `'${text.replaceAll("'", `'\\''`)}'`;
  throw new Error('터미널 셸을 확인하지 못했습니다');
}

export function windowsCommand(argv, cwd, shell) {
  const quote = (value) => quoteWindows(value, shell);
  const cd = cwd ? (shell === 'powershell' ? `Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop` : shell === 'cmd' ? `cd /d ${quote(cwd)}` : `cd -- ${quote(cwd)}`) : '';
  const command = argv?.length ? `${shell === 'powershell' ? '& ' : ''}${argv.map(quote).join(' ')}` : '';
  if (shell === 'powershell' && cd && command) return `try { ${cd}; ${command} } catch { Write-Error $_ }`;
  return [cd, command].filter(Boolean).join(' && ');
}

export async function commandForPane(herdr, paneId, argv, cwd) {
  const info = await herdr.call('pane.process_info', { pane_id: paneId });
  const pid = (info?.process_info || info)?.shell_pid;
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('터미널 셸 PID를 확인하지 못했습니다');
  const result = await request({ op: 'processes', pids: [pid] });
  const row = result.ok && result.processes.find((item) => item.pid === pid);
  const name = String(row?.name || row?.exe || '').split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase();
  const shell = /^(powershell|pwsh)$/.test(name) ? 'powershell' : name === 'cmd' ? 'cmd' : /^(bash|zsh|sh)$/.test(name) ? 'posix' : null;
  return windowsCommand(argv, cwd, shell);
}
