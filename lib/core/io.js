// lib/core/io.js —— 文件读写、读取缓存与按文件键串行写队列。
// 热路径走 fs.promises 异步 + 排队，冷路径（启动加载/低频配置）保持同步。
const fs = require('fs');
const path = require('path');

function readText(file) {
  try {
    let s = fs.readFileSync(file, 'utf8');
    if ((s.match(/\uFFFD/g) || []).length > 5) {
      s = new TextDecoder('gbk').decode(fs.readFileSync(file));
    }
    return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  } catch (e) { return ''; }
}

// ---------- 变化驱动省 token（mtime+size 键缓存，未变不重读） ----------
// 同一文件（mtime+size 未变）复用读取结果，只有元数据变化才重读；
// hash 字段供 readHash() 生成 system 拼装缓存签名（规则/角色卡/世界观变化 → 签名变化 → 缓存失效）。
const readCache = new Map();   // file -> {key, hash, text}
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function readTextCached(file) {
  try {
    const st = fs.statSync(file);
    const key = file + ':' + st.mtimeMs + ':' + st.size;
    const hit = readCache.get(file);
    if (hit && hit.key === key) return hit.text;
    const text = readText(file);
    if (readCache.size > 200) {
      const first = readCache.keys().next().value;
      if (first) readCache.delete(first);
    }
    readCache.set(file, { key, hash: hashText(text), text });
    return text;
  } catch (e) { return readText(file); }
}
function readHash(file) {
  const hit = readCache.get(file);
  return hit ? hit.hash : hashText(readTextCached(file));
}
function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// ===== 分区：数据访问层（store）=====
// P-1 同步 I/O 异步化（方案 A）：热路径文件读写经此层走 fs.promises 异步 + 按文件键串行写队列；
// 冷路径（启动加载/低频配置保存）保持同步不动。MOONRABBIT_ASYNC_IO=0 → 调用点回退原同步路径（应急回退）。
const ASYNC_IO = process.env.MOONRABBIT_ASYNC_IO !== '0';
// 读 JSON：失败（不存在/损坏）返回 null，不抛
async function readJson(file) {
  try {
    const s = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(s);
  } catch (e) { return null; }
}
// 原子写 JSON：先写 .tmp 再 rename 覆盖——写中途失败/断电只留 .tmp，正式文件始终完整。
// space 参数保持各调用点原序列化格式（0 = 紧凑，2 = 缩进两格），数据文件格式零变化。
async function writeJson(file, obj, space = 0) {
  const tmp = file + '.tmp';
  const data = space ? JSON.stringify(obj, null, space) : JSON.stringify(obj);
  try {
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (e) {
    // 写失败/rename 失败时清理 .tmp 残留，避免下次原子写前积累脏文件
    try { await fs.promises.unlink(tmp); } catch (_) { /* .tmp 不存在或已清理 */ }
    throw e;
  }
}
// 原子写（同步版，2026-09-03 MINOR 修复）：多处 fs.writeFileSync 直写正式文件，
// 写到一半崩溃/断电会留下被截断的半个 JSON（下次 JSON.parse 直接失败＝配置丢失）。
// drop-in 替换：签名与 fs.writeFileSync(file, data, 'utf8') 一致，
// 内部走 .tmp + renameSync（同分区 rename 原子），失败清理 .tmp 并保留原文件完好。
function writeFileAtomicSync(file, data, enc = 'utf8') {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, data, enc);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    throw e;
  }
}
// 追加一行（行尾换行由调用方自带，保持 jsonl 逐字节格式）
async function appendLine(file, line) {
  await fs.promises.appendFile(file, line, 'utf8');
}
// 按文件键串行写队列：同键任务链式排队，前任务失败不阻塞后续；返回任务自身 Promise。
const storeQueues = new Map();   // key -> 队尾 Promise
function writeQueued(key, fn) {
  const prev = storeQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);   // 前一任务失败也继续执行下一任务
  const tail = run.then(() => {}, () => {});   // 队尾屏蔽 rejection
  storeQueues.set(key, tail);
  tail.then(() => { if (storeQueues.get(key) === tail) storeQueues.delete(key); }, () => {});   // 空闲清键
  return run;
}
// 目录元数据列表：readdir + 逐个 stat（mtime+size），供元数据缓存判重
async function listJsonMeta(dir) {
  try {
    const files = await fs.promises.readdir(dir);
    const out = [];
    for (const f of files) {
      try {
        const st = await fs.promises.stat(path.join(dir, f));
        out.push({ file: f, mtimeMs: st.mtimeMs, size: st.size });
      } catch (e) { /* 扫描中途文件消失，跳过 */ }
    }
    return out;
  } catch (e) { return []; }
}
// ===== 数据访问分区结束 =====

// Config auto-backup: rotate .bak files (keep 3) — 写配置前备份旧版，损坏/误改可回滚
function backupConfig(file) {
  try {
    if (!fs.existsSync(file)) return;
    // Rotate: bak2→bak3, bak1→bak2, current→bak1
    try { if (fs.existsSync(file + '.bak2')) fs.renameSync(file + '.bak2', file + '.bak3'); } catch (e) {}
    try { if (fs.existsSync(file + '.bak1')) fs.renameSync(file + '.bak1', file + '.bak2'); } catch (e) {}
    try { fs.copyFileSync(file, file + '.bak1'); } catch (e) {}
  } catch (e) { /* ignore */ }
}

function loadApiKey() {
  if (process.env.MOONRABBIT_API_KEY) return process.env.MOONRABBIT_API_KEY;
  return '';
}
const API_KEY = loadApiKey();
module.exports = { readText, readTextCached, readHash, safeParse, ASYNC_IO, readJson, writeJson, writeFileAtomicSync, appendLine, writeQueued, listJsonMeta, backupConfig, loadApiKey, API_KEY };
