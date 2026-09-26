// lib/http/handlers/vec.js —— M-08·vec-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { sanitizeId } = require('../../tools/misc');
const { saveVecConfig, vecModel, vecApiKey, vecCollectChunks, vecBuildIndex, vecLoadIndex, vecSearch } = require('../../vec/index');

async function h_api_vec_status(req, res, url, p) {
  // 索引状态：是否已建、条数、分类统计、建立时间、可索引块数（对比 total 判断是否需重建）
  if (p === '/api/vec/status' && req.method === 'GET') {
    const cid = sanitizeId(url.searchParams.get('chatId') || '');
    const index = vecLoadIndex(cid);
    const byKind = {};
    if (index && Array.isArray(index.items)) for (const it of index.items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      built: !!index,
      total: index ? (index.items || []).length : 0,
      byKind, at: index ? index.at : '',
      model: index ? index.model : vecModel(),
      config: {
        autoInject: !!State.vecConfig.autoInject,
        injectTopK: State.vecConfig.injectTopK,
        minScore: State.vecConfig.minScore,
        hasKey: !!vecApiKey(),
        baseURL: State.vecConfig.baseURL || '',
        model: State.vecConfig.model || '',
      },
      pending: vecCollectChunks(cid).length,
    }));
    return true;
  }
  return false;
}
async function h_api_vec_build(req, res, url, p) {
  // 建立/重建索引（全量重算）
  if (p === '/api/vec/build' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { chatId } = JSON.parse(body || '{}');
      const r = await vecBuildIndex(sanitizeId(chatId || ''));
      res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r));
    } catch (e) {
      // 明确降级：未配置 Key / 端点不可达 → 400 + 可读错误（不抛全局、不 500 崩溃）
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return true;
  }
  return false;
}
async function h_api_vec_search(req, res, url, p) {
  // 语义检索：query → topK 命中（可按 kinds 过滤 event/msg/summary）
  if (p === '/api/vec/search' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { chatId, query, topK, kinds } = JSON.parse(body || '{}');
      if (!query || !String(query).trim()) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '缺少检索内容' }));
        return true;
      }
      const r = await vecSearch(sanitizeId(chatId || ''), String(query), Number(topK) || 6, Array.isArray(kinds) ? kinds : null);
      res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return true;
  }
  return false;
}
async function h_api_vec_config(req, res, url, p) {
  // 向量配置读写（Key / 端点 / 模型 / 自动注入开关 / topK / 最低分）
  if (p === '/api/vec/config' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const u = JSON.parse(body || '{}');
      if (typeof u.apiKey === 'string') State.vecConfig.apiKey = u.apiKey.trim();
      if (typeof u.baseURL === 'string' && u.baseURL.trim()) {
        const raw = u.baseURL.trim().replace(/\/+$/, '');
        let parsed = null;
        try { parsed = new URL(raw); } catch (e) { parsed = null; }
        // 仅校验协议合法（允许本机/局域网端点：本地 embedding 服务是离线场景的主要用法，
        // 与「AI 场景插图」的 baseURL 配置口径一致）
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'embedding 端点必须是合法的 http/https 地址' }));
          return true;
        }
        State.vecConfig.baseURL = raw.slice(0, 300);
      }
      if (typeof u.model === 'string' && u.model.trim()) State.vecConfig.model = u.model.trim().slice(0, 100);
      if (typeof u.autoInject === 'boolean') State.vecConfig.autoInject = u.autoInject;
      if (Number.isFinite(u.injectTopK) && u.injectTopK >= 1 && u.injectTopK <= 12) State.vecConfig.injectTopK = Math.round(u.injectTopK);
      if (Number.isFinite(u.minScore) && u.minScore >= 0 && u.minScore <= 1) State.vecConfig.minScore = u.minScore;
      saveVecConfig();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        config: {
          autoInject: State.vecConfig.autoInject,
          injectTopK: State.vecConfig.injectTopK,
          minScore: State.vecConfig.minScore,
          baseURL: State.vecConfig.baseURL,
          model: State.vecConfig.model,
          hasKey: !!vecApiKey(),
        },
      }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return true;
  }
  return false;
}

module.exports = { h_api_vec_status, h_api_vec_build, h_api_vec_search, h_api_vec_config };
