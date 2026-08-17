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
    // 不带 host = 与 server.js 相同绑定（IPv6 dual-stack ::），确保探测结果与真实启动一致
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
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
})();
