// lib/core/price.js —— 模型价目与费用估算（仅估算，非账单）。

const PRICE_TABLE = {
  'deepseek-chat': { input: 1, output: 2, cacheHit: 0.1 },
  'deepseek-v4-flash': { input: 1, output: 2, cacheHit: 0.1 },
  'deepseek-v4-pro': { input: 4, output: 16, cacheHit: 0.4 },
  'default': { input: 2, output: 8, cacheHit: 0.2 },
};
function priceFor(model) { return PRICE_TABLE[model] || PRICE_TABLE['default']; }
// 估算费用（元）：缓存命中 token 按 cacheHit 单价，其余输入按 input 单价，输出按 output 单价
function estimateCost(bucket, model) {
  const p = priceFor(model);
  const cacheTotal = (bucket.cacheRead || 0) + (bucket.cacheMiss || 0);
  const inCost = cacheTotal > 0
    ? ((bucket.cacheMiss || 0) / 1e6) * p.input + ((bucket.cacheRead || 0) / 1e6) * p.cacheHit
    : ((bucket.tokensIn || 0) / 1e6) * p.input;   // 旧数据无缓存字段 → 全按输入价
  return inCost + ((bucket.tokensOut || 0) / 1e6) * p.output;
}
module.exports = { PRICE_TABLE, priceFor, estimateCost };
