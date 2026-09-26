// lib/http/handlers/op.js —— M-08·op-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const { BRIDGE_TOOL_NAMES, BRIDGE_TOOL_LABELS } = require('../../agent/bridge');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { buildEmotions, setEmotion } = require('../../store/emotions');
const { saveOpState, NOTE_SLOTS, noteSlots, noteText, customInjections } = require('../../store/opstate');
const { sanitizeId } = require('../../tools/misc');
const { appendOpRecord } = require('../../turns/record');

async function h_api_op_view_12(req, res, url, p) {
  // 界面操作：视角切换 / 换装（记账 + 状态持久化，供导出/时间线）
    if (p === '/api/op/view' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, view } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const v = String(view || '').trim().slice(0, 30);
        if (!v) {
          // 空值 = 恢复默认（用户角色主观视角）
          delete State.opState.views[cid];
          saveOpState();
          appendOpRecord(cid, '当前视角', '默认（用户角色）');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          { res.end(JSON.stringify({ ok: true, view: '', note: '已恢复默认视角（用户角色主观视角）' })); return true; };
        }
        State.opState.views[cid] = v;
        saveOpState();
        appendOpRecord(cid, '当前视角', v);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, view: v, note: `已切换视角：${v}（已记账，可导出回合记录）` })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_wardrobe_13(req, res, url, p) {
  if (p === '/api/op/wardrobe' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, character, outfit, worn } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const ch = String(character || '').trim().slice(0, 20);
        const of = String(outfit || '').trim().slice(0, 200);
        if (!ch || !of) throw new Error('缺少角色或着装描述');
        const day = String(worn || '').trim() || '今日';
        State.opState.wardrobes[cid] = `${ch}：${of}`;
        saveOpState();
        appendOpRecord(cid, '衣柜', `${ch}：${of}（${day}）`);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, note: `✅ 已更新《衣柜》：${ch}：${of}（已记账，可导出回合记录）` })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_expand_14(req, res, url, p) {
  // 界面操作：扩写指令开关（记账）
    if (p === '/api/op/expand' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, enabled } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const en = Boolean(enabled);
        if (en) State.opState.expands[cid] = true; else delete State.opState.expands[cid];
        saveOpState();
        appendOpRecord(cid, '扩写指令', en ? '开启' : '关闭');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, enabled: en, note: en ? '扩写指令已开启（本会话生效，短指令将自动扩写）' : '扩写指令已关闭' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_tools_15(req, res, url, p) {
  // 界面操作：工具桥开关（自由选取工具集合；记账）
    if (p === '/api/op/tools' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, tools } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const sel = (Array.isArray(tools) ? tools : []).filter((n) => BRIDGE_TOOL_NAMES.includes(String(n)));
        if (sel.length) State.opState.tools[cid] = sel; else delete State.opState.tools[cid];
        saveOpState();
        appendOpRecord(cid, '工具桥', sel.length ? sel.map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、') : '关闭');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, tools: sel, note: sel.length ? '工具桥已开启：' + sel.map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、') : '工具桥已关闭' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_note_55(req, res, url, p) {
  // 界面操作：会话常驻设定（📌 每轮注入 system，不被上下文裁剪；按会话隔离）
    // Task15 多槽位：GET 返回 {note:合并文本, slots:{背景,关系,规则,其他}}；POST 支持 slots 对象或旧字符串 note
    if (p === '/api/op/note' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, note, get, slots } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        if (get) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          { res.end(JSON.stringify({ note: noteText(cid), slots: noteSlots(cid) })); return true; };
        }
        // 多槽位保存（新前端）：slots 对象 → 存对象（仅保留已知槽位；全空 = 清空）
        if (slots && typeof slots === 'object') {
          const clean = {};
          let hasAny = false;
          for (const k of NOTE_SLOTS) {
            const v = slots[k];
            if (v != null && typeof v === 'string' && v.trim()) { clean[k] = v.trim().slice(0, 4000); hasAny = true; }
          }
          if (hasAny) State.opState.notes[cid] = clean; else delete State.opState.notes[cid];
          saveOpState();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          { res.end(JSON.stringify({ ok: true, saved: hasAny, note: hasAny ? '会话常驻设定已保存（每轮注入 system）' : '会话常驻设定已清空' })); return true; };
        }
        // 旧接口兼容：字符串 note → 视为「其他」槽（读取时按迁移逻辑归位）；与 slots 路径一致截断 4000
        const n = String(note || '').trim().slice(0, 4000);
        if (n) State.opState.notes[cid] = n; else delete State.opState.notes[cid];
        saveOpState();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, saved: !!n, note: n ? '会话常驻设定已保存（每轮注入 system）' : '会话常驻设定已清空' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_inject_56(req, res, url, p) {
  // 界面操作：自定义注入槽（⚙️ 前缀 / 后缀，按会话，随 system 注入）
    if (p === '/api/op/inject' && req.method === 'GET') {
      const inj = customInjections(url.searchParams.get('chatId') || '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ ok: true, ...inj })); return true; };
    }
  return false;
}
async function h_api_op_inject_57(req, res, url, p) {
  if (p === '/api/op/inject' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, prefix, suffix } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const cur = customInjections(chatId || '');
        const next = {
          prefix: String(prefix != null ? prefix : cur.prefix).trim().slice(0, 2000),
          suffix: String(suffix != null ? suffix : cur.suffix).trim().slice(0, 2000),
        };
        if (!State.opState.customInjections) State.opState.customInjections = {};
        if (next.prefix || next.suffix) State.opState.customInjections[cid] = next;
        else delete State.opState.customInjections[cid];
        saveOpState();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, note: next.prefix || next.suffix ? '自定义注入已保存（前缀/后缀随 system 注入，下一轮生效）' : '自定义注入已清空' })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_emotion_59(req, res, url, p) {
  if (p === '/api/op/emotion' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId, name, emotion } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const nm = String(name || '').trim().slice(0, 20);
        if (!nm) throw new Error('缺少角色名');
        setEmotion(cid, nm, String(emotion || '').trim().slice(0, 120));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        const cur = buildEmotions(cid);
        { res.end(JSON.stringify({ ok: true, emotions: cur, note: emotion && String(emotion).trim() ? `已记录 ${nm} 的情绪（已记账，可导出回合记录）` : `已清除 ${nm} 的情绪记录` })); return true; };
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ error: String(e) })); return true; };
      }
    }
  return false;
}
async function h_api_op_attach_pending_75(req, res, url, p) {
  // 当前会话「待注入附加资料」持久化（2026-08-30 修复：此前只存前端内存，刷新/重启后丢失）
  // GET /api/op/attach-pending?chatId=x → { ok, text, ts }
  // POST /api/op/attach-pending → body {chatId, text}（text 空串 = 清除）
  const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const cid = sanitizeId(url.searchParams?.get('chatId') || '');
  if (p === '/api/op/attach-pending' && req.method === 'GET') {
    const pend = (State.opState.attachPending && State.opState.attachPending[cid]) || null;
    sendJson({ ok: true, text: pend ? pend.text : '', ts: pend ? pend.ts : 0 });
    return true;
  }
  if (p === '/api/op/attach-pending' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, text } = JSON.parse(body);
      const c = sanitizeId(chatId || '');
      if (!State.opState.attachPending) State.opState.attachPending = {};
      const t = String(text || '').trim();
      if (!t) {
        delete State.opState.attachPending[c];
      } else {
        State.opState.attachPending[c] = { text: t, ts: Date.now() };
      }
      saveOpState();
      sendJson({ ok: true, note: t ? '已持久化待注入资料' : '已清除' });
      return true;
    } catch (e) {
      sendJson({ error: String(e) }, 400);
      return true;
    }
  }
  return false;
}

module.exports = { h_api_op_view_12, h_api_op_wardrobe_13, h_api_op_expand_14, h_api_op_tools_15, h_api_op_note_55, h_api_op_inject_56, h_api_op_inject_57, h_api_op_emotion_59, h_api_op_attach_pending_75 };
