// start.js —— auto-detect a free port and launch server.js
// 用法：node start.js （或双击 start.bat）
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const START_PORT = Number(process.env.MOONRABBIT_PORT || 3081);
const MAX_PORT = START_PORT + 20;

function portFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    // E-12 修复（2026-09-06）：探测按全接口监听，比 server.js 实际绑定（127.0.0.1）宽——
    // 仅可能多跳一个端口（过保守、无害），但不会漏探「已被 IPv6-only 进程占用」的假空闲。
    srv.listen(p);
  });
}

(async () => {
  let port = START_PORT;
  for (; port <= MAX_PORT; port++) {
    if (await portFree(port)) break;
  }
  if (port > MAX_PORT) {
    console.error(`端口 ${START_PORT}-${MAX_PORT} 均被占用，请设置 MOONRABBIT_PORT 指定端口后重试。`);
    process.exit(1);
  }
  console.log(`使用端口 ${port} → http://127.0.0.1:${port}`);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, MOONRABBIT_PORT: String(port) },
  });
  // E-12 修复：子进程被信号杀死（code==null）时以非零码退出，不再掩盖崩溃
  child.on('exit', (code, signal) => {
    if (code != null) process.exit(code);
    process.exit(signal ? 1 : 0);
  });
})();
