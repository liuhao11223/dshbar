/**
 * DSHBar · 渲染层离线预览用的 preload 打桩。
 *
 * 真实运行时 window.dshbar 由 src/preload/preload.ts 通过 contextBridge 提供；
 * 这里给出同形状的假实现，让 renderer.js 能在普通浏览器里跑起来，
 * 从而在不启动 Electron 的情况下核对布局与字形（截图/量尺寸都行）。
 *
 * 调试钩子（在浏览器控制台或自动化脚本里调用）：
 *   __setTitle('很长的任务标题')
 *   __setTime(3661)                  // 秒
 *   __setTasks([...])                // 换整份任务列表
 *   __setDragging(true)              // 切到拖动圆盘形态
 *   __setDock('bottom')              // 切吸附边
 */
(() => {
  const cbs = { changed: null, mode: null, dock: null, drag: null };

  const store = {
    version: 1,
    tasks: [
      {
        id: 'preview-1',
        title: '整理并修复 DSHBar 悬浮窗中间文字显示不全的问题',
        status: 'running',
        elapsedSeconds: 0,
        startedAt: null,
        order: 1,
      },
    ],
    settings: { lang: 'zh', hotkey: 'Alt+W', launchAtLogin: true },
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  window.dshbar = {
    onChanged: (cb) => (cbs.changed = cb),
    onModeChanged: (cb) => (cbs.mode = cb),
    onDockChanged: (cb) => (cbs.dock = cb),
    onDragChanged: (cb) => (cbs.drag = cb),
    getUiState: async () => ({ dock: window.__dock || 'top', dragging: !!window.__dragging }),
    getStore: async () => clone(store),
    mutate: async () => {},
    setCollapsed: async () => {},
    dragStart: () => {},
    dragEnd: () => {},
  };

  window.__store = store;
  window.__emit = () => cbs.changed && cbs.changed(clone(store));
  window.__setTasks = (tasks) => {
    store.tasks = tasks;
    window.__emit();
  };
  window.__setTitle = (title) => {
    if (store.tasks[0]) store.tasks[0].title = title;
    window.__emit();
  };
  window.__setTime = (seconds) => {
    if (!store.tasks[0]) return;
    store.tasks[0].elapsedSeconds = seconds;
    store.tasks[0].startedAt = null;
    window.__emit();
  };
  window.__setMode = (mode) => {
    cbs.mode && cbs.mode(mode);
  };
  window.__setDock = (side) => {
    window.__dock = side;
    cbs.dock && cbs.dock(side);
  };
  window.__setDragging = (on) => {
    window.__dragging = on;
    cbs.drag && cbs.drag(on);
  };
})();
