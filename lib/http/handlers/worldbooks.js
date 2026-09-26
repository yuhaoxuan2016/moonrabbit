// lib/http/handlers/worldbooks.js —— M-08·worldbooks-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../core/paths');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { saveOpState, noteText } = require('../../store/opstate');
const { resolveWorldbookDir, saveLorebook, scanLorebook, WORLDBOOKS_DIR, saveWorldbook, activeBookIds, offBookIds, scanWorldbooks, saveGraph, savePersonas } = require('../../store/worldbooks');
const { sanitizeId } = require('../../tools/misc');

async function h_api_lorebook_30(req, res, url, p) {
  // 设定触发器（Lorebook）
    if (p === '/api/lorebook' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,entries:State.lorebookEntries,settings:State.lorebookSettings})); return true; }; }
  return false;
}
async function h_api_lorebook_31(req, res, url, p) {
  if (p === '/api/lorebook' && req.method === 'POST') { let b=await readBody(req); try { const {action,id,entry,settings,testText}=JSON.parse(b); if(action==='save'){const eid=id||'entry_'+Date.now(); State.lorebookEntries[eid]={...State.lorebookEntries[eid],...entry,id:eid}; saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,id:eid})); return true; };} if(action==='delete'){delete State.lorebookEntries[id]; saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='settings'){State.lorebookSettings={...State.lorebookSettings,...settings}; saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,settings:State.lorebookSettings}));} if(action==='scan'){const chatId=entry?.chatId||''; const f=path.join(DATA_DIR,'chats',`${sanitizeId(chatId)}.json`); let msgs=[]; if(fs.existsSync(f)){try{msgs=JSON.parse(fs.readFileSync(f,'utf8')).messages||[];}catch(e){}} const result=scanLorebook(msgs,testText||'',State.endpoint.maxContext); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,...result}));} if(action==='import'){try{const imp=JSON.parse(entry?.json||'{}'); if(imp.entries) Object.assign(State.lorebookEntries,imp.entries); saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,count:Object.keys(imp.entries||{}).length}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'导入格式错误'}));}} if(action==='list-worldbook'){try{const dir=resolveWorldbookDir(entry?.path); if(!fs.existsSync(dir)){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,entries:[],note:'目录不存在：'+dir}));} const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')).sort(); const list=[]; for(const f of files){try{const text=fs.readFileSync(path.join(dir,f),'utf8'); const fm=text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if(!fm) continue; const meta={}; for(const line of fm[1].split('\n')){const kv=line.match(/^(\w+):\s*(.+)$/); if(kv){const val=kv[2].trim(); if(val.startsWith('[')){try{meta[kv[1]]=JSON.parse(val);}catch(e){meta[kv[1]]=val.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim().replace(/^"|"$/g,''));}} else meta[kv[1]]=val.replace(/^"|"$/g,'');}} const content=(fm[2]||'').trim().slice(0,3000); if(!meta.name||!content) continue; const key='wb-'+(meta.uid??f.replace(/.md$/,'')); const exists=!!State.lorebookEntries[key]||Object.values(State.lorebookEntries).some(e=>e.name===meta.name&&e.source==='worldbook'); list.push({id:key,name:meta.name,keywords:Array.isArray(meta.keywords)?meta.keywords:(meta.keywords?String(meta.keywords).split(',').map(s=>s.trim()):[meta.name]),constant:meta.constant===true||meta.constant==='true',contentLength:content.length,contentPreview:content.slice(0,80),exists});}catch(e){}} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,total:files.length,entries:list}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:false,error:String(e)}));}} if(action==='import-worldbook'){try{const ids=Array.isArray(entry?.ids)?entry.ids:[]; const dir=resolveWorldbookDir(entry?.path); if(!fs.existsSync(dir)){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'目录不存在：'+dir}));} const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')); let imported=0; for(const f of files){try{const text=fs.readFileSync(path.join(dir,f),'utf8'); const fm=text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if(!fm) continue; const meta={}; for(const line of fm[1].split('\n')){const kv=line.match(/^(\w+):\s*(.+)$/); if(kv){const val=kv[2].trim(); if(val.startsWith('[')){try{meta[kv[1]]=JSON.parse(val);}catch(e){meta[kv[1]]=val.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim().replace(/^"|"$/g,''));}} else meta[kv[1]]=val.replace(/^"|"$/g,'');}} const key='wb-'+(meta.uid??f.replace(/.md$/,'')); if(!ids.includes(key)) continue; const content=(fm[2]||'').trim().slice(0,3000); if(!meta.name||!content) continue; State.lorebookEntries[key]={name:String(meta.name).slice(0,40),keywords:(Array.isArray(meta.keywords)?meta.keywords:[meta.name]).map(k=>String(k).slice(0,30)).slice(0,10),content:content,priority:Number(meta.order)||200,enabled:true,constant:meta.constant===true||meta.constant==='true',source:'worldbook'}; imported++;}catch(e){}} saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,imported}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)}));}} if(action==='export'){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,data:{entries:State.lorebookEntries,settings:State.lorebookSettings}}));} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  return false;
}
async function h_api_worldbooks_get(req, res, url, p) {
  if (p === '/api/worldbooks' && req.method === 'GET') {
    const chatId = url.searchParams.get('chatId') || '';
    const actives = activeBookIds(chatId);
    const offs = offBookIds(chatId);
    const books = Object.entries(State.worldbooks || {}).map(([id, wb]) => {
      const isGlobal = wb.book.scope === 'global';
      return {
        id, name: wb.book.name, description: wb.book.description, scope: wb.book.scope,
        enabled: wb.settings.enabled !== false, entryCount: Object.keys(wb.entries || {}).length,
        active: isGlobal ? !offs.includes(id) : actives.includes(id),
        sessionOff: offs.includes(id),
      };
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    { res.end(JSON.stringify({ ok: true, books, active: actives, off: offs })); return true; }
  }
  return false;
}
async function h_api_worldbooks_post(req, res, url, p) {
  if (p !== '/api/worldbooks' || req.method !== 'POST') return false;
  const body = await readBody(req);
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
  try {
    const parsed = JSON.parse(body);
    const { action, chatId, bookId, entryId, entry, book } = parsed;
    const cid = sanitizeId(chatId || '');
    if (action === 'get') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      return send({ ok: true, book: wb.book, settings: wb.settings, entries: wb.entries });
    }
    if (action === 'create-book') {
      const id = String((book && book.id) || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-') || ('book-' + Date.now());
      if (State.worldbooks[id]) return send({ error: '该书 id 已存在' });
      State.worldbooks[id] = {
        book: { id, name: (book && book.name) || id, description: (book && book.description) || '', scope: (book && book.scope) === 'global' ? 'global' : 'chat', version: 1, note: (book && book.note) || '' },
        settings: { enabled: true, tokenBudget: 'auto', budgetRatio: 0.08, scanDepth: 10 },
        entries: {},
      };
      saveWorldbook(id);
      return send({ ok: true, id });
    }
    if (action === 'save-book') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      wb.book = { ...wb.book, ...(book || {}), id: bookId };
      if (wb.book.scope !== 'global') wb.book.scope = 'chat';
      if (parsed.settings) wb.settings = { ...wb.settings, ...parsed.settings };
      saveWorldbook(bookId);
      return send({ ok: true, book: wb.book, settings: wb.settings });
    }
    if (action === 'delete-book') {
      delete State.worldbooks[bookId];
      try { fs.unlinkSync(path.join(WORLDBOOKS_DIR, bookId + '.json')); } catch (e) { /* 忽略 */ }
      return send({ ok: true });
    }
    if (action === 'set-active') {
      const list = Array.isArray(parsed.active) ? parsed.active.map(String) : [];
      const off = Array.isArray(parsed.off) ? parsed.off.map(String) : [];
      if (!State.opState.worldbooks) State.opState.worldbooks = {};
      if (list.length || off.length) State.opState.worldbooks[cid] = { active: list, off };
      else delete State.opState.worldbooks[cid];
      saveOpState();
      return send({ ok: true, active: list, off });
    }
    // 书级总开关：对所有会话生效
    if (action === 'toggle-book') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      wb.settings.enabled = parsed.enabled !== false;
      saveWorldbook(bookId);
      return send({ ok: true, enabled: wb.settings.enabled });
    }
    if (action === 'save-entry') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      const eid = entryId || ('e_' + Date.now());
      const prev = wb.entries[eid] || {};
      const next = { ...prev, ...(entry || {}), id: eid };
      next.keywords = Array.isArray(next.keywords) ? next.keywords.map(k => String(k).trim()).filter(Boolean) : [];
      next.priority = Number(next.priority) || 0;
      next.constant = !!next.constant;
      next.matchMode = next.constant ? 'any' : (next.matchMode === 'every' ? 'every' : 'any');
      next.enabled = next.enabled !== false;
      wb.entries[eid] = next;
      saveWorldbook(bookId);
      return send({ ok: true, id: eid, entry: next });
    }
    if (action === 'delete-entry') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      delete wb.entries[entryId];
      saveWorldbook(bookId);
      return send({ ok: true });
    }
    if (action === 'batch-enable') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      const ids = Array.isArray(parsed.ids) && parsed.ids.length ? parsed.ids : Object.keys(wb.entries);
      let cnt = 0;
      for (const id of ids) { if (wb.entries[id]) { wb.entries[id].enabled = !!parsed.enabled; cnt++; } }
      saveWorldbook(bookId);
      return send({ ok: true, count: cnt });
    }
    if (action === 'import-entries') {
      const wb = State.worldbooks[bookId];
      if (!wb) return send({ error: '世界书不存在' });
      let obj = null;
      try { obj = JSON.parse(parsed.json || '{}'); } catch (e) { return send({ error: 'JSON 格式错误：' + e.message }); }
      const src = obj.entries || obj;
      let cnt = 0;
      for (const [id, e] of Object.entries(src || {})) {
        if (!e || typeof e !== 'object') continue;
        const eid = String(e.id || id);
        wb.entries[eid] = { enabled: true, priority: 0, constant: false, matchMode: 'any', keywords: [], ...e, id: eid };
        cnt++;
      }
      saveWorldbook(bookId);
      return send({ ok: true, count: cnt });
    }
    if (action === 'scan') {
      const chatFile = path.join(DATA_DIR, 'chats', cid + '.json');
      let messages = [];
      if (fs.existsSync(chatFile)) { try { messages = JSON.parse(fs.readFileSync(chatFile, 'utf8')).messages || []; } catch (e) { /* 忽略 */ } }
      // 本会话写了【排除设定触发器】→ 与真实注入口径一致：只跳过全局层，本会话启用的世界书照常扫描
      const excluded = /【排除设定触发器】/.test(noteText(cid));
      const scanOpts = { skipGlobal: excluded };
      const nm = (r) => (r.entries || []).map(e => (e.book ? e.book + ' / ' : '') + e.name);
      // 两组口径：①真实注入口径（本会话最近 10 条 + 测试文本）②仅测试文本口径
      // （只返回①时测试文本会被会话上下文淹没，故两组都返回，前端分组显示）
      const withCtx = scanWorldbooks(messages, parsed.testText || '', State.endpoint.maxContext, cid, scanOpts);
      const onlyText = scanWorldbooks([], parsed.testText || '', State.endpoint.maxContext, cid, scanOpts);
      return send({
        ok: true, ...withCtx, names: nm(withCtx), skippedGlobal: excluded,
        onlyMatched: onlyText.matched, onlyEntries: (onlyText.entries || []).length, onlyNames: nm(onlyText),
      });
    }
    return send({ error: '未知 action: ' + action });
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e) }));
    return true;
  }
}
async function h_api_graph_32(req, res, url, p) {
  // 关系图谱
    if (p === '/api/graph' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,...State.graphData})); return true; }; }
  return false;
}
async function h_api_graph_33(req, res, url, p) {
  if (p === '/api/graph' && req.method === 'POST') { let b=await readBody(req); try { const {action,node,edge}=JSON.parse(b); if(action==='addNode'||action==='updateNode'){const id=node?.id||'node_'+Date.now(); const idx=State.graphData.nodes.findIndex(n=>n.id===id); const nn={id,name:node?.name||id,type:node?.type||'character',description:node?.description||'',tags:node?.tags||[]}; if(idx>=0)State.graphData.nodes[idx]=nn; else State.graphData.nodes.push(nn); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,node:nn})); return true; };} if(action==='addEdge'||action==='updateEdge'){const id=edge?.id||'edge_'+Date.now(); const idx=State.graphData.edges.findIndex(e=>e.id===id); const ne={id,from:edge?.from||'',to:edge?.to||'',label:edge?.label||'',weight:edge?.weight||1,description:edge?.description||''}; if(idx>=0)State.graphData.edges[idx]=ne; else State.graphData.edges.push(ne); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,edge:ne}));} if(action==='deleteNode'){State.graphData.nodes=State.graphData.nodes.filter(n=>n.id!==node?.id); State.graphData.edges=State.graphData.edges.filter(e=>e.from!==node?.id&&e.to!==node?.id); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='deleteEdge'){State.graphData.edges=State.graphData.edges.filter(e=>e.id!==edge?.id); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='import'){try{const imp=JSON.parse(node?.json||'{}'); if(imp.nodes) State.graphData.nodes=imp.nodes; if(imp.edges) State.graphData.edges=imp.edges; saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'导入格式错误'}));}} if(action==='export'){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,data:State.graphData}));} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  return false;
}
async function h_api_personas_34(req, res, url, p) {
  // 玩家身份
    if (p === '/api/personas' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,personas: State.personas,active:State.activePersona})); return true; }; }
  return false;
}
async function h_api_personas_35(req, res, url, p) {
  if (p === '/api/personas' && req.method === 'POST') { let b=await readBody(req); try { const {action,id,persona}=JSON.parse(b); if(action==='save'){const pid=id||'persona_'+Date.now(); State.personas[pid]={...State.personas[pid],...persona,name:(persona?.name||pid).slice(0,40)}; savePersonas(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,id:pid})); return true; };} if(action==='delete'){delete State.personas[id]; if(State.activePersona===id) State.activePersona=''; savePersonas(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='activate'){if(!State.personas[id]){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'身份不存在'}));} State.activePersona=id; savePersonas(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,active:id}));} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  return false;
}

module.exports = { h_api_lorebook_30, h_api_lorebook_31, h_api_worldbooks_get, h_api_worldbooks_post, h_api_graph_32, h_api_graph_33, h_api_personas_34, h_api_personas_35 };
