// lib/http/handlers/illustration.js —— M-08·illustration 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../../core/io');
const { DATA_DIR } = require('../../core/paths');
const { IMG_MODEL_PRESETS } = require('../../ext/media');
const { readBody } = require('../respond');

async function h_api_illustration_generate_48(req, res, url, p) {
  if (p === '/api/illustration/generate' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { prompt, style, chatId, sceneryOnly } = JSON.parse(body);
        if (!prompt || !String(prompt).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '缺少场景描述' })); return true; }; }
        const illustConfigFile = path.join(DATA_DIR, 'illustration-config.json');
        let config = { engine: '', apiKey: '', baseURL: '', model: '', chatModel: '' };
        try { if (fs.existsSync(illustConfigFile)) config = Object.assign({ engine: '', apiKey: '', baseURL: '', model: '', chatModel: '' }, JSON.parse(fs.readFileSync(illustConfigFile, 'utf8'))); } catch (e) {}
        const key = config.apiKey || '';
        if (!key) {
          res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：需配置
          { res.end(JSON.stringify({ error: '图片生成功能未配置。请在设置中填入图片生成 API Key，或确认本机模型配置里有可用端点。', needConfig: true })); return true; };
        }
        const baseURL = String(config.baseURL || '').replace(/\/+$/, '');
        if (!baseURL) { res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '图片生成未配置：请填「生图端点（Base URL）」。', needConfig: true })); return true; }; }
        const model = String(config.model || (IMG_MODEL_PRESETS[String(config.engine || '')] || {}).id || '').trim();
        if (!model) { res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '图片生成未配置：请填「模型 id」（示例：' + Object.keys(IMG_MODEL_PRESETS).map((k) => IMG_MODEL_PRESETS[k].id).slice(0, 2).join(' / ') + '）。', needConfig: true })); return true; }; }
        const body_s = { model, prompt: String(prompt).trim(), image_size: '1024x1024', batch_size: 1, num_inference_steps: 24, guidance_scale: 7.5 };
        // 纯场景模式：用 negative_prompt 排除人物，让图片只出场景/环境
        if (sceneryOnly) {
          body_s.negative_prompt = 'person, people, human, character, figure, portrait, man, woman, boy, girl, face, body, crowd, group, silhouette';
        }
        const r = await fetch(`${baseURL}/images/generations`, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body_s),
          signal: AbortSignal.timeout(180000),   // M-8：原无超时，上游挂起则请求永不返回、句柄泄漏
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const errMsg = (data && data.message) || (data && data.error && data.error.message) || `接口错误(${r.status})`;
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：上游失败
          { res.end(JSON.stringify({ error: errMsg, status: r.status })); return true; };
        }
        const img = (data.images && Array.isArray(data.images) && data.images[0]) || null;
        if (!img) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：上游返回异常
          { res.end(JSON.stringify({ error: '接口返回了意外的数据结构', status: 502 })); return true; };
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, image: img, model, engine: modelKey, label: modelCfg.label || model, price: modelCfg.price || '' })); return true; };
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e), status: 500 })); return true; }; }
    }
  return false;
}
async function h_api_illustration_config_49(req, res, url, p) {
  if (p === '/api/illustration/config' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { engine, apiKey, baseURL, model, chatModel } = JSON.parse(body);
        const illustConfigFile = path.join(DATA_DIR, 'illustration-config.json');
        let config = { engine: '', apiKey: '', baseURL: '', model: '', chatModel: '' };
        try { if (fs.existsSync(illustConfigFile)) config = Object.assign(config, JSON.parse(fs.readFileSync(illustConfigFile, 'utf8'))); } catch (e) {}
        if (engine) config.engine = String(engine).slice(0, 60);
        if (apiKey) config.apiKey = String(apiKey).slice(0, 200);
        if (baseURL) config.baseURL = String(baseURL).slice(0, 300);
        if (model) config.model = String(model).slice(0, 120);
        if (chatModel) config.chatModel = String(chatModel).slice(0, 120);
        writeFileAtomicSync(illustConfigFile, JSON.stringify(config, null, 2), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, config: { engine: config.engine, configured: !!config.apiKey } })); return true; };
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}
async function h_api_illustration_enhance_50(req, res, url, p) {
  if (p === '/api/illustration/enhance' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { prompt, style } = JSON.parse(body);
        if (!prompt || !String(prompt).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '缺少场景描述' })); return true; }; }
        let ic = { apiKey: '', baseURL: '', model: '', chatModel: '' };
        try { const f = path.join(DATA_DIR, 'illustration-config.json'); if (fs.existsSync(f)) ic = Object.assign(ic, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { /* 未配置 */ }
        const icBase = String(ic.baseURL || '').replace(/\/+$/, '');
        if (!icBase || !ic.apiKey) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '未配置生图端点/Key，无法优化提示词（先在「🎨 插图 → 配置」里填）', status: 503 })); return true; }; }
        const cfg = { chatUrl: /\/chat\/completions$/.test(icBase) ? icBase : icBase + '/chat/completions', key: ic.apiKey, model: String(ic.chatModel || ic.model || '').trim() };
        if (!cfg.model) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '未配置「模型 id」，无法优化提示词', status: 503 })); return true; }; }
        const styleHint = style ? `（风格：${style}）` : '';
        const sys = '你是专业 AI 绘画提示词工程师。请把用户的中文场景描述改写成一段高质量、可直接用于文生图模型的英文提示词。要求：只输出英文提示词正文，不要任何解释、编号、引号或多余文字；用逗号分隔的关键词短语，包含场景环境、光线、氛围、主体、材质/风格关键词；控制在 6-12 个短语内。';
        const callR = await fetch(cfg.chatUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
          body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: `${sys}\n\n${prompt}\n${styleHint}` }], max_tokens: 400 }),
          signal: AbortSignal.timeout(60000),
        });
        if (!callR.ok) { const t = await callR.text().catch(()=>''); res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: `LLM 调用失败: HTTP ${callR.status} ${t.slice(0,160)}`, status: callR.status })); return true; }; }   // MINOR-1：上游失败
        const dd = await callR.json().catch(() => ({}));
        const enhanced = ((dd.choices && dd.choices[0] && dd.choices[0].message && dd.choices[0].message.content) || '').trim();
        if (!enhanced) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '优化失败，返回为空', status: 502 })); return true; }; }   // MINOR-1：上游返回异常
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, enhanced })); return true; };
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e), status: 500 })); return true; }; }
    }
  return false;
}

module.exports = { h_api_illustration_generate_48, h_api_illustration_config_49, h_api_illustration_enhance_50 };
