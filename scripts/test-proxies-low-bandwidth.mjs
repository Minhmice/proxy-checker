import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import '../src/server/load-env.js';
import { testPool } from '../src/server/nine-router-client.js';

const TIMEOUT_MS = 4500;
const CONCURRENCY = 2; // Strict bandwidth preservation
const DELAY_BETWEEN_CHECKS_MS = 200;
const DB_PATH = path.resolve('data/proxies.sqlite3');
const POOL_STATE_PATH = path.resolve('data/pool-state.json');

// --- Protocol Testers (Zero Dependencies, <1KB Bandwidth Per Check) ---

function parseProxyUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    const host = parsed.hostname;
    const port = Number(parsed.port) || (protocol === 'https' ? 443 : 80);
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    return { protocol, host, port, username, password, valid: Boolean(host && port) };
  } catch {
    return { valid: false };
  }
}

function testSocks5(host, port, username, password, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeout);

    let step = 0;

    sock.on('connect', () => {
      if (username) {
        sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });

    sock.on('data', (data) => {
      try {
        if (step === 0) {
          if (data[0] !== 0x05) {
            sock.destroy();
            return resolve({ ok: false, latency: Date.now() - start, error: 'Not SOCKS5' });
          }
          const method = data[1];
          if (method === 0x00) {
            sendConnect();
          } else if (method === 0x02) {
            step = 1;
            const uBuf = Buffer.from(username || '');
            const pBuf = Buffer.from(password || '');
            const authBuf = Buffer.concat([
              Buffer.from([0x01, uBuf.length]),
              uBuf,
              Buffer.from([pBuf.length]),
              pBuf
            ]);
            sock.write(authBuf);
          } else {
            sock.destroy();
            return resolve({ ok: false, latency: Date.now() - start, error: `Unsupported auth (0x${method.toString(16)})` });
          }
        } else if (step === 1) {
          if (data[1] !== 0x00) {
            sock.destroy();
            return resolve({ ok: false, latency: Date.now() - start, error: 'Auth failed' });
          }
          sendConnect();
        } else if (step === 2) {
          if (data[1] !== 0x00) {
            sock.destroy();
            return resolve({ ok: false, latency: Date.now() - start, error: `Connect code 0x${data[1].toString(16)}` });
          }
          step = 3;
          sock.write(Buffer.from('HEAD / HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n'));
        } else if (step === 3) {
          const text = data.toString('utf-8');
          const latency = Date.now() - start;
          sock.destroy();
          resolve({ ok: true, latency, info: text.split('\r\n')[0] || 'OK' });
        }
      } catch (err) {
        sock.destroy();
        resolve({ ok: false, latency: Date.now() - start, error: err.message });
      }
    });

    function sendConnect() {
      step = 2;
      // 1.1.1.1:80
      sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x00, 80]));
    }

    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, latency: timeout, error: 'Timeout' }); });
    sock.on('error', (err) => { resolve({ ok: false, latency: Date.now() - start, error: err.message }); });
  });
}

function testHttp(host, port, username, password, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeout);

    sock.on('connect', () => {
      let req = 'GET http://1.1.1.1/ HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n';
      if (username) {
        const creds = Buffer.from(`${username}:${password || ''}`).toString('base64');
        req += `Proxy-Authorization: Basic ${creds}\r\n`;
      }
      req += '\r\n';
      sock.write(req);
    });

    sock.on('data', (data) => {
      const text = data.toString('utf-8');
      const latency = Date.now() - start;
      sock.destroy();
      const firstLine = text.split('\r\n')[0] || '';
      if (firstLine.includes('HTTP/1.')) {
        const code = parseInt(firstLine.split(' ')[1] || '0', 10);
        const ok = (code >= 200 && code < 400) || code === 405 || code === 301 || code === 302;
        resolve({ ok, latency, info: firstLine });
      } else {
        resolve({ ok: false, latency, error: 'Non-HTTP response' });
      }
    });

    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, latency: timeout, error: 'Timeout' }); });
    sock.on('error', (err) => { resolve({ ok: false, latency: Date.now() - start, error: err.message }); });
  });
}

async function checkProxy(item) {
  // If linked to 9Router, use 9Router's testPool as primary or fallback
  if (item.remoteId) {
    try {
      const res = await testPool(item.remoteId);
      if (res.ok) {
        return { ok: true, latency: res.elapsedMs || 0, info: '9Router OK' };
      }
    } catch {
      // Fall through to direct socket check
    }
  }

  const parsed = parseProxyUrl(item.url);
  if (!parsed.valid) {
    return { ok: false, latency: 0, error: 'Invalid proxy format' };
  }

  if (parsed.protocol.includes('socks')) {
    return testSocks5(parsed.host, parsed.port, parsed.username, parsed.password);
  } else {
    return testHttp(parsed.host, parsed.port, parsed.username, parsed.password);
  }
}

// --- Main Collector & Worker ---

