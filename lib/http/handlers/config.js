// lib/http/handlers/config.js —— M-08·config-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { ASYNC_IO, writeJson, writeFileAtomicSync, writeQueued, backupConfig } = require('../../core/io');
const { DATA_DIR } = require('../../core/paths');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { chatFilePath } = require('../../store/chats');
const { MODEL_FILE, BUILTIN_PRESETS, normPreset, savePresets, applyPreset, BUILTIN_PROFILES, saveProfiles, snapshotEndpoint, applyProfile, saveKeyMemo, BUILTIN_CHAT_PROFILES, saveChatProfiles, recordLastChat, cleanMsgs, probeEndpoint, readChats, loadChatMetas } = require('../../store/config');
const { sanitizeId, assertSafeEndpoint, turnsFile } = require('../../tools/misc');

async function h_api_model_6(req, res, url, p) {
  // 模型 / API 端点查看与切换（持久化 data/model.json；POST 时探测验证）
    if (p === '/api/model' && req.method === 'GET') {
      const k = State.endpoint.apiKey || '';
      const ak = State.aux.apiKey || '';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({
        model: State.endpoint.model,
        protocol: State.endpoint.protocol,
        baseURL: State.endpoint.baseURL,
        apiKeyMasked: k ? '...' + k.slice(-4) : '',
        usingDefaultKey: (() => { try { return !fs.existsSync(MODEL_FILE) || !(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8') || '{}').apiKey); } catch (e) { return true; } })(),
        maxTokens: State.endpoint.maxTokens,
        thinking: State.endpoint.thinking,
        thinkingBudget: State.endpoint.thinkingBudget,
        maxContext: State.endpoint.maxContext,
        autoSummary: State.endpoint.autoSummary,
        autoSummaryThreshold: State.endpoint.autoSummaryThreshold,
        // 辅助 API（后台任务独立端点）
        aux: {
          enabled: State.aux.enabled,
          protocol: State.aux.protocol,
          baseURL: State.aux.baseURL,
          apiKeyMasked: ak ? '...' + ak.slice(-4) : '',
          model: State.aux.model,
          fallback: State.aux.fallback,
        },
        // 峰谷定价仅官方直连渠道适用（DeepSeek 官方：高峰 9-12 / 14-18 翻倍）
        peakEligible: /api\.deepseek\.com/i.test(State.endpoint.baseURL || ''),
      })); return true; };
    }
  return false;
}
async function h_api_model_7(req, res, url, p) {
  if (p === '/api/model' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { model, baseURL, apiKey, protocol, maxTokens, thinking, thinkingBudget, maxContext, autoSummary, autoSummaryThreshold, aux } = JSON.parse(body);
        const next = { ...State.endpoint };
        if (protocol === 'anthropic' || protocol === 'openai') next.protocol = protocol;
        if (baseURL && baseURL.trim()) next.baseURL = assertSafeEndpoint(baseURL);   // C-2：校验失败抛 400，不落盘不探测
        if (apiKey && apiKey.trim()) next.apiKey = apiKey.trim();
        if (model && model.trim()) next.model = model.trim();
        if (Number.isFinite(maxTokens) && maxTokens >= 256 && maxTokens <= 393216) next.maxTokens = maxTokens;
        if (['auto', 'disabled', 'low', 'medium', 'high', 'max', 'custom'].includes(thinking)) next.thinking = thinking;
        else if (thinking === 'enabled') next.thinking = 'high';   // 旧「开启」→ 深度思考档
        if (Number.isFinite(thinkingBudget) && thinkingBudget >= 256 && thinkingBudget <= 393216) next.thinkingBudget = thinkingBudget;
        if (Number.isFinite(maxContext) && maxContext >= 0 && maxContext <= 1048576) next.maxContext = maxContext;
        if (typeof autoSummary === 'boolean') next.autoSummary = autoSummary;
        if (Number.isFinite(autoSummaryThreshold) && autoSummaryThreshold >= 2000 && autoSummaryThreshold <= 100000) next.autoSummaryThreshold = autoSummaryThreshold;
        if (!next.apiKey) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          { res.end(JSON.stringify({ ok: false, error: '缺少 API Key' })); return true; };
        }
        // 辅助 API 配置（可选：不填 = 保持原值）
        const nextAux = { ...State.aux };
        if (aux && typeof aux === 'object') {
          if (typeof aux.enabled === 'boolean') nextAux.enabled = aux.enabled;
          if (aux.protocol === 'anthropic' || aux.protocol === 'openai') nextAux.protocol = aux.protocol;
          if (aux.baseURL && typeof aux.baseURL === 'string' && aux.baseURL.trim()) nextAux.baseURL = assertSafeEndpoint(aux.baseURL);   // C-2
          if (aux.apiKey && typeof aux.apiKey === 'string' && aux.apiKey.trim()) nextAux.apiKey = aux.apiKey.trim();
          if (aux.model && typeof aux.model === 'string' && aux.model.trim()) nextAux.model = aux.model.trim();
          if (typeof aux.fallback === 'boolean') nextAux.fallback = aux.fallback;
        }
        const requested = next.model;
        // 轻量探测（max_tokens:1）：验证端点/Key/模型，端点会把不存在的模型名静默映射到实际模型
        const probed = await probeEndpoint(next);
        next.model = probed.model;
        State.endpoint = next;
        State.aux = nextAux;
        // Key 自动记忆：保存时把「端点 + Key」记入记忆，之后切到该端点档案自动带上
        if (next.baseURL && next.apiKey) State.keyMemo.by[next.baseURL] = next.apiKey;
        if (nextAux.baseURL && nextAux.apiKey) State.keyMemo.auxBy[nextAux.baseURL] = nextAux.apiKey;
        saveKeyMemo();
        backupConfig(MODEL_FILE);
        writeFileAtomicSync(MODEL_FILE, JSON.stringify({
          protocol: State.endpoint.protocol, baseURL: State.endpoint.baseURL, apiKey: State.endpoint.apiKey,
          model: State.endpoint.model, maxTokens: State.endpoint.maxTokens, thinking: State.endpoint.thinking,
          thinkingBudget: State.endpoint.thinkingBudget, maxContext: State.endpoint.maxContext,
          autoSummary: State.endpoint.autoSummary, autoSummaryThreshold: State.endpoint.autoSummaryThreshold,
          aux: { enabled: State.aux.enabled, protocol: State.aux.protocol, baseURL: State.aux.baseURL, apiKey: State.aux.apiKey, model: State.aux.model, fallback: State.aux.fallback },
          updatedAt: new Date().toISOString(),
        }), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, model: State.endpoint.model, requested, mapped: probed.model !== requested })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: false, error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_route_8(req, res, url, p) {
  // 会话管理：列表 / 新建 / 读取 / 保存 / 删除
    const chatM = p.match(/^\/api\/chats(?:\/([^/]+))?$/);
  if (chatM) {
      const id = chatM[1];
      const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      // POST /api/chats/unarchive — 恢复已归档会话（必须在 :id 路由之前匹配）
      if (p === '/api/chats/unarchive' && req.method === 'POST') {
        let body = await readBody(req);
        try {
          const { chatId } = JSON.parse(body);
          if (!chatId) { sendJson({ error: 'missing chatId' }, 400); return true; };
          // 2026-09-03 安全修复 C-1：显式消毒，防 ../ 穿越改写 data/chats 之外的任意 JSON
          const safeChatId = sanitizeId(chatId);
          if (safeChatId !== String(chatId)) { sendJson({ error: 'invalid chatId' }, 400); return true; };
          const file = chatFilePath(safeChatId);
          if (ASYNC_IO) {
            if (!(await fs.promises.stat(file).catch(() => null))) { sendJson({ error: 'chat not found' }, 404); return true; };
            await writeQueued(file, async () => {
              const chat = JSON.parse(await fs.promises.readFile(file, 'utf8'));   // 损坏 → 抛出 → 400（与原同步路径一致）
              chat.hidden = false;
              chat.updatedAt = new Date().toISOString();
              await writeJson(file, chat);
            });
            { sendJson({ ok: true }); return true; };
          }
          if (!fs.existsSync(file)) { sendJson({ error: 'chat not found' }, 404); return true; };
          const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
          chat.hidden = false;
          chat.updatedAt = new Date().toISOString();
          writeFileAtomicSync(file, JSON.stringify(chat), 'utf8');
          { sendJson({ ok: true }); return true; };
        } catch (e) { { sendJson({ error: String(e) }, 400); return true; }; }
      }
      if (!id) {
        // GET /api/chats — 支持 ?archived=true 返回已归档会话（默认不返回）
        if (req.method === 'GET') {
          const urlObj = new URL(req.url, 'http://localhost');
          const showArchived = urlObj.searchParams.get('archived') === 'true';
          if (ASYNC_IO) {
            // 元数据缓存（文件签名未变不重新 parse）；排序在过滤前完成，语义与 readChats 一致
            const metas = await loadChatMetas();
            { sendJson({ chats: metas.filter((c) => showArchived ? c.hidden : !c.hidden) }); return true; };
          }
          if (showArchived) {
            const all = readChats(true);
            const normal = new Set(readChats(false).map(c => c.id));
            const archived = all.filter(c => !normal.has(c.id));
            { sendJson({ chats: archived }); return true; };
          }
          { sendJson({ chats: readChats() }); return true; };
        }
        if (req.method === 'POST') {
          const cid = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
          const chat = { id: cid, title: '新对话', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
          if (ASYNC_IO) await writeQueued(chatFilePath(cid), () => writeJson(chatFilePath(cid), chat));
          else writeFileAtomicSync(chatFilePath(cid), JSON.stringify(chat), 'utf8');
          { sendJson({ id: cid }); return true; };
        }
      }
      const file = chatFilePath(id);
      if (req.method === 'GET') {
        if (ASYNC_IO) {
          if (!(await fs.promises.stat(file).catch(() => null))) { sendJson({ error: 'not found' }, 404); return true; }
          recordLastChat(id);   // 只在确认会话存在后才记：否则删掉会话后每次刷新都会把死 id 记回去
          try {
            const chat = JSON.parse(await fs.promises.readFile(file, 'utf8'));   // 损坏 → 500（与原同步路径一致）
            if (Array.isArray(chat.messages)) chat.messages = cleanMsgs(chat.messages);   // 展示前清理「方块」乱码（不写盘）
            { sendJson(chat); return true; };
          } catch (e) { { sendJson({ error: 'failed to load chat' }, 500); return true; }; }
        }
        if (!fs.existsSync(file)) { sendJson({ error: 'not found' }, 404); return true; };
        recordLastChat(id);
        try {
          const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(chat.messages)) chat.messages = cleanMsgs(chat.messages);   // 展示前清理「方块」乱码（不写盘）
          { sendJson(chat); return true; };
        } catch (e) { { sendJson({ error: 'failed to load chat' }, 500); return true; }; }
      }
      if (req.method === 'PUT') {
        let body = await readBody(req);
        try {
          const { title, messages, pinned, hidden, versions, chatProfile } = JSON.parse(body);
          // 读-改-写整体进写队列：与并发保存（前端自动保存/其他页签）串行，消除交错写
          if (ASYNC_IO) {
            await writeQueued(file, async () => {
              let chat;
              if (await fs.promises.stat(file).catch(() => null)) chat = JSON.parse(await fs.promises.readFile(file, 'utf8'));   // 损坏 → 抛出 → 400
              else chat = { id, createdAt: new Date().toISOString() };
              if (typeof pinned === 'boolean') chat.pinned = pinned;
              if (typeof hidden === 'boolean') chat.hidden = hidden;
              chat.title = (title || chat.title || '未命名').slice(0, 40);
              // 写盘前清理「方块」乱码：即使浏览器/历史里带 U+FFFD，落盘也始终干净
              chat.messages = Array.isArray(messages) ? cleanMsgs(messages) : (chat.messages || []);
              /* E-7+F-2 修复：空对象 {} 不覆盖已存链（防旧版前端/异常路径把版本链覆盖成空） */
              if (versions && typeof versions === 'object' && Object.keys(versions).length) chat.versions = versions;
              /* ⭐ S4（2026-09-06）：chatProfile 随 PUT 落盘（对话配置档绑定通道；undefined=不覆盖） */
              if (chatProfile !== undefined) chat.chatProfile = String(chatProfile).trim() || undefined;
              chat.updatedAt = new Date().toISOString();
              await writeJson(file, chat);
            });
            { sendJson({ ok: true }); return true; };
          }
          const chat = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id, createdAt: new Date().toISOString() };
          if (typeof pinned === 'boolean') chat.pinned = pinned;
          if (typeof hidden === 'boolean') chat.hidden = hidden;
          chat.title = (title || chat.title || '未命名').slice(0, 40);
          // 写盘前清理「方块」乱码：即使浏览器/历史里带 U+FFFD，落盘也始终干净
          chat.messages = Array.isArray(messages) ? cleanMsgs(messages) : (chat.messages || []);
          /* E-7+F-2 修复：同步路径接收 versions，且空对象 {} 不覆盖已存链 */
          if (versions && typeof versions === 'object' && Object.keys(versions).length) chat.versions = versions;
          if (chatProfile !== undefined) chat.chatProfile = String(chatProfile).trim() || undefined;   /* ⭐ S4 同步路径 */
          chat.updatedAt = new Date().toISOString();
          writeFileAtomicSync(file, JSON.stringify(chat), 'utf8');
          { sendJson({ ok: true }); return true; };
        } catch (e) { { sendJson({ error: String(e) }, 400); return true; }; }
      }
      if (req.method === 'DELETE') {
        if (ASYNC_IO) {
          await writeQueued(file, () => fs.promises.unlink(file).catch(() => {}));   // 与同文件写串行
          await writeQueued(turnsFile(id), () => fs.promises.unlink(turnsFile(id)).catch(() => {}));
          { sendJson({ ok: true }); return true; };
        }
        try { fs.unlinkSync(file); } catch (e) { /* 可能已删 */ }
        try { fs.unlinkSync(turnsFile(id)); } catch (e) { /* 无回合记录 */ }
        { sendJson({ ok: true }); return true; };
      }
      { sendJson({ error: 'method' }, 405); return true; };
    }
  return false;
}
async function h_api_presets_16(req, res, url, p) {
  // 界面操作：API 采样预设（命名预设）
    if (p === '/api/presets' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ ok: true, presets: State.presets, active: State.activePreset, samplers: State.samplers })); return true; };
    }
  return false;
}
async function h_api_presets_17(req, res, url, p) {
  if (p === '/api/presets' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { action, name, preset } = JSON.parse(body);
        const nm = String(name || '').trim().slice(0, 40);
        if (action === 'apply') {
          if (!State.presets[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '预设不存在：' + nm })); return true; }; }
          applyPreset(nm);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, active: nm, samplers: State.samplers, note: `已应用预设「${nm}」` })); return true; };
        }
        if (action === 'save') {
          if (!nm) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '预设名不能为空' })); return true; }; }
          State.presets[nm] = normPreset(preset || {});
          applyPreset(nm);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, active: nm, note: `预设「${nm}」已保存并应用` })); return true; };
        }
        if (action === 'delete') {
          if (BUILTIN_PRESETS[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '内置预设不可删除' })); return true; }; }
          delete State.presets[nm];
          savePresets();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, note: `预设「${nm}」已删除` })); return true; };
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '未知操作' }));
      } catch (e) {
        res.writeHead(400); { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_profiles_18(req, res, url, p) {
  // 配置档案（Profile：端点 + 模型 + 参数整套一键切换）
    if (p === '/api/profiles' && req.method === 'GET') {
      const list = {};
      for (const [k, v] of Object.entries(State.profiles)) {
        const bu = v.baseURL ? v.baseURL.replace(/\/+$/, '') : '';
        list[k] = { ...v, builtin: !!BUILTIN_PROFILES[k], keyReady: !!(bu && State.keyMemo.by[bu]) };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ ok: true, profiles: list, active: State.activeProfile, current: snapshotEndpoint() })); return true; };
    }
  return false;
}
async function h_api_profiles_19(req, res, url, p) {
  if (p === '/api/profiles' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { action, name, profile } = JSON.parse(body);
        const nm = String(name || '').trim().slice(0, 40);
        if (action === 'apply') {
          if (!State.profiles[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '档案不存在：' + nm })); return true; }; }
          applyProfile(nm);
          const k = State.endpoint.apiKey || '';
          const ak = State.aux.apiKey || '';
          const bu = State.endpoint.baseURL || '';
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, active: nm, model: State.endpoint.model, protocol: State.endpoint.protocol, baseURL: State.endpoint.baseURL, apiKeyMasked: k ? '...' + k.slice(-4) : '', keySource: State.keyMemo.by[bu] ? 'memo' : 'kept', keyReady: !!State.keyMemo.by[bu], auxKeyMasked: ak ? '...' + ak.slice(-4) : '', maxTokens: State.endpoint.maxTokens, thinking: State.endpoint.thinking, maxContext: State.endpoint.maxContext, preset: State.activePreset, note: `已切换到「${nm}」`, peakEligible: /api\.deepseek\.com/i.test(bu) })); return true; };
        }
        if (action === 'save') {
          if (!nm) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '档案名不能为空' })); return true; }; }
          const snap = snapshotEndpoint();
          State.profiles[nm] = { ...snap, ...(profile || {}), desc: (profile && profile.desc) || (BUILTIN_PROFILES[nm] ? BUILTIN_PROFILES[nm].desc : '') };
          delete State.profiles[nm].apiKey;
          delete State.profiles[nm].builtin;
          saveProfiles();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, active: nm, note: `档案「${nm}」已保存（端点 + 模型 + 参数）` })); return true; };
        }
        if (action === 'delete') {
          if (BUILTIN_PROFILES[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '内置档案不可删除' })); return true; }; }
          if (!State.profiles[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '档案不存在：' + nm })); return true; }; }
          delete State.profiles[nm];
          if (State.activeProfile === nm) State.activeProfile = '';
          saveProfiles();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, note: `档案「${nm}」已删除` })); return true; };
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '未知操作' }));
      } catch (e) {
        res.writeHead(400); { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_chat_profiles_20(req, res, url, p) {
  // 对话配置档系统
    if (p === '/api/chat-profiles' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, profiles: State.chatProfiles })); return true; };
    }
  return false;
}
async function h_api_chat_profiles_21(req, res, url, p) {
  if (p === '/api/chat-profiles' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { action, id, profile } = JSON.parse(body);
        if (action === 'save') {
          if (!id?.trim()) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: 'ID 不能为空' })); return true; }; }
          State.chatProfiles[id.trim().slice(0, 30)] = { ...State.chatProfiles[id.trim()], ...profile, label: (profile?.label || id).slice(0, 40) };
          saveChatProfiles();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true })); return true; };
        }
        if (action === 'delete') {
          if (BUILTIN_CHAT_PROFILES[id]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '内置不可删' })); return true; }; }
          delete State.chatProfiles[id]; saveChatProfiles();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true })); return true; };
        }
        if (action === 'apply') {
          const chatId = sanitizeId(profile?.chatId || '');
          if (!chatId || !State.chatProfiles[id]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '参数错误' })); return true; }; }
          try {
            const f = path.join(DATA_DIR, 'chats', `${chatId}.json`);
            const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.chatProfile = id; writeFileAtomicSync(f, JSON.stringify(c, null, 2), 'utf8');
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true })); return true; };
          } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '对话不存在' })); return true; }; }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '未知操作' }));
      } catch (e) { res.writeHead(400); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}

module.exports = { h_api_model_6, h_api_model_7, h_route_8, h_api_presets_16, h_api_presets_17, h_api_profiles_18, h_api_profiles_19, h_api_chat_profiles_20, h_api_chat_profiles_21 };
