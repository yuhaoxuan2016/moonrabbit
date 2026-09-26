// lib/http/handlers/memory.js —— M-08·memory-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../core/paths');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { auxCall } = require('../../llm/main');
const { REPORTS_DIR, listReports, saveReport } = require('../../store/reports');
const { saveStoryMemoryConfig } = require('../../store/storymemory');
const { handleHistorySearch } = require('../../tools/histsearch');
const { sanitizeId, sanitizeFileName, tokenize } = require('../../tools/misc');
const { readTurns } = require('../../turns/store');

async function h_api_story_memory_config_36(req, res, url, p) {
  // 剧情记忆配置（注入开关）
    if (p === '/api/story-memory/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, config: State.storyMemoryConfig })); return true; };
    }
  return false;
}
async function h_api_story_memory_config_37(req, res, url, p) {
  if (p === '/api/story-memory/config' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const updates = JSON.parse(body);
        State.storyMemoryConfig = { ...State.storyMemoryConfig, ...updates };
        saveStoryMemoryConfig();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, config: State.storyMemoryConfig })); return true; };
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}
async function h_api_story_memory_data_38(req, res, url, p) {
  // 剧情记忆数据（前端展示用）
    if (p === '/api/story-memory/data' && req.method === 'GET') {
      const chatId = sanitizeId(req.url?.match(/chatId=([^&]+)/)?.[1] || '');
      if (!chatId) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '缺少 chatId' })); return true; }; }
      const turns = readTurns(chatId);
      // 全部历史场景（按出现顺序保留，含时间/氛围/事件）
      const scenes = turns.filter(t => t.location).map(t => ({ story_time: t.story_time || '', location: t.location, atmosphere: t.atmosphere || '', event: t.event || '' }));
      const latestScene = scenes.length ? scenes[scenes.length - 1] : null;
      const allCharacterIntros = {};
      for (const t of turns) {
        if (t.character_intro && typeof t.character_intro === 'object') {
          for (const [name, intro] of Object.entries(t.character_intro)) {
            if (!allCharacterIntros[name]) allCharacterIntros[name] = intro;
          }
        }
      }
      const allRelationships = [];
      const seenRelKeys = new Set();
      for (const t of turns) {
        if (Array.isArray(t.relationships)) {
          for (const rel of t.relationships) {
            const key = `${rel.from}-${rel.to}`;
            if (!seenRelKeys.has(key)) { seenRelKeys.add(key); allRelationships.push(rel); }
          }
        }
      }
      // 地点详细档案（location_detail，按分组聚合，去重）
      const locationDetails = [];
      const seenLocKeys = new Set();
      for (const t of turns) {
        if (Array.isArray(t.location_detail)) {
          for (const loc of t.location_detail) {
            const key = `${loc.group}|${loc.name}`;
            if (!seenLocKeys.has(key)) { seenLocKeys.add(key); locationDetails.push(loc); }
          }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, scene: latestScene, scenes, characters: allCharacterIntros, relationships: allRelationships, locationDetails })); return true; };
    }
  return false;
}
async function h_api_story_memory_summary(req, res, url, p) {
  /* ⭐ S6 读取端点（2026-09-06）：供前端显示当前会话的历史摘要缓存 */
  if (p === '/api/story-memory/summary' && req.method === 'GET') {
    const chatId = url.searchParams.get('chatId') || '';
    const sumFile = path.join(DATA_DIR, 'summaries', sanitizeId(chatId) + '.json');
    let c = null;
    try { c = JSON.parse(fs.readFileSync(sumFile, 'utf8')); } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, summary: (c && c.summary) || '', count: (c && c.count) || 0 }));
    return true;
  }
  return false;
}
async function h_api_report_list_40(req, res, url, p) {
  // 报告系统
    if (p === '/api/report/list' && req.method === 'GET') { const cid = url.searchParams.get('chatId') || ''; res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, reports: listReports(cid) })); return true; }; }
  return false;
}
async function h_route_41(req, res, url, p) {
  // 报告内容读取（M6：前端 loadReportListUI 点击报告使用；filename 白名单校验防穿越）
    const reportReadM = p.match(/^\/api\/report\/([^/]+)\/([^/]+)$/);
  if (reportReadM && req.method === 'GET') {
      const cid = sanitizeId(decodeURIComponent(reportReadM[1]));
      const filename = sanitizeFileName(decodeURIComponent(reportReadM[2]), 80);
      const dir = path.join(REPORTS_DIR, cid);
      const file = path.join(dir, filename);
      try {
        if (!fs.existsSync(file) || path.dirname(file) !== dir) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '报告不存在' })); return true; };
        }
        const content = fs.readFileSync(file, 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, content })); return true; };
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_report_overview_42(req, res, url, p) {
  if (p === '/api/report/overview' && req.method === 'POST') { let b = await readBody(req); try { const { chatId, range } = JSON.parse(b); const cid = sanitizeId(chatId || ''); const f = path.join(DATA_DIR, 'chats', `${cid}.json`); if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '对话不存在' })); return true; }; } const chat = JSON.parse(fs.readFileSync(f, 'utf8')); const msgs = (chat.messages || []).slice(range === 'last10' ? -10 : range === 'today' ? -50 : -200); const recent = msgs.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 300)}`).join('\n'); const prompt = `你是一位 RP 回顾分析师。基于以下对话，生成回顾报告。\n\n报告格式：\n# RP 回顾报告\n\n## 关键事件\n- [时间] 事件描述\n\n## 角色发展\n- 角色名：成长/变化\n\n## 互动要点\n- 重要对话/决策\n\n## 未完事项\n- 伏笔/待续\n\n对话内容：\n${recent}\n\n输出 Markdown 格式的报告。`; const result = await auxCall(prompt); const filename = saveReport(cid, 'overview', result); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content: result, filename })); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); } }
  return false;
}
async function h_api_report_audit_43(req, res, url, p) {
  if (p === '/api/report/audit' && req.method === 'POST') { let b = await readBody(req); try { const { chatId, range } = JSON.parse(b); const cid = sanitizeId(chatId || ''); const f = path.join(DATA_DIR, 'chats', `${cid}.json`); if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '对话不存在' })); return true; }; } const chat = JSON.parse(fs.readFileSync(f, 'utf8')); const msgs = (chat.messages || []).slice(range === 'last10' ? -10 : range === 'today' ? -50 : -200); const recent = msgs.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 300)}`).join('\n'); const prompt = `你是一位 RP 质量审查员。基于以下对话，生成自检报告。\n\n评估维度：\n1. 角色一致性（言行是否符合设定）\n2. 时间线连贯性（时间/地点是否矛盾）\n3. 物品/状态一致性（持有物/能力是否合理）\n4. 对话质量（回复长度/风格/情感）\n5. 伏笔追踪（已埋伏笔是否被遗忘）\n\n报告格式：\n# AI 自检报告\n\n## 总评\n- 综合评分：X/10\n\n## 各维度评分\n| 维度 | 评分 | 问题 |\n|---|---|---|\n| 角色一致性 | X/10 | ... |\n\n## 具体问题\n- 问题描述 + 对应消息\n\n## 改进建议\n- 建议内容\n\n对话内容：\n${recent}\n\n输出 Markdown 格式的报告。`; const result = await auxCall(prompt); const filename = saveReport(cid, 'audit', result); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content: result, filename })); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); } }
  return false;
}
async function h_api_analyze_retro_44(req, res, url, p) {
  // 回溯分析
    if (p === '/api/analyze/retro' && req.method === 'POST') { let b = await readBody(req); try { const { chatId } = JSON.parse(b); const cid = sanitizeId(chatId || ''); const f = path.join(DATA_DIR, 'chats', `${cid}.json`); if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '对话不存在' })); return true; }; } const chat = JSON.parse(fs.readFileSync(f, 'utf8')); const allMsgs = chat.messages || []; const batchSize = 20; const results = []; for (let i = 0; i < allMsgs.length && results.length < 50; i += batchSize) {   /* E-10：批数上限 50，防 4000 条=200 次串行 LLM 调用 */ const batch = allMsgs.slice(i, i + batchSize); const batchText = batch.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 200)}`).join('\n'); const prompt = `分析以下 RP 对话片段，提取关键信息：\n1. 新出现的角色\n2. 关系变化\n3. 重要事件\n4. 物品/状态变化\n5. 场景变化\n\n对话：\n${batchText}\n\n输出 JSON 格式：{"characters":[],"relationships":[],"events":[],"items":[],"scenes":[]}`; try { const result = await auxCall(prompt); const parsed = JSON.parse(result.replace(/```(?:json)?\s*([\s\S]*?)```/, '$1').trim()); results.push(parsed); } catch (e) {} } const merged = { characters: [], relationships: [], events: [], items: [], scenes: [] }; for (const r of results) { if (r.characters) merged.characters.push(...r.characters); if (r.relationships) merged.relationships.push(...r.relationships); if (r.events) merged.events.push(...r.events); if (r.items) merged.items.push(...r.items); if (r.scenes) merged.scenes.push(...r.scenes); } const report = `# 回溯分析报告\n\n## 角色（${merged.characters.length}）\n${merged.characters.map(c => `- ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n')}\n\n## 关系变化（${merged.relationships.length}）\n${merged.relationships.map(r => `- ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n')}\n\n## 重要事件（${merged.events.length}）\n${merged.events.map(e => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n')}\n\n## 物品/状态（${merged.items.length}）\n${merged.items.map(i => `- ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n')}\n\n## 场景（${merged.scenes.length}）\n${merged.scenes.map(s => `- ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n')}`; const filename = saveReport(cid, 'retro', report); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content: report, filename, stats: { messages: allMsgs.length, batches: results.length } })); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); } }
  return false;
}
async function h_api_memory_search_45(req, res, url, p) {
  // 语义回忆：BM25 搜索聊天历史（跨会话或指定会话）
    if (p === '/api/memory/search' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { query, chatId, limit: lim } = JSON.parse(body);
        if (!query || !String(query).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '缺少查询词' })); return true; }; }
        const limNum = Number(lim);
        const maxResults = Math.min(Number.isFinite(limNum) ? limNum : 20, 50);
        const qTokens = tokenize(String(query));
        if (!qTokens.length) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ ok: true, results: [], total: 0 })); return true; }; }
        const MAX_MSGS = 5000;
        const chatFiles = chatId
          ? [path.join(DATA_DIR, 'chats', `${sanitizeId(chatId)}.json`)]
          : (() => { try { return fs.readdirSync(path.join(DATA_DIR, 'chats')).filter(f => f.endsWith('.json')).map(f => path.join(DATA_DIR, 'chats', f)); } catch (e) { return []; } })();
        const allMsgs = [];
        for (const f of chatFiles) {
          if (!fs.existsSync(f)) continue;
          try {
            const chat = JSON.parse(fs.readFileSync(f, 'utf8'));
            const cid = chat.id || path.basename(f, '.json');
            for (const m of (chat.messages || [])) {
              if (allMsgs.length >= MAX_MSGS) break;
              const txt = String(m.content || '');
              if (txt.length < 5) continue;
              allMsgs.push({ chatId: cid, role: m.role || 'unknown', content: txt.slice(0, 1000), seq: m.seq || 0, chatTitle: chat.title || cid });
            }
            if (allMsgs.length >= MAX_MSGS) break;
          } catch (e) { /* 跳过 */ }
        }
        const avgDl = allMsgs.length ? allMsgs.reduce((s, m) => s + tokenize(m.content).length, 0) / allMsgs.length : 1;
        const df = {};
        const msgTokens = allMsgs.map(m => { const t = tokenize(m.content); for (const w of new Set(t)) df[w] = (df[w] || 0) + 1; return t; });
        const N = allMsgs.length;
        const k1 = 1.5, b = 0.75;
        const scored = allMsgs.map((m, i) => {
          const tokens = msgTokens[i]; const dl = tokens.length || 1;
          const tfMap = {}; for (const t of tokens) tfMap[t] = (tfMap[t] || 0) + 1;
          let score = 0;
          for (const qt of qTokens) { const tf = tfMap[qt] || 0; const docFreq = df[qt] || 0; const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1); score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl)); }
          return { ...m, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const results = scored.filter(r => r.score > 0.1).slice(0, maxResults);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, results, total: N, queryTokens: qTokens.length })); return true; };
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}
async function h_api_history_search_60(req, res, url, p) {
  // 历史消息检索（本地关键词，零 API）
    if (p === '/api/history/search' && req.method === 'GET') { handleHistorySearch(url, res); return true; };
  return false;
}

module.exports = { h_api_story_memory_config_36, h_api_story_memory_config_37, h_api_story_memory_data_38, h_api_story_memory_summary, h_api_report_list_40, h_route_41, h_api_report_overview_42, h_api_report_audit_43, h_api_analyze_retro_44, h_api_memory_search_45, h_api_history_search_60 };
