const path = require('node:path');

// PowerShell 7에서 상속된 모듈 경로 제외
function windowsPowerShellEnv(source = process.env) {
  const env = { ...source };
  const rootKey = Object.keys(env).find((key) => key.toLowerCase() === 'systemroot');
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  env.PSModulePath = path.win32.join(env[rootKey] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}

module.exports = { windowsPowerShellEnv };
