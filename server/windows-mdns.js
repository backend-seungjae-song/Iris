// 로컬 Dart VM 서비스의 제한된 mDNS 조회
import dgram from 'node:dgram';
import os from 'node:os';

const SERVICE = '_dartVmService._tcp.local';
function dnsName(bytes, offset, seen = new Set()) {
  if (seen.has(offset) || seen.size > 32) throw new Error('DNS pointer loop');
  seen.add(offset);
  const labels = []; let end;
  while (offset < bytes.length) {
    const size = bytes[offset++];
    if (!size) return { name: labels.join('.'), end: end ?? offset };
    if ((size & 0xc0) === 0xc0) {
      if (offset >= bytes.length) throw new Error('DNS pointer truncated');
      const target = ((size & 0x3f) << 8) | bytes[offset++];
      labels.push(dnsName(bytes, target, seen).name);
      return { name: labels.join('.'), end: end ?? offset };
    }
    if (size > 63 || offset + size > bytes.length) throw new Error('DNS name truncated');
    labels.push(bytes.subarray(offset, offset + size).toString('utf8')); offset += size;
  }
  throw new Error('DNS name missing terminator');
}

export function mdnsRecords(bytes) {
  if (bytes.length < 12 || !(bytes.readUInt16BE(2) & 0x8000)) return [];
  const count = bytes.readUInt16BE(6) + bytes.readUInt16BE(8) + bytes.readUInt16BE(10);
  if (count > 512 || bytes.readUInt16BE(4) > 128) throw new Error('DNS record limit');
  let offset = 12;
  for (let i = 0; i < bytes.readUInt16BE(4); i++) offset = dnsName(bytes, offset).end + 4;
  const records = [];
  for (let i = 0; i < count; i++) {
    const owner = dnsName(bytes, offset); offset = owner.end;
    if (offset + 10 > bytes.length) throw new Error('DNS header truncated');
    const type = bytes.readUInt16BE(offset), ttl = bytes.readUInt32BE(offset + 4), size = bytes.readUInt16BE(offset + 8);
    offset += 10; const end = offset + size;
    if (end > bytes.length) throw new Error('DNS data truncated');
    const record = { name: owner.name, type, ttl };
    if (type === 12) record.target = dnsName(bytes, offset).name;
    if (type === 33 && size >= 7) { record.port = bytes.readUInt16BE(offset + 4); record.host = dnsName(bytes, offset + 6).name; }
    if (type === 16) {
      record.text = [];
      while (offset < end) { const length = bytes[offset++]; if (offset + length > end) throw new Error('DNS TXT truncated'); record.text.push(bytes.subarray(offset, offset + length).toString('utf8')); offset += length; }
    }
    records.push(record); offset = end;
  }
  return records;
}

function question(name, type) {
  const labels = name.split('.').map((label) => { const b = Buffer.from(label); if (!b.length || b.length > 63) throw new Error('DNS label limit'); return Buffer.concat([Buffer.from([b.length]), b]); });
  const header = Buffer.alloc(12); header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5); tail.writeUInt16BE(type, 1); tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

export function discoverWindowsMdns(timeout = 1500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const local = new Set(['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map((row) => row.address)]);
    const names = new Map(), srv = new Map(), txt = new Map();
    let done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); try { socket.close(); } catch {}
      resolve([...names].flatMap(([key, name]) => {
        const port = srv.get(key)?.port, token = txt.get(key)?.find((text) => text.startsWith('authCode='))?.slice(9);
        return port > 0 && /^[A-Za-z0-9_+=-]+$/.test(token || '') ? [{ port, token, label: name.slice(0, -SERVICE.length - 1) }] : [];
      }));
    };
    const timer = setTimeout(finish, timeout);
    const send = (name, type) => { if (!done) socket.send(question(name, type), 5353, '224.0.0.251', () => {}); };
    socket.on('error', finish);
    socket.on('message', (bytes, peer) => {
      if (!local.has(peer.address) || peer.port !== 5353) return;
      try {
        for (const record of mdnsRecords(bytes)) {
          if (!record.ttl) continue;
          const key = record.name.toLowerCase();
          if (record.type === 12 && key === SERVICE.toLowerCase() && record.target?.toLowerCase().endsWith(`.${SERVICE.toLowerCase()}`)) {
            const target = record.target.toLowerCase();
            if (!names.has(target) && names.size < 128) { names.set(target, record.target); send(record.target, 33); send(record.target, 16); }
          }
          if (record.type === 33 && srv.size < 256) srv.set(key, record);
          if (record.type === 16 && txt.size < 256) txt.set(key, record.text);
        }
      } catch {}
    });
    socket.bind(0, '0.0.0.0', () => { socket.setMulticastTTL(255); send(SERVICE, 12); });
  });
}
