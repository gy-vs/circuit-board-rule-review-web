'use strict';

// ---------------------------------------------------------------------------
// server.js — 本地 HTTP 服务：静态前端 + 设计/版本/检查 REST API。
// 启动：node server.js  （默认 http://localhost:5173，可用 PORT 覆盖）
// ---------------------------------------------------------------------------

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { Storage } = require('./backend/storage');

const PORT = Number(process.env.PORT || 5173);
const DATA_DIR = process.env.PCB_DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createServer(storage) {
  function sendJSON(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 20 * 1024 * 1024) {
          const err = new Error('请求体过大');
          err.statusCode = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          const err = new Error('请求体不是合法 JSON');
          err.statusCode = 400;
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  async function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/') rel = '/index.html';
    // 防目录穿越
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isDirectory()) {
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      // ---- API ----
      if (p === '/api/designs' && req.method === 'GET') {
        return sendJSON(res, 200, { designs: storage.listDesigns() });
      }

      let m = p.match(/^\/api\/designs\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const meta = await storage.getMeta(m[1]);
        return sendJSON(res, 200, { meta });
      }

      m = p.match(/^\/api\/designs\/([^/]+)\/head$/);
      if (m && req.method === 'GET') {
        const snap = await storage.getHead(m[1]);
        return sendJSON(res, 200, {
          revisionId: snap.revisionId,
          contentHash: snap.contentHash,
          parentRevisionId: snap.parentRevisionId,
          createdAt: snap.createdAt,
          design: snap.design,
        });
      }

      m = p.match(/^\/api\/designs\/([^/]+)\/revisions$/);
      if (m && req.method === 'GET') {
        const meta = await storage.getMeta(m[1]);
        return sendJSON(res, 200, { revisions: meta.revisions, headRevisionId: meta.headRevisionId });
      }

      m = p.match(/^\/api\/designs\/([^/]+)\/revisions\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const snap = await storage.getRevision(m[1], m[2]);
        return sendJSON(res, 200, {
          revisionId: snap.revisionId,
          contentHash: snap.contentHash,
          parentRevisionId: snap.parentRevisionId,
          createdAt: snap.createdAt,
          design: snap.design,
        });
      }

      m = p.match(/^\/api\/designs\/([^/]+)\/save$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || !body.design || typeof body.baseRevisionId !== 'string') {
          return sendJSON(res, 400, { error: '需要 {design, baseRevisionId}' });
        }
        const r = await storage.saveRevision(m[1], body.design, body.baseRevisionId);
        return sendJSON(res, 200, {
          unchanged: r.unchanged,
          revisionId: r.revisionId,
          contentHash: r.contentHash,
          parentRevisionId: body.baseRevisionId === r.revisionId ? null : body.baseRevisionId,
          revisions: r.meta.revisions,
          headRevisionId: r.meta.headRevisionId,
        });
      }

      m = p.match(/^\/api\/designs\/([^/]+)\/check$/);
      if (m && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.design) return sendJSON(res, 400, { error: '需要 {design}' });
        const r = await storage.check(m[1], body.design, {
          basedOnRevision: body.basedOnRevision || null,
        });
        return sendJSON(res, 200, {
          report: r.report,
          contentHash: r.contentHash,
          revisionId: r.revisionId,
          cached: r.cached,
          saved: r.saved,
        });
      }

      m = p.match(/^\/api\/designs\/([^/]+)\/reports\/([a-f0-9]+)$/);
      if (m && req.method === 'GET') {
        const report = await storage.getReport(m[1], m[2]);
        return sendJSON(res, 200, { report });
      }

      if (p.startsWith('/api/')) {
        return sendJSON(res, 404, { error: 'unknown api route' });
      }

      // ---- 静态资源 ----
      return serveStatic(req, res, p);
    } catch (err) {
      if (err.statusCode) {
        return sendJSON(res, err.statusCode, {
          error: err.message,
          ...(err.errors ? { errors: err.errors } : {}),
          ...(err.serverHead ? { serverHead: err.serverHead } : {}),
        });
      }
      // eslint-disable-next-line no-console
      console.error(err);
      return sendJSON(res, 500, { error: 'internal error' });
    }
  });

  return server;
}

if (require.main === module) {
  const storage = new Storage(DATA_DIR);
  storage.init().then(() => {
    const server = createServer(storage);
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`PCB 走线审阅工作台已启动: http://localhost:${PORT}`);
      console.log(`数据目录: ${DATA_DIR}`);
    });
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = { createServer, Storage, DATA_DIR };
