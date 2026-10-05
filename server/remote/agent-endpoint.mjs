// Windows 로컬 연결 정보
import fs from 'node:fs';
import net from 'node:net';

export function connectAgent(socketPath) {
  if (process.platform !== 'win32') return { socket: net.createConnection(socketPath), auth: {} };
  const value = JSON.parse(fs.readFileSync(socketPath, 'utf8'));
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) {
    throw new Error('invalid local agent endpoint');
  }
  return { socket: net.createConnection({ host: '127.0.0.1', port: value.port }), auth: { token: value.token } };
}
