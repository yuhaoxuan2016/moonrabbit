// lib/http/handlers/static.js —— 静态资源与站点根路由。
const fs = require('fs');
const path = require('path');
const { WWW } = require('../../core/paths');
const { sendFile } = require('../respond');

async function h_route_0(req, res, url, p) {
  if (p === '/' || p === '/index.html') { sendFile(res, path.join(WWW, 'index.html')); return true; };
  return false;
}

// 品牌图片（favicon / logo / 分享图）不属于仓库内容：缺图时 favicon 与分享图回落到随仓库发布的中性占位件，
// logo 直接 404（前端 <img> 自带 onerror 隐藏，只留站名）——所以「没有自己的图」也能正常跑。
const ASSET_FALLBACK = { 'favicon.png': 'placeholder.png', 'share-card.png': 'placeholder-share.png' };
function assetPath(name) {
  const own = path.join(WWW, name);
  if (fs.existsSync(own)) return own;
  const fb = ASSET_FALLBACK[name];
  return fb ? path.join(WWW, fb) : own;
}

async function h_favicon_ico_1(req, res, url, p) {
  if (p === '/favicon.ico' || p === '/favicon.png') { sendFile(res, assetPath('favicon.png'), 'image/png'); return true; };
  return false;
}

async function h_logo_png_2(req, res, url, p) {
  if (p === '/logo.png') { sendFile(res, path.join(WWW, 'logo.png'), 'image/png'); return true; };
  return false;
}

async function h_share_card_png_3(req, res, url, p) {
  if (p === '/share-card.png') { sendFile(res, assetPath('share-card.png'), 'image/png'); return true; };
  if (p === '/placeholder.png' || p === '/placeholder-share.png') { sendFile(res, path.join(WWW, p.slice(1)), 'image/png'); return true; };
  return false;
}

async function h_style_css_4(req, res, url, p) {
  if (p === '/style.css') { sendFile(res, path.join(WWW, 'style.css')); return true; };
  return false;
}

async function h_app_js_5(req, res, url, p) {
  // 2026-09-27：前端拆为 app/ 目录下按序加载的多个模块，故本路由从「只认 /app.js」
  // 放宽为「/app.js 与 /app/<name>.js」。字符集限 [\w.-] 且不放行 '/'，无法穿越出 app/。
  const m = /^\/(app\.js|app\/[\w.-]+\.js)$/.exec(p);
  if (m) { sendFile(res, path.join(WWW, m[1])); return true; };
  return false;
}
module.exports = { h_route_0, h_favicon_ico_1, h_logo_png_2, h_share_card_png_3, h_style_css_4, h_app_js_5 };
