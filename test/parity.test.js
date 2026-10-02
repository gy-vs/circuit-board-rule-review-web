'use strict';

// 前端 app.js 与后端 design.js 的“规范化 JSON”必须逐字节一致，
// 否则前端用哈希判断报告新旧会误判。这里在无浏览器环境下抽取 app.js 中的
// canonicalString 源码并求值，再与后端 canonicalJSON 对比。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { canonicalJSON, hashContent, sampleDesign } = require('../backend/design');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const match = appSource.match(/function canonicalString\(value\) \{[\s\S]*?\n\}/);
assert.ok(match, '应能从 app.js 中找到 canonicalString');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${match[0]}\nthis.canonicalString = canonicalString;`, ctx);

test('前后端规范化序列化在示例板上逐字节一致', () => {
  const d = sampleDesign();
  assert.equal(ctx.canonicalString(d), canonicalJSON(d));
});

test('前后端规范化序列化在乱序键/数组情况下一致', () => {
  const cases = [
    { z: [1, 2, { y: 1, x: 2 }], a: 'n', m: null },
    [{ b: 2, a: 1 }, [], { nested: { q: true, p: false } }],
    { clearance: 0.2, board: { height: 50, width: 80 }, unit: 'mm' },
  ];
  cases.forEach((c) => assert.equal(ctx.canonicalString(c), canonicalJSON(c)));
});

test('后端内容哈希对同一示例板稳定（重开后报告可按哈希找回的前提）', () => {
  assert.equal(hashContent(sampleDesign()), hashContent(sampleDesign()));
});
