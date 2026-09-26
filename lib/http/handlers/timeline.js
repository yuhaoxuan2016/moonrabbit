// lib/http/handlers/timeline.js —— M-08·timeline-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { auxCall } = require('../../llm/main');
const { CHATS_DIR } = require('../../store/chats');
const { sanitizeId } = require('../../tools/misc');
const { readTurns } = require('../../turns/store');
const { truncateTurnsBySeq, buildInventory, appendItemRecord, normalizeTurnFields, appendManualTurn, updateTurnRecord, insertTurnRecord, deleteTurnRecord, buildCurrentWardrobe, PROMPT_DIR } = require('../../turns/timeline');

async function h_api_timeline_62(req, res, url, p) {
  const chatIdOf = () => sanitizeId(url.searchParams.get('chatId') || '');
  if (p === '/api/timeline' && req.method === 'GET') {
      /* E-9 修复：limit 非数字 → NaN → slice(-NaN)=全量返回；钳到 [1,100] */
      const limN = Number(url.searchParams.get('limit') || 20);
      const limit = Math.min(Number.isFinite(limN) ? Math.max(1, limN) : 20, 100);
      const allTurns = readTurns(chatIdOf());
      const turns = allTurns.slice(-limit).reverse();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ turns, total: allTurns.length })); return true; };
    }
  return false;
}
async function h_api_prompt_latest_63(req, res, url, p) {
  // 调试：查看最近提示词（最近一次 + 本会话历史记录）
    if (p === '/api/prompt/latest' && req.method === 'GET') {
      const cid = sanitizeId(url.searchParams.get('chatId') || '');
      const history = [];
      try {
        const file = path.join(PROMPT_DIR, `${cid}.jsonl`);
        if (fs.existsSync(file)) {
          for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-10)) {
            try { history.push(JSON.parse(l)); } catch (e) { /* 忽略 */ }
          }
        }
      } catch (e) { /* 忽略 */ }
      const latest = State.lastPrompt.chatId === cid ? State.lastPrompt : (history[history.length - 1] || null);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ latest, history: history.reverse() })); return true; };
    }
  return false;
}
async function h_api_timeline_manual_64(req, res, url, p) {
  // 手动补记一条回合（界面编辑）
    if (p === '/api/timeline/manual' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, story_time, location, atmosphere, characters, costume, event } = JSON.parse(body);
        const rec = await appendManualTurn(sanitizeId(chatId || ''), { story_time, location, atmosphere, characters, costume, event });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify(rec ? { ok: true, rec } : { ok: false, error: '写入失败' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_timeline_update_65(req, res, url, p) {
  // 修改单条回合记录（界面编辑，按 id 重写；保留物品/情绪等附属字段）
    if (p === '/api/timeline/update' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, id, story_time, location, atmosphere, characters, costume, event } = JSON.parse(body);
        if (!id) throw new Error('缺少记录 id');
        const rec = await updateTurnRecord(sanitizeId(chatId || ''), String(id), { story_time, location, atmosphere, characters, costume, event });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify(rec ? { ok: true, rec } : { ok: false, error: '未找到该记录' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_timeline_insert_66(req, res, url, p) {
  // 在指定条目之后插入一条回合记录（界面「＋ 插」补充；afterId 为空/未找到 → 追加末尾）
    if (p === '/api/timeline/insert' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, afterId, story_time, location, atmosphere, characters, costume, event } = JSON.parse(body);
        const rec = await insertTurnRecord(sanitizeId(chatId || ''), String(afterId || ''), { story_time, location, atmosphere, characters, costume, event });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify(rec ? { ok: true, rec } : { ok: false, error: '写入失败' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_timeline_delete_67(req, res, url, p) {
  // 删除单条回合记录
    if (p === '/api/timeline/delete' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, id } = JSON.parse(body);
        const ok = await deleteTurnRecord(sanitizeId(chatId || ''), String(id || ''));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify(ok ? { ok: true, note: '已删除该条记录' } : { ok: false, error: '未找到该记录' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_timeline_ai_fill_68(req, res, url, p) {
  // AI 智能补记：把用户一句话（可选）结合最近对话整理成规范时间线字段（走辅助 API 串行队列）
    if (p === '/api/timeline/ai-fill' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, hint } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        // 参考最近对话（当前会话最后 6 条；清洗 base64 图片）
        let recent = [];
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, `${cid}.json`), 'utf8'));
          recent = (c.messages || []).slice(-6).map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${String(m.content || '').replace(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g, '[图片]').replace(/\s+/g, ' ').slice(0, 300)}`).filter((s) => s.length > 4);
        } catch (e) { /* 无对话文件 */ }
        const userText = [
          hint ? `用户描述：${hint}` : '（用户未提供描述，请从最近对话中提取当前场景）',
          recent.length ? `\n\n最近对话（参考）：\n${recent.join('\n')}` : '',
        ].join('');
        const sys = '你是多角色 RP 的回合记录整理助手。根据用户描述和最近对话，输出一条规范的时间线补记记录，只输出纯 JSON（禁止 markdown 代码块、禁止多余文字）：{"story_time":"时间","location":"地点","characters":["在场角色"],"costume":"角色：着装描述","atmosphere":"氛围","event":"事件一句话（≤100字）","items_gain":[{"name":"物品名","holder":"持有者"}],"items_loss":["物品名"],"emotion":{"角色名":"情绪"},"location_detail":"分组| 地点名：2-4句描写"}。字段没有就填空字符串/空数组/空对象；characters 不确定留空数组；items_gain/items_loss 仅当对话中出现物品获得/消耗时填；emotion 仅当角色情绪明确时填；costume 仅当对话明确描述着装时填（格式「角色名：着装」）；location_detail 仅当出现新地点时填（格式「分组名| 地点名：描写」）；时间有明确日期用对话日期，否则给大概时段。';
        const text = await auxCall(sys, userText, 800, { thinking: { type: 'disabled' } });
        const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
        const first = cleaned.indexOf('{');
        const last = cleaned.lastIndexOf('}');
        let fields = null;
        try {
          fields = first >= 0 && last > first ? JSON.parse(cleaned.slice(first, last + 1)) : null;
        } catch (e2) {
          console.error('[ai-fill] JSON 解析失败:', e2.message);
          fields = null;
        }
        if (!fields) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          { res.end(JSON.stringify({ ok: false, error: 'AI 未返回有效 JSON，请重试或手动填写' })); return true; };
        }
        const nf = normalizeTurnFields({
          story_time: fields.story_time,
          location: fields.location,
          atmosphere: fields.atmosphere,
          characters: Array.isArray(fields.characters) ? fields.characters.join('、') : fields.characters,
          costume: fields.costume,
          event: fields.event,
          items_gain: fields.items_gain,
          items_loss: fields.items_loss,
          emotion: fields.emotion,
          location_detail: fields.location_detail,
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, fields: nf })); return true; };
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: false, error: 'AI 补全失败: ' + String(e.message || e).slice(0, 120) })); return true; };
      }
    }
  return false;
}
async function h_api_timeline_truncate_69(req, res, url, p) {
  // 按消息序号清理回合记录（重roll：mode=gte 删 seq>=n；删单条消息：mode=eq 删 seq==n）
    if (p === '/api/timeline/truncate' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, seq, mode } = JSON.parse(body);
        const n = Number(seq);
        if (!Number.isFinite(n) || n <= 0) throw new Error('缺少有效 seq');
        const removed = await truncateTurnsBySeq(sanitizeId(chatId || ''), n, mode === 'eq' ? 'eq' : 'gte');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, removed, note: `已清理 ${removed} 条回合记录` })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_timeline_export_73(req, res, url, p) {
  const chatIdOf = () => sanitizeId(url.searchParams.get('chatId') || '');
  if (p === '/api/timeline/export' && req.method === 'GET') {
      const turns = readTurns(chatIdOf());
      const lines = [];
      lines.push(`# 回合记录导出（${new Date().toISOString().slice(0, 10)}）`);
      lines.push('> 供自行归档 / 二次创作；本应用不写任何外部文件。');
      lines.push('');
      for (const t of turns) {
        lines.push(`### 【${t.story_time || '时间未记'} · ${t.location || '地点未记'} · 已发生】`);
        if (t.characters.length) lines.push(`- 在场：${t.characters.join('、')}`);
        if (t.costume && t.costume !== '同上') lines.push(`- 着装：${t.costume}`);
        if (t.atmosphere) lines.push(`- 氛围：${t.atmosphere}`);
        if (t.event) lines.push(`- 事件：${t.event}`);
        if (t.emotion) {
          for (const [en, ev] of Object.entries(t.emotion)) lines.push(`- 情绪：${en} = ${ev}`);
        }
        for (const g of (Array.isArray(t.items_gain) ? t.items_gain : [])) if (g && g.name) lines.push(`- 物品获得：${g.name}${g.holder ? ` = ${g.holder}` : ''}`);   /* E-11 */
        for (const n of (Array.isArray(t.items_loss) ? t.items_loss : [])) if (n) lines.push(`- 物品消耗/丢失：${n}`);   /* E-11 */
        for (const u of t.updates) lines.push(`- 【更新】${u.entry}：${u.content}`);
        lines.push('');
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      { res.end(lines.join('\n')); return true; };
    }
  return false;
}
async function h_api_inventory_70(req, res, url, p) {
  const chatIdOf = () => sanitizeId(url.searchParams.get('chatId') || '');
  if (p === '/api/inventory' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify(buildInventory(chatIdOf()))); return true; };
    }
  return false;
}
async function h_api_inventory_manual_71(req, res, url, p) {
  // 手动添加 / 消耗物品（界面编辑，记账）
    if (p === '/api/inventory/manual' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, action, name, holder } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const nm = String(name || '').trim().slice(0, 40);
        const act = action === 'loss' ? 'loss' : 'gain';
        if (!nm) throw new Error('缺少物品名');
        appendItemRecord(cid, act, nm, String(holder || '').trim().slice(0, 20));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, note: act === 'gain' ? `已添加物品：${nm}` : `已消耗/移除物品：${nm}` })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_wardrobe_current_72(req, res, url, p) {
  const chatIdOf = () => sanitizeId(url.searchParams.get('chatId') || '');
  // 当前着装聚合（界面显示 + 可改：改动走 /api/op/wardrobe）
    if (p === '/api/wardrobe/current' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ wardrobes: buildCurrentWardrobe(chatIdOf()) })); return true; };
    }
  return false;
}

module.exports = { h_api_timeline_62, h_api_prompt_latest_63, h_api_timeline_manual_64, h_api_timeline_update_65, h_api_timeline_insert_66, h_api_timeline_delete_67, h_api_timeline_ai_fill_68, h_api_timeline_truncate_69, h_api_timeline_export_73, h_api_inventory_70, h_api_inventory_manual_71, h_api_wardrobe_current_72 };
