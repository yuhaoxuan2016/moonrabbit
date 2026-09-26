// lib/core/state.js —— 全局可变状态单例（全仓唯一引用点）。
// 这里只放容器；各字段的初始值仍由 server.js 启动段逐条赋值，避免与启动顺序耦合。
const State = {};  // 原 let 全局变量统一收口，详见 AGENTS.md 变更日志

module.exports = { State };
