// lib/http/handlers/stats.js —— M-08·stats-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../core/paths');
const { estimateCost } = require('../../core/price');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { auxCall } = require('../../llm/main');
const { buildEmotions } = require('../../store/emotions');
const { saveRegexRules } = require('../../store/regex');
const { emptyBucket, stats, summarize } = require('../../store/stats');
const { sanitizeId } = require('../../tools/misc');

async function h_api_stats_61(req, res, url, p) {
  // 会话统计：当前模型 + 全部合计 + 每日费用（Task6）
    if (p === '/api/stats' && req.method === 'GET') {
      const cur = summarize(stats.byModel[State.endpoint.model] || emptyBucket());
      const total = Object.values(stats.byModel).reduce((acc, b) => {
        acc.turns += b.turns; acc.calls += b.calls; acc.llmMs += b.llmMs;
        acc.firstTokenSum += b.firstTokenSum; acc.firstTokenN += b.firstTokenN;
        acc.tokensIn += b.tokensIn; acc.tokensOut += b.tokensOut;
        acc.cacheRead += b.cacheRead; acc.cacheMiss += b.cacheMiss;
        return acc;
      }, emptyBucket());
      const t = summarize(total);
      // 每日费用统计（按调用完成日期分桶；价目 PRICE_TABLE，仅估算非账单）
      const daily = Object.entries(stats.daily || {}).map(([date, d]) => {
        let cost = 0;
        const models = [];
        for (const [m, mb] of Object.entries(d.models || {})) {
          const c = estimateCost(mb, m);
          cost += c;
          models.push({ model: m, calls: mb.calls, tokensIn: mb.tokensIn, tokensOut: mb.tokensOut, cacheRead: mb.cacheRead, cacheMiss: mb.cacheMiss, cost: Math.round(c * 10000) / 10000 });
        }
        models.sort((a, b) => b.cost - a.cost);
        return { date, calls: d.calls, tokensIn: d.tokensIn, tokensOut: d.tokensOut, cacheRead: d.cacheRead, cacheMiss: d.cacheMiss, cost: Math.round(cost * 10000) / 10000, models };
      }).sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
      const currentCost = Math.round(estimateCost(stats.byModel[State.endpoint.model] || emptyBucket(), State.endpoint.model) * 10000) / 10000;
      const totalCost = Math.round(Object.entries(stats.byModel).reduce((a, [m, b]) => a + estimateCost(b, m), 0) * 10000) / 10000;
      // 本对话统计（?chatId= 指定会话的完整桶；累计口径见 current/total）
      const qcid = (url.searchParams.get('chatId') || '').trim();
      const cb = qcid ? (stats.byChat[sanitizeId(qcid)] || null) : null;
      const chat = cb ? summarize(cb) : null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ model: State.endpoint.model, current: cur, total: t, chat, daily, currentCost, totalCost })); return true; };
    }
  return false;
}
async function h_api_emotions_58(req, res, url, p) {
  // 情绪追踪：查看（按会话聚合） / 设置 / 清除
    if (p === '/api/emotions' && req.method === 'GET') {
      const emo = buildEmotions(sanitizeId(url.searchParams.get('chatId') || ''));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ emotions: emo })); return true; };
    }
  return false;
}
async function h_api_regex_rules_27(req, res, url, p) {
  // 输出过滤器
    if (p === '/api/regex-rules' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,rules:State.regexRules})); return true; }; }
  return false;
}
async function h_api_regex_rules_28(req, res, url, p) {
  if (p === '/api/regex-rules' && req.method === 'POST') { let b=await readBody(req); try { const {action,rule}=JSON.parse(b); if(action==='save'){const id=rule?.id||'rule_'+Date.now(); const idx=State.regexRules.findIndex(r=>r.id===id); const nr={id,name:String(rule?.name||'').slice(0,40),pattern:rule?.pattern||'',replacement:rule?.replacement||'',flags:rule?.flags||'g',enabled:rule?.enabled!==false}; if(idx>=0)State.regexRules[idx]=nr; else State.regexRules.push(nr); saveRegexRules(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true,rule:nr})); return true; }; } if(action==='delete'){State.regexRules=State.regexRules.filter(r=>r.id!==rule?.id); saveRegexRules(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true})); } if(action==='test'){try{const re=new RegExp(rule?.pattern||'',rule?.flags||'g'); const result=(rule?.testText||'').replace(re,rule?.replacement||''); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,result}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'正则错误：'+e.message}));} } res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  return false;
}
async function h_api_suggestions_generate_29(req, res, url, p) {
  // 剧情建议
    if (p === '/api/suggestions/generate' && req.method === 'POST') { let b=await readBody(req); try { const {chatId}=JSON.parse(b); const cid=sanitizeId(chatId||''); const f=path.join(DATA_DIR,'chats',`${cid}.json`); if(!fs.existsSync(f)){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({error:'对话不存在'})); return true; };} const chat=JSON.parse(fs.readFileSync(f,'utf8')); const recent=(chat.messages||[]).slice(-10).map(m=>`${m.role==='user'?'用户':'AI'}：${String(m.content||'').slice(0,200)}`).join('\n'); const prompt=`你是一位 RP 剧情顾问。基于当前对话上下文，给出 3-5 条后续剧情发展方向建议。\n每条建议包含：\n- title：30 字以内的方向概述\n- detail：100-200 字的具体展开\n- mood：建议的氛围（日常/紧张/温馨/战斗/悬疑）\n\n当前对话：\n${recent}\n\n输出纯 JSON 数组，不要其他文字。`; const result=await auxCall(prompt); try{const sg=JSON.parse(result); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,suggestions:sg}));}catch(e){const m=result.match(/```(?:json)?\s*([\s\S]*?)```/); if(m){try{const sg=JSON.parse(m[1].trim()); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,suggestions:sg}));}catch(e2){}} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'AI 返回格式错误',raw:result.slice(0,500)}));} } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  return false;
}

module.exports = { h_api_stats_61, h_api_emotions_58, h_api_regex_rules_27, h_api_regex_rules_28, h_api_suggestions_generate_29 };
