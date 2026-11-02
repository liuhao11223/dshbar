/**
 * DSHBar · 渲染层离线预览服务器。
 *
 * 为什么需要它：本机（以及 CI/沙箱）里直接起 Electron 常常起不来
 * （Chromium 沙箱初始化被拒 → 进程静默退出），于是悬浮条的布局、字形、
 * 圆环里的时间有没有溢出，全都无法目视核对。这个脚本只依赖 Node 内置
 * 模块，把 dist/renderer 用 http 暴露出去，并把 index.html 现场改成
 * 「可调试的预览页」（注入 preload 打桩 + 把 360×42 的卡片放到一块浅色
 * 舞台上），然后用任意浏览器打开即可截图、量尺寸。
 *
 * 用法：
 *   node scripts/preview-renderer.cjs            # 需要先跑过 tsc
 *   node scripts/preview-renderer.cjs --port 8791
 *
 * 打开 http://127.0.0.1:<port>/renderer/__preview.html ，在控制台用
 * stub.js 顶部的钩子（__setTitle / __setTime / __setTasks / __setDragging）造场景。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STUB = path.join(__dirname, 'preview', 'stub.js');

const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8791;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// 预览页 = 真 index.html + 打桩脚本 + 一块浅色舞台（卡片仍按 360×42 布局）
const PREVIEW_PATCH = `<script src="/__stub.js"></script>
    <style>
      html, body { width: 100%; height: 100%; background: #dfe4ee; }
      #app { position: absolute; left: 20px; top: 20px; width: 360px; height: 42px; }
    </style>
  </head>`;

function previewHtml() {
  const index = fs.readFileSync(path.join(DIST, 'renderer', 'index.html'), 'utf8');
  if (!index.includes('</head>')) throw new Error('dist/renderer/index.html 没有 </head>');
  return index.replace('</head>', PREVIEW_PATCH);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);

    if (url === '/') {
      // 预览页必须挂在 /renderer/ 下，否则 index.html 里的相对路径
      // （./renderer.js、./renderer.css）会解析到站点根目录而 404。
      res.writeHead(302, { location: '/renderer/__preview.html' });
      res.end();
      return;
    }
    if (url === '/renderer/__preview.html') {
      try {
        send(res, 200, MIME['.html'], previewHtml());
      } catch (err) {
        send(res, 500, 'text/plain; charset=utf-8', `预览页生成失败：${err.message}\n先跑 npm run build 或 tsc。`);
      }
      return;
    }
    if (url === '/__stub.js') {
      send(res, 200, MIME['.js'], fs.readFileSync(STUB));
      return;
    }

    const file = path.join(DIST, url);
    if (!path.resolve(file).startsWith(path.resolve(DIST))) {
      send(res, 403, 'text/plain', 'forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        send(res, 404, 'text/plain', `not found: ${url}`);
        return;
      }
      send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', buf);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`DSHBar 渲染层预览： http://127.0.0.1:${PORT}/renderer/__preview.html`);
    console.log('（Ctrl+C 退出；页面里的调试钩子见 scripts/preview/stub.js）');
  });
