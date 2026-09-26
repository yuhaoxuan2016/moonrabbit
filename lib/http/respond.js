// lib/http/respond.js —— 请求体读取与静态文件响应。
const fs = require('fs');
const path = require('path');
const { ASYNC_IO } = require('../core/io');

const BODY_MAX_BYTES = 2 * 1024 * 1024;   // 2MB（对话历史 + system 注入的上限足够）
async function readBody(req, maxBytes = BODY_MAX_BYTES) {
  /* E-1 修复（2026-09-05）：旧版逐 chunk 隐式 toString —— 多字节字符（如汉字 UTF-8）跨
     TCP 分块边界时被截断（静默丢字，无 U+FFFD）。改为按 Buffer 累积，最后一次性解码。 */
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) {
      const err = new Error(`请求体过大（>${Math.round(maxBytes / 1024)}KB），已拒绝`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function sendFile(res, file, type) {
  const mime = type || MIME[path.extname(file)] || 'application/octet-stream';
  if (ASYNC_IO) {
    // 流式发送：大文件不再整块读入内存，事件循环不被静态资源突发读取阻塞
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
      res.writeHead(200, {
        'content-type': mime,
        'cache-control': 'no-cache, no-store, must-revalidate',
        'content-length': st.size,
      });
      const stream = fs.createReadStream(file);
      stream.on('error', () => { try { if (!res.writableEnded) res.end(); } catch (e) { /* 已关闭 */ } });
      stream.pipe(res);
    });
    return;
  }
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}
module.exports = { readBody, sendFile, MIME, BODY_MAX_BYTES };
