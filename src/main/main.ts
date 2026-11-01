/**
 * DSHBar · Electron 主进程：窗口、托盘、全局快捷键、开机自启、IPC。
 *
 * 职责边界：
 * - 本进程不启动 MCP 服务器（MCP 由 DSH 通过 dshbar-mcp 独立 stdio 启动）。
 * - 所有写盘路径只走 StoreAdapter（基于 defaultStorePath()）。
 * - 崩溃兜底：记录日志但不退出。
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ipcMain,
  screen,
  dialog,
  clipboard,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  StoreAdapter,
  defaultStorePath,
  foldRunningSegments,
  mergeStoreFiles,
} from '../shared/store';
import type {
  StoreFile,
  TaskAction,
  Settings,
  Lang,
  WindowMode,
  DockSide,
} from '../shared/types';

const WIDTH = 360;
// 展开态高度：72 → 54 → 42。卡片里的圆环/按钮/字号在 renderer.css 同步收小，
// 两处尺寸必须一起改，否则内容会被裁切。
const EXPANDED_HEIGHT = 42;
const COLLAPSED_HEIGHT = 6;
const HOTKEY_DEFAULT = 'Alt+W';

const APP_DIR = path.dirname(defaultStorePath());
const LOG_FILE = path.join(APP_DIR, 'error.log');

/* ------------------------------------------------------------------ */
/* 崩溃兜底：记录日志，不退出（模块作用域，确保启动阶段也能被捕获）           */
/* ------------------------------------------------------------------ */
function logError(err: unknown): void {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${String(err)}\n`, 'utf-8');
  } catch {
    /* 忽略日志失败 */
  }
}

process.on('uncaughtException', (err) => {
  logError(err);
});
process.on('unhandledRejection', (reason) => {
  logError(reason);
});

/* ------------------------------------------------------------------ */
/* GPU 兜底（必须在 app ready 之前做）                                   */
/* ------------------------------------------------------------------ */
// 背景：在显卡驱动异常 / 虚拟机 / 远程桌面 / 受限沙箱里，Chromium 的 GPU
// 子进程可能起不来。Electron 的默认行为不是降级，而是直接
//   FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:389]
//   GPU process isn't usable. Goodbye.
// 崩溃退出（Windows 事件查看器里表现为 DSHBar.exe 异常代码 0x80000003）。
// 用户看到的现象就是「双击没反应 / 闪一下就没了」。
//
// 这个工具只是一个 360x42 的静态卡片 + 每秒刷新一次时间，完全不需要硬件
// 加速，因此默认关掉 GPU 走软件渲染是最稳的选择。想用硬件加速的话设
// DSHBAR_GPU=1。
if (process.env.DSHBAR_GPU !== '1') {
  try {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    // GPU 进程本身也可能是被沙箱挡住起不来的（"GPU process isn't usable"），
    // 这个开关让 GPU 进程不再套沙箱，是对上面那条致命错误最直接的兜底。
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  } catch (err) {
    logError(err);
  }
}

// 启动自检日志：写到 error.log 同目录的 startup.log（每次启动重写）。
// 目的是让「双击没反应」这类问题留下痕迹——原生崩溃（例如 GPU 进程起不来）
// 发生在 JS 之外，只有这种落盘日志能告诉用户/我们进程走到了哪一步。
// DEBUG_DSHBAR=1 时同时把细节追加到 trace.log。
function trace(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.appendFileSync(path.join(APP_DIR, 'startup.log'), line, 'utf-8');
  } catch {
    /* 忽略 */
  }
  if (process.env.DEBUG_DSHBAR === '1') {
    try {
      fs.appendFileSync(path.join(APP_DIR, 'trace.log'), line, 'utf-8');
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 单实例锁。
 *
 * 必须在 `app.setPath('userData', ...)` **之后**获取：Electron 的单实例锁会往
 * userData 目录里写锁文件，若该目录不存在或不可写，`requestSingleInstanceLock()`
 * 会在进程启动阶段直接硬崩溃（无 stdout/stderr、无错误日志）。
 * 因此这里先声明、稍后赋值，赋值点在 prepareUserDataDir() 之后。
 */
let gotLock = false;

/** 托盘图标：打包后位于 resources（extraResources），开发时位于项目 assets。 */
function trayIconPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'tray.ico'),
    path.join(__dirname, '..', '..', 'assets', 'tray.ico'),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

// 桌面端状态（模块级，供 IPC / 托盘 / 节拍等回调共享）
let adapter = new StoreAdapter();

// 首次运行判定必须**在**下面这次 adapter.load() 之前完成：
// load() 在文件不存在时会顺手把空 store 落盘，之后再判断就永远是「已存在」了。
const STORE_EXISTED_AT_LAUNCH = (() => {
  try {
    return fs.existsSync(defaultStorePath());
  } catch {
    return true;
  }
})();

let storeCache: StoreFile = adapter.load();
let lastTickSec: number | null = null;
let currentLang: Lang = storeCache.settings.lang;
let hotkey = storeCache.settings.hotkey || HOTKEY_DEFAULT;
let collapsed = true; // 默认开机为收起态（首次运行会展开，见 bootstrap）

// 桌面端（GUI）是 DSHBar.exe 的唯一入口：双击或开机自启都走 bootstrap()。
// MCP 服务器由 DSH 通过 PATH 上的 `dshbar-mcp` 命令以**独立 Node 进程**以 stdio
// 方式启动，与本进程完全解耦（二者只共享 store.json）。因此这里不再有任何
// "Electron 无窗口 MCP 模式" 分支 —— Electron 主进程不接 stdio、Chromium 也
// 拒绝未注册的命令行开关，MCP 绝不能在 DSHBar.exe 内启动。
//
// 注意：bootstrap() **不在模块顶层调用**（否则 store 目录不可写时会在
// app.whenReady() 之前同步抛错、进程静默退出）。调用统一走文件底部的
// `app.whenReady().then(...)`，并用 try/catch 兜底，启动失败也会弹框+记日志。

/**
 * 为 Electron 选一个**可写**的 userData 目录。
 *
 * Chromium 默认把 userData 放在 `%APPDATA%\electron`（或 `%APPDATA%\<productName>`）。
 * 如果那个目录不可写（漫游配置被重定向/只读、企业策略、sandbox、磁盘满），
 * Chromium 会在 `app.whenReady()` 阶段直接崩溃退出，进程不打印任何错误——
 * 表现就是「双击图标闪一下就没了」。
 *
 * 这里主动探测候选目录，取第一个真正能创建并写入的；全部不可写时退回
 * 系统临时目录（至少保证 GUI 能起来，而不是静默闪退）。
 *
 * 必须在 `app.whenReady()` **之前**调用：Chromium 会在 ready 阶段去初始化
 * profile 目录，路径选晚了就已经晚了。
 */
function prepareUserDataDir(): void {
  const candidates: string[] = [];
  const envDir = process.env.DSHBAR_USER_DATA;
  if (envDir && envDir.trim().length > 0) candidates.push(envDir.trim());
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  // 注意用**子目录** userdata：Chromium 会在这个目录里不停写缓存/数据库，
  // 和我们的 store.json / 日志混在同一个目录里既脏又会让目录监听频繁抖动。
  if (appData) candidates.push(path.join(appData, 'DSHBar', 'userdata'));
  candidates.push(path.join(os.tmpdir(), 'DSHBar-userdata'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      // 只用 app.setPath：Electron 官方 API。
      // 注意不要用 app.commandLine.appendSwitch('user-data-dir', ...) ——
      // 实测在 ready 阶段追加该开关会导致 Chromium profile 初始化崩溃
      // （进程直接退出，无任何日志）。
      app.setPath('userData', dir);
      return;
    } catch {
      /* 试下一个候选目录 */
    }
  }
  // 全部不可写：保持 Electron 默认值，至少不额外制造问题。
}

// 必须在 ready 之前完成（见上面的说明）。
try {
  // 每次启动重写 startup.log，避免无限增长
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(path.join(APP_DIR, 'startup.log'), '', 'utf-8');
  } catch {
    /* 忽略 */
  }
  prepareUserDataDir();
  trace('userData prepared: ' + app.getPath('userData'));
} catch (err) {
  logError(err);
}

// 单实例锁：必须在 userData 路径确定之后获取（见上方 gotLock 的注释）。
gotLock = app.requestSingleInstanceLock();
trace('module loaded, gotLock=' + gotLock);
if (!gotLock) {
  // 已有实例在运行：本次启动直接退出，由已运行实例聚焦到前台。
  app.quit();
}

/* ------------------------------------------------------------------ */
/* 托盘文案（原生菜单，与渲染层 i18n 相互独立）                           */
/* ------------------------------------------------------------------ */
const trayI18n: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    showHide: '显示 / 隐藏',
    language: '语言',
    followSystem: '跟随系统',
    zh: '中文',
    en: 'English',
    autostart: '开机自启',
    hotkey: '全局快捷键',
    mcpReady: 'MCP：已就绪',
    mcpCopy: '复制 MCP 接入配置',
    mcpCopied: 'MCP 配置已复制到剪贴板',
    mcpMissing: 'MCP：未检测到 dshbar-mcp',
    mcpHelp: '查看接入说明',
    quit: '退出',
  },
  en: {
    showHide: 'Show / Hide',
    language: 'Language',
    followSystem: 'System',
    zh: '中文',
    en: 'English',
    autostart: 'Launch at Login',
    hotkey: 'Global Hotkey',
    mcpReady: 'MCP: ready',
    mcpCopy: 'Copy MCP config',
    mcpCopied: 'MCP config copied to clipboard',
    mcpMissing: 'MCP: dshbar-mcp not found',
    mcpHelp: 'How to connect',
    quit: 'Quit',
  },
};

function trayText(key: string): string {
  return trayI18n[currentLang === 'en' ? 'en' : 'zh'][key] ?? key;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function targetBounds(): { width: number; height: number } {
  return { width: WIDTH, height: collapsed ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT };
}

/** 是否还有「用户此刻应该看到」的任务：pending / running / paused。
 *
 * completed 是历史记录（渲染层也不显示它），aborted 只是留档，两者都不该让
 * 悬浮条保持展开；有这两类以外的任务时，收起成 6px 细线就等于「看不见」。
 */
function isOpenStatus(status: StoreFile['tasks'][number]['status']): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

function hasOpenTask(file: StoreFile): boolean {
  return file.tasks.some((t) => isOpenStatus(t.status));
}

/** 窗口当前所在的显示器（多显示器时不要总是用主屏）。 */
function displayForWindow(): Electron.Display {
  if (win) {
    try {
      return screen.getDisplayMatching(win.getBounds());
    } catch {
      /* 落到主屏 */
    }
  }
  return screen.getPrimaryDisplay();
}

/** 吸附边：窗口贴着工作区上/下边（容差 2px）时认为 docked，否则自由悬浮。
 *
 * 用途：收起态的 6px 细线要贴着对应屏幕边（靠下边时细线在窗口底部），
 * 而不是永远画在窗口顶部。
 */
let dockSide: DockSide = 'top';

function computeDockSide(): DockSide {
  if (!win || win.isDestroyed()) return dockSide;
  const area = displayForWindow().workArea;
  const b = win.getBounds();
  if (Math.abs(b.y - area.y) <= 2) return 'top';
  if (Math.abs(b.y + b.height - (area.y + area.height)) <= 2) return 'bottom';
  return 'free';
}

function emitDock(): void {
  win?.webContents.send('ui:dockChanged', dockSide);
}

/** 平滑地修正窗口尺寸：保持当前左上角位置不变，只改高度。
 *
 * 之前在每次展开 / 收起时都重新计算「主屏水平居中」，导致两个问题：
 * 1. 用户把卡片拖到别处后，一收起 / 一展开就跳回屏幕中间；
 * 2. 在副屏上操作时窗口会跳回主屏。
 * 现在只在窗口还不存在（首次创建）时才居中。
 * 靠下边吸附时高度向上生长（底边不动），细线才能继续贴住屏幕下沿。
 */
function applyBounds(): void {
  if (!win) return;
  const { height } = targetBounds();
  const area = displayForWindow().workArea;
  const cur = win.getBounds();
  const x = Math.max(area.x, Math.min(area.x + area.width - WIDTH, cur.x));
  let y = Math.max(area.y, Math.min(area.y + area.height - height, cur.y));
  if (dockSide === 'bottom') y = Math.max(area.y, cur.y + cur.height - height);
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height });
}

function setCollapsed(next: boolean): void {
  if (collapsed === next) return;
  collapsed = next;
  applyBounds();
  emitMode();
}

function emitMode(): void {
  const mode: WindowMode = collapsed ? 'collapsed' : 'expanded';
  win?.webContents.send('ui:modeChanged', mode);
}

/** 系统拖动（-webkit-app-region）期间窗口变成圆形时间盘。
 *
 * 拖动开始（'will-move'）把窗口收成 DRAG_SIZE 的正方并以光标为中心；
 * 拖动循环里每次 'moved' 都重新居中到光标，让圆盘跟着指针走；
 * 250ms 没有移动视为拖动结束，恢复长条并以光标为中心落位，
 * 顺带重算吸附边（可能正好落在屏幕下沿）。
 *
 * 不用 mousedown/mouseup 判定拖动：按钮也在窗口里，mousedown 会把
 * 一次普通点击也变成「缩成圆」，点击就废了。'will-move' 只在窗口
 * 真正进入移动循环时触发。
 */
const DRAG_SIZE = 64;
let dragging = false;
let dragEndTimer: NodeJS.Timeout | null = null;

function centerOnCursor(size: number): void {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const nx = Math.round(c.x - size / 2);
  const ny = Math.round(c.y - size / 2);
  if (b.x !== nx || b.y !== ny || b.width !== size || b.height !== size) {
    win.setBounds({ x: nx, y: ny, width: size, height: size });
  }
}

function setDragging(next: boolean): void {
  if (dragging === next) return;
  dragging = next;
  try {
    if (win && !win.isDestroyed()) {
      if (next) {
        centerOnCursor(DRAG_SIZE);
      } else {
        const h = collapsed ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT;
        const c = screen.getCursorScreenPoint();
        const area = displayForWindow().workArea;
        const x = Math.max(area.x, Math.min(area.x + area.width - WIDTH, Math.round(c.x - WIDTH / 2)));
        const y = Math.max(area.y, Math.min(area.y + area.height - h, Math.round(c.y - h / 2)));
        win.setBounds({ x, y, width: WIDTH, height: h });
        const side = computeDockSide();
        if (side !== dockSide) {
          dockSide = side;
          emitDock();
        }
      }
    }
  } catch (err) {
    logError(err);
  }
  win?.webContents.send('ui:dragChanged', dragging);
}

function attachDragTracking(): void {
  if (!win) return;
  win.on('moved', () => {
    if (dragging) {
      centerOnCursor(DRAG_SIZE);
      if (dragEndTimer) clearTimeout(dragEndTimer);
      dragEndTimer = setTimeout(() => setDragging(false), 250);
      return;
    }
    const side = computeDockSide();
    if (side !== dockSide) {
      dockSide = side;
      emitDock();
    }
  });
  win.on('will-move', () => {
    setDragging(true);
    if (dragEndTimer) clearTimeout(dragEndTimer);
    dragEndTimer = setTimeout(() => setDragging(false), 250);
  });
}

function broadcast(): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('store:changed', storeCache);
  }
}

/** 外部（DSH 对话里的 MCP）新增任务时把悬浮条亮出来。
 *
 * 只 broadcast 数据是不够的：悬浮条平时是 6px 细线，还可能被别的置顶窗口
 * 压住，用户会以为「任务根本没出现在界面上」。这里把窗口重新推到最前，
 * 并从细线展开成卡片，让新任务真的被看见。
 */
function revealIncomingTask(title: string): void {
  trace('incoming task: ' + title);
  try {
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
    if (collapsed) setCollapsed(false);
    else applyBounds();
  } catch (err) {
    logError(err);
  }
}

function createWindow(): void {
  const bounds = targetBounds();
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: Math.round(workArea.x + (workArea.width - bounds.width) / 2),
    y: workArea.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  attachDragTracking();

  // 显示窗口：透明窗口的 `ready-to-show` 在部分环境（软件渲染、无 GPU、
  // 某些远程桌面会话）不会触发，只靠它会出现「进程在跑但看不见任何东西」。
  // 因此这里用三条互相兜底的路径，任意一条先到就先显示。
  let shown = false;
  const reveal = (why: string): void => {
    if (shown) return;
    shown = true;
    try {
      win?.showInactive();
      dockSide = computeDockSide();
      emitMode();
      emitDock();
      trace('window revealed via ' + why);
    } catch (err) {
      logError(err);
    }
  };

  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  setTimeout(() => reveal('timeout-fallback'), 1500);

  // 渲染层加载失败也要留痕（否则表现为「空白 / 看不见」）
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError(`renderer load failed: code=${code} desc=${desc} url=${url}`);
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */
function buildTrayMenu(mcpLauncher: string | null): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: trayText('showHide'),
      click: () => setCollapsed(!collapsed),
    },
    { type: 'separator' },
    {
      label: trayText('language'),
      submenu: [
        {
          label: trayText('followSystem'),
          type: 'radio',
          checked: currentLang === 'system',
          click: () => updateLang('system'),
        },
        {
          label: trayText('zh'),
          type: 'radio',
          checked: currentLang === 'zh',
          click: () => updateLang('zh'),
        },
        {
          label: trayText('en'),
          type: 'radio',
          checked: currentLang === 'en',
          click: () => updateLang('en'),
        },
      ],
    },
    {
      // type:checkbox 自带勾选，标题里不要再拼一个 ✓（截图中出现过双勾）
      label: trayText('autostart'),
      type: 'checkbox',
      checked: storeCache.settings.launchAtLogin,
      click: (item) => updateLaunchAtLogin(Boolean(item.checked)),
    },
    {
      label: `${trayText('hotkey')}: ${hotkey}`,
      click: () => promptHotkey(),
    },
    { type: 'separator' },
    ...(mcpLauncher
      ? ([
          {
            // 启动器完整路径放子菜单里：直接拼在主菜单行上会把整个
            // 菜单撑到一屏宽（用户截图反馈）。悬停才展开看细节。
            label: trayText('mcpReady'),
            submenu: [
              {
                label: path.dirname(mcpLauncher),
                enabled: false,
              },
              {
                label: trayText('mcpCopy'),
                click: () => copyMcpConfig(),
              },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : ([
          {
            label: trayText('mcpMissing'),
            enabled: false,
          },
        ] as MenuItemConstructorOptions[])),
    { type: 'separator' },
    {
      label: trayText('quit'),
      click: () => {
        app.quit();
      },
    },
  ];
  return Menu.buildFromTemplate(template);
}

function createTray(): void {
  let image = nativeImage.createEmpty();
  try {
    const iconPath = trayIconPath();
    if (fs.existsSync(iconPath)) {
      const loaded = nativeImage.createFromPath(iconPath);
      if (!loaded.isEmpty()) image = loaded;
    }
  } catch {
    /* 图标缺失时使用空图，托盘仍可存在 */
  }
  tray = new Tray(image);
  tray.setToolTip('DSHBar');
  const mcpLauncher = resolveMcpLauncher();
  tray.setContextMenu(buildTrayMenu(mcpLauncher));
  tray.on('double-click', () => setCollapsed(!collapsed));
}

/* ------------------------------------------------------------------ */
/* 设置与持久化                                                        */
/* ------------------------------------------------------------------ */
function persistSettings(patch: Partial<Settings>): StoreFile {
  const next = adapter.mutate((s) => {
    s.settings = { ...s.settings, ...patch };
  });
  storeCache = next;
  return next;
}

function updateLang(lang: Lang): void {
  currentLang = lang;
  persistSettings({ lang });
  refreshTrayMenu();
  broadcast(); // 渲染层立即按新语言刷新
}

function updateLaunchAtLogin(openAtLogin: boolean): void {
  persistSettings({ launchAtLogin: openAtLogin });
  app.setLoginItemSettings({ openAtLogin });
  refreshTrayMenu();
  broadcast();
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu(resolveMcpLauncher()));
}

/* ------------------------------------------------------------------ */
/* 全局快捷键                                                          */
/* ------------------------------------------------------------------ */
function registerHotkey(accelerator: string): boolean {
  globalShortcut.unregisterAll();
  hotkey = accelerator;
  try {
    const ok = globalShortcut.register(accelerator, () => setCollapsed(!collapsed));
    if (!ok) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'DSHBar',
        message: `快捷键冲突：${accelerator} 已被其他应用占用，已回退到 ${HOTKEY_DEFAULT}。`,
      });
      hotkey = HOTKEY_DEFAULT;
      globalShortcut.register(HOTKEY_DEFAULT, () => setCollapsed(!collapsed));
      return false;
    }
    return true;
  } catch {
    dialog.showMessageBox({
      type: 'warning',
      title: 'DSHBar',
      message: `无法注册快捷键 ${accelerator}，已回退到 ${HOTKEY_DEFAULT}。`,
    });
    hotkey = HOTKEY_DEFAULT;
    try {
      globalShortcut.register(HOTKEY_DEFAULT, () => setCollapsed(!collapsed));
    } catch {
      /* 仍失败则忽略 */
    }
    return false;
  }
}

function promptHotkey(): void {
  const current = hotkey;
  dialog
    .showMessageBox({
      type: 'question',
      title: 'DSHBar',
      message: '当前快捷键：' + current,
      detail: '快捷键可在 DSHBar 的 store.json 中修改 hotkey 字段（如 Ctrl+Shift+Space）。',
      buttons: ['确定'],
    })
    .then(() => {
      /* 仅提示当前值；改动走 settings */
    });
}

/* ------------------------------------------------------------------ */
/* 计时节拍：在内存中累计 running 任务的 elapsedSeconds，并广播给渲染层  */
/* ------------------------------------------------------------------ */
function startTick(): void {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    // 仅推进 running；pending/paused/completed/aborted 一律不计入运行节拍。
    //
    // 这里用「段折叠」而不是「按固定增量累加」：折叠把当前计时段并入
    // elapsedSeconds 并把 startedAt 顺延到当前时刻，折叠前后
    // 「此刻已投入秒数」不变。这样 MCP 侧用 `now - startedAt` 推算时
    // 不会和这里的落盘重复计算，两边读到的总时长始终一致。
    if (!storeCache.tasks.some((t) => t.status === 'running')) return;

    const nowMs = Date.now();
    const folded = foldRunningSegments(storeCache, nowMs);
    if (folded === storeCache) return;

    // 落盘前先合并磁盘上的最新内容：MCP 可能刚刚修改了任务状态（例如
    // 把任务标记为 completed），直接覆盖会把它的改动抹掉。
    let toWrite = folded;
    try {
      const disk = adapter.load();
      toWrite = mergeStoreFiles(disk, folded, nowMs);
    } catch {
      /* 读盘失败就用内存版本 */
    }
    storeCache = toWrite;
    adapter.write(toWrite); // 每秒原子落盘，保证崩溃也不丢已投入秒数
    broadcast();
  }, 1000);
}

/* ------------------------------------------------------------------ */
/* MCP 启动器解析（仅提示 / 复制配置，不启动进程）                        */
/* ------------------------------------------------------------------ */

/**
 * 找到 dshbar-mcp 启动器的绝对路径。
 *
 * 关键点：**先看应用自带的 resources**，再看 PATH。
 * 免安装版不会写 PATH，安装版也要等下一个进程才会拿到新 PATH（DSHBar 自己
 * 是安装器启动的，继承的是旧环境变量），所以只查 PATH 会误报「未检测到」——
 * 而 resources\dshbar-mcp.cmd 是随包发的，永远存在。
 */
function resolveMcpLauncher(): string | null {
  const names = process.platform === 'win32' ? ['dshbar-mcp.cmd', 'dshbar-mcp.exe'] : ['dshbar-mcp'];

  for (const name of names) {
    try {
      const own = path.join(process.resourcesPath, name);
      if (fs.existsSync(own)) return own;
    } catch {
      /* 忽略 */
    }
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      try {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* 忽略 */
      }
    }
  }
  return null;
}

function detectMcp(): boolean {
  return resolveMcpLauncher() !== null;
}

/** 生成可直接粘进 DSH 的 MCP 配置片段（用绝对路径，绕开 PATH 问题）。 */
function mcpConfigSnippet(launcher: string): string {
  return JSON.stringify(
    { mcpServers: { dshbar: { command: launcher, type: 'stdio', args: [] } } },
    null,
    2,
  );
}

function copyMcpConfig(): void {
  const launcher = resolveMcpLauncher();
  if (!launcher) return;

  // 免安装版每次启动都把程序解压到临时目录，那里拷出来的绝对路径下次就失效了。
  const tmpRoot = path.resolve(os.tmpdir()).toLowerCase();
  if (path.resolve(launcher).toLowerCase().startsWith(tmpRoot)) {
    void dialog.showMessageBox({
      type: 'info',
      title: 'DSHBar',
      message: '当前是免安装版，启动器在临时目录中',
      detail:
        '免安装版每次运行都会解压到临时目录，复制出来的绝对路径在重启后会失效。\n' +
        '建议改用安装版（会把 dshbar-mcp 写进 PATH），' +
        '或把 command 指向一个固定目录下的 dshbar-mcp.cmd。',
      buttons: ['知道了'],
    });
    return;
  }

  clipboard.writeText(mcpConfigSnippet(launcher));
  tray?.displayBalloon?.({
    title: 'DSHBar',
    content: `${trayText('mcpCopied')}\n${launcher}`,
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */
function registerIpc(): void {
  ipcMain.handle('store:get', () => storeCache);

  ipcMain.handle('store:mutate', (_e, action: TaskAction) => {
    const prevLang = storeCache.settings.lang;
    const prevHotkey = storeCache.settings.hotkey;
    const prevLogin = storeCache.settings.launchAtLogin;
    const next = adapter.mutate((draft) => {
      // 渲染层把任务切走（暂停 / 完成 / 取消）时，必须先折叠当前计时段，
      // 否则这段时长既被 GUI 的节拍记过、又被 MCP 的 `now - startedAt` 推算一遍，
      // 造成重复计时。这里与 MCP 侧的 stopSegment 语义完全一致。
      if (action.type === 'update') {
        const target = draft.tasks.find((t) => t.id === action.id);
        if (target && target.status === 'running' && action.patch.status && action.patch.status !== 'running') {
          const ts = Date.now();
          const started = target.startedAt ? Date.parse(target.startedAt) : NaN;
          const elapsed = Number.isNaN(started)
            ? target.elapsedSeconds
            : Math.round((target.elapsedSeconds + Math.max(0, (ts - started) / 1000)) * 100) / 100;
          return {
            type: 'update',
            id: action.id,
            patch: { ...action.patch, startedAt: null, elapsedSeconds: elapsed },
          };
        }
      }
      return action;
    });
    storeCache = next;
    if (next.settings.lang !== prevLang) currentLang = next.settings.lang;
    if (next.settings.hotkey && next.settings.hotkey !== prevHotkey) {
      registerHotkey(next.settings.hotkey);
    }
    if (next.settings.launchAtLogin !== prevLogin) {
      app.setLoginItemSettings({ openAtLogin: next.settings.launchAtLogin });
    }
    refreshTrayMenu();
    broadcast();
    return next;
  });

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    const next = persistSettings(patch);
    if (patch.lang && patch.lang !== currentLang) {
      currentLang = patch.lang;
      refreshTrayMenu();
    }
    if (patch.hotkey && patch.hotkey !== hotkey) {
      registerHotkey(patch.hotkey);
    }
    if (typeof patch.launchAtLogin === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    broadcast();
    return next;
  });

  ipcMain.handle('ui:setCollapsed', (_e, next: boolean) => {
    setCollapsed(Boolean(next));
  });

  ipcMain.handle('ui:getState', () => ({ dock: dockSide, dragging }));

  ipcMain.handle('window:move', (_e, delta: { dx?: unknown; dy?: unknown }) => {
    if (!win) return;
    const dx = Number(delta?.dx);
    const dy = Number(delta?.dy);
    // 非有限值会让 setPosition 收到 NaN 并破坏窗口几何，必须挡住。
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = win.getPosition();
    const { workArea } = displayForWindow();
    const maxX = workArea.x + workArea.width - WIDTH;
    const maxY = workArea.y + workArea.height - EXPANDED_HEIGHT;
    const nx = Math.max(workArea.x, Math.min(maxX, Math.round(x + dx)));
    const ny = Math.max(workArea.y, Math.min(maxY, Math.round(y + dy)));
    win.setPosition(nx, ny);
  });

  ipcMain.handle('mcp:detect', () => detectMcp());
}

/* ------------------------------------------------------------------ */
/* 启动序列：在 app ready 之后执行                                        */
/* ------------------------------------------------------------------ */
function bootstrap(): void {
  trace('bootstrap: start');
  // store 目录不可写等启动异常在此兜底（弹框 + 记日志），绝不静默退出
  adapter = new StoreAdapter();
  // 首次运行（启动前 store 文件还不存在）时展开卡片，否则用户只会看到屏幕
  // 顶部一条 6px 的细线，很容易以为程序没启动。
  const firstRun = !STORE_EXISTED_AT_LAUNCH;
  storeCache = adapter.load();
  trace('bootstrap: store loaded, tasks=' + storeCache.tasks.length + ' firstRun=' + firstRun);
  currentLang = storeCache.settings.lang;
  hotkey = storeCache.settings.hotkey || HOTKEY_DEFAULT;
  // 首次运行、或已经存在未完成任务时展开；否则用户只看到屏幕顶部一条 6px
  // 细线，很容易当成「DSH 里的任务没显示出来」。
  collapsed = !(firstRun || hasOpenTask(storeCache));

  registerIpc();
  trace('bootstrap: ipc registered');
  createWindow();
  trace('bootstrap: window created');
  createTray();
  trace('bootstrap: tray created');
  registerHotkey(hotkey);
  trace('bootstrap: hotkey registered');
  startTick();
  trace('bootstrap: tick started');

  if (storeCache.settings.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // 监听磁盘变化（MCP 或其他进程写入）→ 同步并广播。
  // 我们自己每秒的落盘也会触发事件，因此只在内容真正变化时处理，
  // 否则会把 lastTickSec 基准清空，导致计时节拍永远补算 0 秒。
  adapter.watch(() => {
    const knownIds = new Set(storeCache.tasks.map((t) => t.id));
    const loaded = adapter.load();
    if (JSON.stringify(loaded) === JSON.stringify(storeCache)) return;
    // 只对「新出现的未完成任务」做主动展示：标题改名、计时跳秒这类变化不该
    // 反复抢焦点；反过来，DSH 对话刚建的任务必须被看见。
    const incoming = loaded.tasks.find((t) => !knownIds.has(t.id) && isOpenStatus(t.status));
    storeCache = loaded;
    lastTickSec = null; // 外部改写后重置 tick 基准，避免一次补算大跳
    if (storeCache.settings.lang !== currentLang) {
      currentLang = storeCache.settings.lang;
      refreshTrayMenu();
    }
    broadcast();
    if (incoming) revealIncomingTask(incoming.title);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */
// 单实例锁已在模块顶层获取（未获取已 quit）
if (gotLock) {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    try {
      adapter.write(storeCache);
    } catch {
      /* 忽略 */
    }
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  // 子进程 / 渲染进程异常退出时留痕：GPU 进程崩溃正是历史上「双击没反应」
  // 的元凶，日志里能直接看到 reason。
  app.on('child-process-gone', (_e, details) => {
    trace(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
    logError(`child-process-gone: type=${details.type} reason=${details.reason}`);
  });
}

/* ------------------------------------------------------------------ */
/* 入口：等 app ready 后再启动桌面端，启动异常弹框+记日志，绝不静默退出     */
/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  trace('whenReady fired, gotLock=' + gotLock);
  if (!gotLock) {
    // 拿不到单实例锁通常意味着已经有一个 DSHBar 在跑。但锁文件也可能是因为
    // 权限/残留而创建失败；两种情况都不该让用户只看到「双击没反应」。
    trace('no lock -> notify and quit');
    try {
      dialog.showMessageBox({
        type: 'info',
        title: 'DSHBar',
        message: 'DSHBar 已经在运行（或单实例锁不可用）',
        detail:
          '如果屏幕顶部没有看到细线，请检查系统托盘里的 DSHBar 图标；' +
          '仍不行请查看 %APPDATA%\\DSHBar\\startup.log。',
        buttons: ['知道了'],
        noLink: true,
      });
    } catch {
      /* 弹框失败则忽略 */
    }
    app.quit();
    return;
  }
  try {
    bootstrap();
  } catch (err) {
    logError(err);
    try {
      dialog.showErrorBox('DSHBar', String(err));
    } catch {
      /* 弹框失败则忽略 */
    }
  }
});