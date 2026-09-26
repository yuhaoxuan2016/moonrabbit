// lib/llm/main.js —— M-08·llm-main 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const { State } = require('../core/state');

async function auxCall(sys, userText, maxTokens, extraBody) {
  const aux = auxEffective();
  if (aux) {
    try {
      return await auxEnqueue(() => completeText(aux, sys, userText, maxTokens, extraBody));
    } catch (e) {
      if (!State.aux.fallback) throw new Error(`辅助 API 失败（未回退主端点）: ${e.message}`);
      console.log('[aux] 辅助端点失败，回退主端点:', e.message);
    }
  }
  return completeText(State.endpoint, sys, userText, maxTokens, extraBody);
}
function auxEnqueue(task) {
  const run = State.auxQueue.then(task, task);   // 前一任务失败也继续执行下一任务
  State.auxQueue = run.catch(() => {});
  return run;
}
function auxEffective() {
  if (State.aux.enabled && State.aux.baseURL && State.aux.model && State.aux.apiKey) return State.aux;
  return null;
}
async function completeText(ep, sys, userText, maxTokens, extraBody) {
  // 当 userText 为空时，把 sys 作为唯一 user 内容发送（避免 content 为空导致部分端点 400）
  // 适用于「纯指令型」prompt（如剧情建议/回顾报告/自检/回溯），此时 sys 即完整指令
  const hasUser = typeof userText === 'string' && userText.trim().length > 0;
  if (ep.protocol === 'openai') {
    const msgs = hasUser
      ? [{ role: 'system', content: sys }, { role: 'user', content: userText }]
      : [{ role: 'user', content: sys }];
    const r = await fetch(`${ep.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model: ep.model, messages: msgs, max_tokens: maxTokens, ...(extraBody || {}) }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '').trim();
  }
  const msgs = hasUser
    ? [{ role: 'user', content: userText }]
    : [{ role: 'user', content: sys }];
  const r = await fetch(`${ep.baseURL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ep.model, system: hasUser ? sys : undefined, messages: msgs, max_tokens: maxTokens, ...(extraBody || {}) }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.content || []).map((b) => b.text || '').join('').trim();
}

module.exports = { auxCall, auxEnqueue, auxEffective, completeText };
