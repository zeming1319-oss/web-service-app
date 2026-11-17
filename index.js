const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const UUID = process.env.UUID || crypto.randomUUID();
const WS_PATH = process.env.WS_PATH || '/ray';
const CORE_PORT = 10001;
const CORE_DIR = path.join(__dirname, '.core');
const CORE_BIN = path.join(CORE_DIR, 'sing-box');
const VERSION = '1.11.15';

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error('download HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function untarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  const files = {};
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    if (type === '0' || type === '\0') files[name] = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function ensureCore() {
  if (fs.existsSync(CORE_BIN)) return;
  fs.mkdirSync(CORE_DIR, { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = 'https://github.com/SagerNet/sing-box/releases/download/v' + VERSION + '/sing-box-' + VERSION + '-linux-' + arch + '.tar.gz';
  console.log('downloading core:', url);
  const buf = await download(url);
  const files = untarGz(buf);
  const key = Object.keys(files).find((k) => k.endsWith('/sing-box'));
  if (!key) throw new Error('core binary not found in archive');
  fs.writeFileSync(CORE_BIN, files[key], { mode: 0o755 });
  console.log('core ready');
}

function writeConfig() {
  const cfg = {
    log: { level: 'warn' },
    inbounds: [{
      type: 'vless',
      tag: 'in',
      listen: '127.0.0.1',
      listen_port: CORE_PORT,
      users: [{ uuid: UUID }],
      transport: { type: 'ws', path: WS_PATH }
    }],
    outbounds: [{ type: 'direct', tag: 'out' }]
  };
  const p = path.join(CORE_DIR, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

let coreProc = null;
function startCore(cfgPath) {
  coreProc = spawn(CORE_BIN, ['run', '-c', cfgPath], { stdio: 'inherit' });
  coreProc.on('exit', (code) => {
    console.log('core exited', code, '- restarting in 3s');
    setTimeout(() => startCore(cfgPath), 3000);
  });
}

const PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Welcome</title></head>' +
  '<body style="font-family:sans-serif;margin:40px"><h1>Welcome</h1><p>This site is under construction.</p></body></html>';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== WS_PATH) { socket.destroy(); return; }
  const upstream = net.connect(CORE_PORT, '127.0.0.1', () => {
    let raw = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

(async () => {
  try {
    await ensureCore();
    const cfgPath = writeConfig();
    startCore(cfgPath);
    server.listen(PORT, '0.0.0.0', () => console.log('web listening on', PORT, 'ws path', WS_PATH, 'uuid', UUID));
  } catch (e) {
    console.error('fatal', e);
    process.exit(1);
  }
})();

process.on('SIGTERM', () => { try { coreProc && coreProc.kill(); } catch (_) {} process.exit(0); });
