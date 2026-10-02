'use strict';

// ---------------------------------------------------------------------------
// storage.js — 文件持久化：设计、不可变版本快照、检查报告。
//
// <dataDir>/
//   index.json                         { designs: [{id,name,headRevisionId,updatedAt}] }
//   <designId>/
//     meta.json                        { id, name, headRevisionId, createdAt, updatedAt }
//     revisions/<revisionId>.json      保存时写入的不可变快照
//     reports/<contentHash>.json       检查报告（按内容哈希索引，保存/检查共用）
//   _cache/reports/<designId>/<hash>.json  尚未保存内容的临时检查报告
//
// 并发：保存采用乐观锁。客户端必须携带它所基于的已保存版本 baseRevisionId；
// 若服务端 head 已前进则返回 409，不覆盖他人改动。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;

const { sampleDesign, validateDesign, hashContent, revisionIdFor } = require('./design');
const { runCheck } = require('./check');

async function atomicWriteJSON(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

class Storage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.indexFile = path.join(dataDir, 'index.json');
    this.cacheDir = path.join(dataDir, '_cache', 'reports');
  }

  async init({ seed = true } = {}) {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.cacheDir, { recursive: true });
    this.index = await readJSON(this.indexFile, { designs: [] });
    if (seed && this.index.designs.length === 0) {
      await this.createDesign('demo', sampleDesign(), { seed: true });
    }
    return this.index;
  }

  _designDir(id) { return path.join(this.dataDir, id); }

  _metaFile(id) { return path.join(this._designDir(id), 'meta.json'); }

  _revisionFile(id, rev) { return path.join(this._designDir(id), 'revisions', `${rev}.json`); }

  _reportFile(id, hash) { return path.join(this._designDir(id), 'reports', `${hash.slice(0, 24)}.json`); }

  _cacheReportFile(id, hash) { return path.join(this.cacheDir, id, `${hash.slice(0, 24)}.json`); }

  listDesigns() {
    return this.index.designs.map((d) => ({ ...d }));
  }

  async _saveIndex() {
    await atomicWriteJSON(this.indexFile, this.index);
  }

  async createDesign(id, design, { seed = false } = {}) {
    const validation = validateDesign(design);
    if (!validation.valid) {
      const err = new Error('设计不完整');
      err.statusCode = 422;
      err.errors = validation.errors;
      throw err;
    }
    if (this.index.designs.some((d) => d.id === id)) {
      const err = new Error(`设计 ${id} 已存在`);
      err.statusCode = 409;
      throw err;
    }
    const contentHash = hashContent(design);
    const revisionId = revisionIdFor(design);
    const now = new Date().toISOString();
    const snapshot = {
      revisionId,
      contentHash,
      designId: id,
      parentRevisionId: null,
      createdAt: now,
      seed,
      design,
    };
    await atomicWriteJSON(this._revisionFile(id, revisionId), snapshot);
    const meta = {
      id,
      name: design.name || id,
      headRevisionId: revisionId,
      seedRevisionId: revisionId,
      createdAt: now,
      updatedAt: now,
      revisions: [{ revisionId, contentHash, createdAt: now, seed }],
    };
    await atomicWriteJSON(this._metaFile(id), meta);
    this.index.designs.push({ id, name: meta.name, headRevisionId: revisionId, updatedAt: now });
    await this._saveIndex();
    return { meta, snapshot };
  }

  async getMeta(id) {
    const meta = await readJSON(this._metaFile(id), null);
    if (!meta) {
      const err = new Error(`设计 ${id} 不存在`);
      err.statusCode = 404;
      throw err;
    }
    return meta;
  }

  async getHead(id) {
    const meta = await this.getMeta(id);
    return this.getRevision(id, meta.headRevisionId);
  }

  async getRevision(id, revisionId) {
    await this.getMeta(id); // 存在性
    const snap = await readJSON(this._revisionFile(id, revisionId), null);
    if (!snap) {
      const err = new Error(`版本 ${revisionId} 不存在`);
      err.statusCode = 404;
      throw err;
    }
    return snap;
  }

  // 乐观保存：baseRevisionId 必须等于当前 head，否则 409。
  async saveRevision(id, design, baseRevisionId) {
    const meta = await this.getMeta(id);
    if (baseRevisionId !== meta.headRevisionId) {
      const err = new Error('版本冲突：另一个会话已经保存了新版本');
      err.statusCode = 409;
      err.serverHead = meta.headRevisionId;
      err.baseRevisionId = baseRevisionId;
      throw err;
    }
    const validation = validateDesign(design);
    if (!validation.valid) {
      const err = new Error('设计不完整，未保存');
      err.statusCode = 422;
      err.errors = validation.errors;
      throw err;
    }
    const contentHash = hashContent(design);
    const revisionId = revisionIdFor(design);

    // 相同内容重复保存是幂等的（不制造新版次）
    if (revisionId === meta.headRevisionId) {
      return {
        unchanged: true,
        revisionId,
        contentHash,
        meta: await this.getMeta(id),
        snapshot: await this.getRevision(id, revisionId),
      };
    }

    const now = new Date().toISOString();
    const snapshot = {
      revisionId,
      contentHash,
      designId: id,
      parentRevisionId: meta.headRevisionId,
      createdAt: now,
      seed: false,
      design,
    };
    await atomicWriteJSON(this._revisionFile(id, revisionId), snapshot);
    meta.headRevisionId = revisionId;
    meta.updatedAt = now;
    meta.revisions.unshift({ revisionId, contentHash, createdAt: now, seed: false });
    await atomicWriteJSON(this._metaFile(id), meta);

    const entry = this.index.designs.find((d) => d.id === id);
    entry.headRevisionId = revisionId;
    entry.name = design.name || entry.name;
    entry.updatedAt = now;
    await this._saveIndex();

    // 若该内容之前在临时缓存里检查过，把报告提升为持久报告
    const cached = await readJSON(this._cacheReportFile(id, contentHash), null);
    if (cached) {
      await atomicWriteJSON(this._reportFile(id, contentHash), cached);
      await fsp.unlink(this._cacheReportFile(id, contentHash)).catch(() => {});
    }

    return { unchanged: false, revisionId, contentHash, meta, snapshot };
  }

  // 检查任意（可能尚未保存的）内容。报告按内容哈希缓存，绝不与其他版本混淆。
  async check(id, design, { basedOnRevision = null } = {}) {
    await this.getMeta(id);
    const validation = validateDesign(design);
    if (!validation.valid) {
      const err = new Error('设计不完整，无法检查');
      err.statusCode = 422;
      err.errors = validation.errors;
      throw err;
    }
    const contentHash = hashContent(design);
    const revisionId = revisionIdFor(design);

    const existing = await this.getStoredReport(id, contentHash);
    if (existing) {
      return { report: existing, contentHash, revisionId, cached: true, saved: !!existing.saved };
    }

    const result = runCheck(design, { revisionId, contentHash, basedOnRevision });
    if (!result.ok) {
      const err = new Error('设计不完整，无法检查');
      err.statusCode = 422;
      err.errors = result.errors;
      throw err;
    }
    const report = result.report;
    report.checkedAt = new Date().toISOString();

    const isSaved = await readJSON(this._revisionFile(id, revisionId), null).then(Boolean);
    report.saved = isSaved;
    if (isSaved) {
      await atomicWriteJSON(this._reportFile(id, contentHash), report);
    } else {
      await atomicWriteJSON(this._cacheReportFile(id, contentHash), report);
    }
    return { report, contentHash, revisionId, cached: false, saved: isSaved };
  }

  async getStoredReport(id, contentHash) {
    const persisted = await readJSON(this._reportFile(id, contentHash), null);
    if (persisted) return persisted;
    return readJSON(this._cacheReportFile(id, contentHash), null);
  }

  // 按哈希读取报告：可能指向已保存版本，也可能是临时缓存。
  async getReport(id, contentHash) {
    await this.getMeta(id);
    const report = await this.getStoredReport(id, contentHash);
    if (!report) {
      const err = new Error(`没有内容哈希为 ${contentHash.slice(0, 12)} 的检查报告，请先运行检查`);
      err.statusCode = 404;
      throw err;
    }
    return report;
  }
}

module.exports = { Storage, atomicWriteJSON, readJSON };
