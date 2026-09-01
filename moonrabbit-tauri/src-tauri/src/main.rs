// Moonrabbit 桌面客户端（Tauri 2 · 方案A：spawn Node 后端 + WebView 加载 localhost）
// 启动流程：
//   1. spawn `node start.js`（cwd = rabbit-web-generic 目录），设 MOONRABBIT_PORT=3081
//   2. 轮询 http://127.0.0.1:3081 直到服务就绪
//   3. WebView 加载该地址
//   4. 退出时 kill 子进程
// 说明：本机自用，无安装器；node 用系统已装，不内置。

use std::process::{Child, Command};
use std::thread;
use std::time::Duration;
use std::net::TcpStream;

fn port_ready(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn wait_for_port(port: u16, timeout_secs: u64) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < timeout_secs {
        if port_ready(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn main() {
    let port: u16 = 3081;

    // moonrabbit 目录（moonrabbit-tauri/src-tauri/.. = moonrabbit-tauri 根；moonrabbit 代码在 ../rabbit-web-generic）
    // 开发环境：src-tauri 在 moonrabbit-tauri 下，rabbit-web-generic 在 rp2.0 根下
    let web_dir = std::path::Path::new("../../").join("rabbit-web-generic");

    let mut child: Option<Child> = None;

    #[cfg(target_os = "windows")]
    {
        child = Command::new("node.exe")
            .arg("start.js")
            .current_dir(&web_dir)
            .env("MOONRABBIT_PORT", "3081")
            .spawn()
            .ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        child = Command::new("node")
            .arg("start.js")
            .current_dir(&web_dir)
            .env("MOONRABBIT_PORT", "3081")
            .spawn()
            .ok();
    }

    // 等端口就绪（最长 30 秒）
    if !wait_for_port(port, 30) {
        eprintln!("[moonrabbit] 服务未在 {} 秒内就绪，可能缺少 Node 或 start.js", 30);
    }

    // 启动 Tauri GUI，WebView 加载 localhost
    let app = tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // 退出时清理子进程
    if let Some(mut c) = child {
        let _ = c.kill();
    }
    drop(app);
}
