// lib/http/handlers/tts.js —— M-08·tts 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../../core/io');
const { DATA_DIR } = require('../../core/paths');
const { MIMO_TTS_MODEL, defaultTtsConfig } = require('../../ext/media');
const { readBody } = require('../respond');
const { loadAnnotations, saveAnnotations } = require('../../store/annotations');
const { sanitizeId } = require('../../tools/misc');

async function h_api_tts_config_51(req, res, url, p) {
  if (p === '/api/tts/config' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { engine, apiKey, voice, rate, baseURL, model } = JSON.parse(body);
        const ttsConfigFile = path.join(DATA_DIR, 'tts-config.json');
        let config = defaultTtsConfig();
        try { if (fs.existsSync(ttsConfigFile)) config = JSON.parse(fs.readFileSync(ttsConfigFile, 'utf8')); } catch (e) {}
        if (engine) config.engine = String(engine).slice(0, 20);
        if (apiKey) config.apiKey = String(apiKey).slice(0, 200);
        if (voice) config.voice = String(voice).slice(0, 50);
        if (rate) config.rate = String(rate).slice(0, 10);
        if (baseURL) config.baseURL = String(baseURL).slice(0, 300);
        if (model) config.model = String(model).slice(0, 60);
        writeFileAtomicSync(ttsConfigFile, JSON.stringify(config, null, 2), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, config: { engine: config.engine, voice: config.voice, rate: config.rate, configured: config.engine !== 'none' } })); return true; };
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}
async function h_api_tts_config_52(req, res, url, p) {
  if (p === '/api/tts/config' && req.method === 'GET') {
      const ttsConfigFile = path.join(DATA_DIR, 'tts-config.json');
      let config = defaultTtsConfig();
      try { if (fs.existsSync(ttsConfigFile)) config = JSON.parse(fs.readFileSync(ttsConfigFile, 'utf8')); } catch (e) {}
      // 2026-09-03：角色音色下拉原为硬编码角色名，改为回传用户自建映射的键
      let characters = [];
      try {
        const cvf = path.join(DATA_DIR, 'character-voices.json');
        if (fs.existsSync(cvf)) {
          const cv = JSON.parse(fs.readFileSync(cvf, 'utf8'));
          const map = cv && cv['角色音色映射'];
          if (map && typeof map === 'object') characters = Object.keys(map).slice(0, 100);
        }
      } catch (e) { console.error('[TTS] 角色音色映射读取失败:', e.message); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ ok: true, characters, config: { engine: config.engine, voice: config.voice, rate: config.rate, configured: config.engine !== 'none' } })); return true; };
    }
  return false;
}
async function h_api_tts_synthesize_53(req, res, url, p) {
  if (p === '/api/tts/synthesize' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { text, voice, rate, model, style, referenceAudio, character } = JSON.parse(body);
        if (!text || !String(text).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '缺少文本' })); return true; }; }
        const ttsConfigFile = path.join(DATA_DIR, 'tts-config.json');
        let config = defaultTtsConfig();
        try { if (fs.existsSync(ttsConfigFile)) config = JSON.parse(fs.readFileSync(ttsConfigFile, 'utf8')); } catch (e) {}
        const useVoice = voice || config.voice || 'mimo_default';
        const useRate = rate || config.rate || '1.0';
        
        // 角色绑定：如果指定了角色，从 character-voices.json 读取对应的参考音频和语音提示词
        let characterRefAudio = null;
        let characterModel = null;
        let characterStyle = null;
        if (character && !referenceAudio) {
          try {
            const charVoiceFile = path.join(DATA_DIR, 'character-voices.json');
            if (fs.existsSync(charVoiceFile)) {
              const charVoices = JSON.parse(fs.readFileSync(charVoiceFile, 'utf8'));
            // 修复：原为 charVoices['角色音色映射'][character]，缺 map 时抛 TypeError 被空 catch 吞掉
            const charConfig = charVoices['角色音色映射']?.[character];
            if (charConfig) {
                // 读取参考音频
                if (charConfig['参考音频']) {
                  // 2026-09-03 修复 M-3：原引用未定义的 CHARACTERS_DIR（声明数=0）→ 必抛
                  // ReferenceError 被下方 catch 吞掉，角色音色克隆永久静默失效。
                  // 无内置角色目录，参考音频与 character-voices.json 同放 data/。
                  const refPath = path.join(DATA_DIR, '参考音频', charConfig['参考音频']);
                  if (fs.existsSync(refPath)) {
                    characterRefAudio = { mime: 'audio/mpeg', data: fs.readFileSync(refPath).toString('base64') };
                    characterModel = 'mimo-v2.5-tts-voiceclone';
                    console.log(`[TTS] 角色绑定: ${character} → ${charConfig['参考音频']}`);
                  }
                }
                // 读取语音提示词（用于 style 参数）
                if (charConfig['语音提示词']) {
                  characterStyle = charConfig['语音提示词'];
                  console.log(`[TTS] 角色提示词: ${character} → ${characterStyle.slice(0, 50)}...`);
                }
              }
            }
          } catch (e) { console.error('[TTS] 角色绑定失败:', e.message); }
        }
        
        if (config.engine === 'mimo') {
          // TTS：文本放 assistant 消息，audio 参数指定音色
          // 三个模型 id：mimo-v2.5-tts（内置音色）/ -voicedesign（文字设计声线）/ -voiceclone（参考音频克隆）
          const mimoKey = config.apiKey || '';
          const ttsBase = String(config.baseURL || '').replace(/\/+$/, '');
          if (!ttsBase) {
            res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
            { res.end(JSON.stringify({ error: 'TTS 未配置：请填「端点（Base URL）」。', needConfig: true })); return true; };
          }
          if (!mimoKey) {
            res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
            { res.end(JSON.stringify({ error: 'TTS 未配置：请填「API Key」。', needConfig: true })); return true; };
          }
          const useModel = String(model || characterModel || config.model || MIMO_TTS_MODEL).slice(0, 40);
          if (!/^mimo-v2\.5-tts/.test(useModel)) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：非法值
            { res.end(JSON.stringify({ error: '不支持的 TTS 模型：' + useModel })); return true; };
          }
          // 组装 messages：风格/声音描述放 user（voicedesign 必填），朗读文本放 assistant
          // 优先级：请求中的 style > 角色绑定的语音提示词 > 默认提示词
          const styleText = String(style || characterStyle || '').trim();
          const messages = [
            ...(styleText ? [{ role: 'user', content: styleText.slice(0, 800) }] : []),
            ...(useModel === 'mimo-v2.5-tts-voicedesign' && !styleText ? [{ role: 'user', content: '请用自然、生动、清晰的语气朗读下面这段文本。' }] : []),
            { role: 'assistant', content: String(text).trim().slice(0, 2000) },
          ];
          const audioParam = { format: 'mp3' };
          let voiceLabel = useVoice;
          if (useModel === 'mimo-v2.5-tts') {
            audioParam.voice = useVoice;
          } else if (useModel === 'mimo-v2.5-tts-voiceclone') {
            // 参考音频来源：优先使用角色绑定的参考音频，其次使用请求中的 referenceAudio
            const ref = characterRefAudio || (referenceAudio && referenceAudio.data ? referenceAudio : null);
            if (!ref) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：缺参数
              { res.end(JSON.stringify({ error: '声音克隆需要参考音频（mp3/wav）或指定角色' })); return true; };
            }
            const mime = /wav/i.test(ref.mime || '') ? 'audio/wav' : 'audio/mpeg';
            audioParam.voice = `data:${mime};base64,${String(ref.data).slice(0, 14 * 1024 * 1024)}`;
            audioParam.format = 'wav';   // 官方 clone 示例用 wav
            voiceLabel = character ? `${character}的声音` : '克隆音色';
          }
          // voicedesign：不传 audio.voice（由风格描述生成声线）
          const base = ttsBase;
          const audioResp = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + mimoKey },
            body: JSON.stringify({ model: useModel, messages, audio: audioParam, stream: false }),
            signal: AbortSignal.timeout(120000),   // M-8：原无超时，上游挂起则请求永不返回、句柄泄漏
          });
          if (!audioResp.ok) {
            const errText = await audioResp.text();
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：上游失败
            { res.end(JSON.stringify({ error: `TTS 请求失败（HTTP ${audioResp.status}）：${errText.slice(0, 200)}` })); return true; };
          }
          const ar = await audioResp.json();
          const audioData = ar && ar.choices && ar.choices[0] && ar.choices[0].message && ar.choices[0].message.audio && ar.choices[0].message.audio.data;
          if (!audioData) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：上游返回异常
            { res.end(JSON.stringify({ error: 'TTS 响应缺少音频数据', raw: JSON.stringify(ar).slice(0, 200) })); return true; };
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          { res.end(JSON.stringify({ ok: true, audio: audioData, format: audioParam.format, voice: voiceLabel, model: useModel, message: `TTS 合成成功（${useModel === 'mimo-v2.5-tts' ? voiceLabel : useModel === 'mimo-v2.5-tts-voicedesign' ? '声线设计' : '声音克隆'}）` })); return true; };
        }
        if (config.engine === 'none') {
          res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });   // MINOR-1：需配置
          { res.end(JSON.stringify({ error: '语音合成功能未配置。请在设置中配置 TTS 引擎（内置三种：mimo / edge / openai）。', needConfig: true })); return true; };
        }
        // edge/openai 引擎：预留（需接入对应 SDK/API 后启用）
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, status: 'pending', message: `TTS 引擎 ${config.engine} 尚未接入实际合成，当前请使用 mimo 引擎。`, config: { engine: config.engine, voice: useVoice, rate: useRate } })); return true; };
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}
async function h_route_54(req, res, url, p) {
  // 旁注
    const annotM = p.match(/^\/api\/annotations(?:\/([^/]+))?$/);
  if (annotM) { const cid = annotM[1] ? sanitizeId(decodeURIComponent(annotM[1])) : null; const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); }; if (cid) { if (req.method === 'GET') { sendJson({ ok: true, ...loadAnnotations(cid) }); return true; }; if (req.method === 'POST') { let b = await readBody(req); try { const { action, note } = JSON.parse(b); const ann = loadAnnotations(cid); if (action === 'add') { const id = 'ann_' + Date.now(); ann.notes.push({ id, position: note?.position || 3, content: note?.content || '', enabled: true, createdAt: new Date().toISOString() }); saveAnnotations(cid, ann); return sendJson({ ok: true, id }); } if (action === 'update') { const idx = ann.notes.findIndex(n => n.id === note?.id); if (idx >= 0) { ann.notes[idx] = { ...ann.notes[idx], ...note }; saveAnnotations(cid, ann); } return sendJson({ ok: true }); } if (action === 'delete') { ann.notes = ann.notes.filter(n => n.id !== note?.id); saveAnnotations(cid, ann); return sendJson({ ok: true }); } return sendJson({ error: '未知操作' }); } catch (e) { return sendJson({ error: String(e) }, 400); } } } }
  return false;
}

module.exports = { h_api_tts_config_51, h_api_tts_config_52, h_api_tts_synthesize_53, h_route_54 };