async function main() {
  console.log('>>> Thu thập toàn bộ proxies từ pool-state.json và SQLite...');

  const proxyMap = new Map();

  // 1. From pool-state.json
  if (fs.existsSync(POOL_STATE_PATH)) {
    try {
      const poolState = JSON.parse(fs.readFileSync(POOL_STATE_PATH, 'utf-8'));
      for (const p of Object.values(poolState.pools || {})) {
        if (p.proxyUrl) {
          proxyMap.set(p.proxyUrl, {
            url: p.proxyUrl,
            name: p.name || '',
            tier: p.tier || 'unknown',
            remoteId: p.remoteId || null,
            localId: p.localId || null,
            source: 'pool-state',
          });
        }
      }
    } catch (e) {
      console.warn('Cảnh báo đọc pool-state:', e.message);
    }
  }

  // 2. From SQLite (source = '9router-working' or remote_id IS NOT NULL)
  let db = null;
  if (fs.existsSync(DB_PATH)) {
    try {
      db = new Database(DB_PATH, { readonly: true });
      const rows = db.prepare(`
        SELECT proxy_key, endpoint, protocol, host, port, username, password, remote_id, status 
        FROM proxies 
        WHERE source = '9router-working' OR remote_id IS NOT NULL OR status = 'usable'
      `).all();
      for (const r of rows) {
        let url = r.proxy_key;
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('socks5://') && !url.startsWith('socks4://')) {
          const proto = r.protocol || 'http';
          const auth = r.username && r.password ? `${encodeURIComponent(r.username)}:${encodeURIComponent(r.password)}@` : '';
          url = `${proto}://${auth}${r.endpoint}`;
        }
        if (!proxyMap.has(url)) {
          proxyMap.set(url, {
            url,
            name: r.endpoint,
            tier: 'sqlite',
            remoteId: r.remote_id || null,
            localId: null,
            source: 'sqlite',
          });
        }
      }
    } catch (e) {
      console.warn('Cảnh báo đọc sqlite:', e.message);
    } finally {
      if (db) db.close();
    }
  }

  const items = Array.from(proxyMap.values());
  console.log(`>>> Tìm thấy ${items.length} proxies độc nhất trong pool/working.`);
  console.log(`>>> Chạy kiểm tra với Concurrency = ${CONCURRENCY}, Timeout = ${TIMEOUT_MS}ms, Delay = ${DELAY_BETWEEN_CHECKS_MS}ms...`);

  let currentIndex = 0;
  const aliveList = [];
  const deadList = [];

  async function worker(workerId) {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      const item = items[idx];
      
      const res = await checkProxy(item);
      const latencyStr = res.latency ? `${res.latency}ms` : '0ms';

      if (res.ok) {
        aliveList.push({ ...item, latency: res.latency, info: res.info });
        console.log(`[${idx + 1}/${items.length}] \x1b[32mSỐNG\x1b[0m ${item.url} (${latencyStr})`);
      } else {
        deadList.push({ ...item, latency: res.latency, error: res.error });
        console.log(`[${idx + 1}/${items.length}] \x1b[31mCHẾT\x1b[0m ${item.url} (${res.error || 'FAIL'})`);
      }

      // Rest interval to save network bandwidth
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_CHECKS_MS));
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  // Update SQLite DB for matching entries
  if (db) {
    try {
      const updateStmt = db.prepare(`
        UPDATE proxies 
        SET status = ?, lifecycle_state = ?, latency_ms = ?, last_checked_at = ?, last_error = ?
        WHERE proxy_key = ? OR endpoint = ?
      `);

      for (const a of aliveList) {
        const parsed = parseProxyUrl(a.url);
        const ep = `${parsed.host}:${parsed.port}`;
        updateStmt.run('usable', 'working', a.latency, Date.now(), null, a.url, ep);
      }
      for (const d of deadList) {
        const parsed = parseProxyUrl(d.url);
        const ep = `${parsed.host}:${parsed.port}`;
        updateStmt.run('dead', 'dead', d.latency, Date.now(), d.error || 'Failed', d.url, ep);
      }
      console.log('>>> Đã cập nhật trạng thái vào SQLite proxies.sqlite3.');
    } catch (e) {
      console.warn('Lỗi ghi SQLite:', e.message);
    }
  }

  // Save report artifact
  const report = {
    generatedAt: new Date().toISOString(),
    total: items.length,
    aliveCount: aliveList.length,
    deadCount: deadList.length,
    alive: aliveList,
    dead: deadList
  };

  fs.writeFileSync('data/test-results-latest.json', JSON.stringify(report, null, 2));
  console.log(`>>> Báo cáo đã lưu tại data/test-results-latest.json`);
  console.log(`\n================== KẾT QUẢ KIỂM TRA ==================`);
  console.log(`Tổng proxies: ${items.length} | SỐNG: ${aliveList.length} | CHẾT: ${deadList.length}`);
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
