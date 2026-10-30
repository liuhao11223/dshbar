// DSHBar · 把渲染层静态资源（index.html / renderer.css）复制到 dist/renderer。
// tsc 不会复制非 TS 文件，而主进程加载的是 dist/renderer/index.html，因此需要这一步。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'renderer');
const outDir = path.join(root, 'dist', 'renderer');

for (const name of ['index.html', 'renderer.css']) {
  const src = path.join(srcDir, name);
  const dest = path.join(outDir, name);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}