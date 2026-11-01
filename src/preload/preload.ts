// DSHBar · preload：通过 contextBridge 向渲染层暴露受限 API。
// 以 CommonJS 编译（tsconfig.json），在 contextIsolation 下运行。
import { contextBridge, ipcRenderer } from 'electron';
import type { DshbarApi, StoreFile, TaskAction, Settings, WindowMode, DockSide } from '../shared/types';

const api: DshbarApi = {
  getStore: () => ipcRenderer.invoke('store:get') as Promise<StoreFile>,
  mutate: (action: TaskAction) =>
    ipcRenderer.invoke('store:mutate', action) as Promise<StoreFile>,
  updateSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('settings:update', patch) as Promise<StoreFile>,
  setCollapsed: (collapsed: boolean) =>
    ipcRenderer.invoke('ui:setCollapsed', collapsed) as Promise<void>,
  moveWindow: (dx: number, dy: number) =>
    ipcRenderer.invoke('window:move', { dx, dy }) as Promise<void>,
  onChanged: (cb: (store: StoreFile) => void) => {
    const listener = (_e: unknown, store: StoreFile) => cb(store);
    ipcRenderer.on('store:changed', listener);
    return () => {
      ipcRenderer.removeListener('store:changed', listener);
    };
  },
  onModeChanged: (cb: (mode: WindowMode) => void) => {
    const listener = (_e: unknown, mode: WindowMode) => cb(mode);
    ipcRenderer.on('ui:modeChanged', listener);
    return () => {
      ipcRenderer.removeListener('ui:modeChanged', listener);
    };
  },
  onDragChanged: (cb: (dragging: boolean) => void) => {
    const listener = (_e: unknown, dragging: boolean) => cb(dragging);
    ipcRenderer.on('ui:dragChanged', listener);
    return () => {
      ipcRenderer.removeListener('ui:dragChanged', listener);
    };
  },
  onDockChanged: (cb: (side: DockSide) => void) => {
    const listener = (_e: unknown, side: DockSide) => cb(side);
    ipcRenderer.on('ui:dockChanged', listener);
    return () => {
      ipcRenderer.removeListener('ui:dockChanged', listener);
    };
  },
  getUiState: () =>
    ipcRenderer.invoke('ui:getState') as Promise<{ dock: DockSide; dragging: boolean }>,
  dragStart: () => ipcRenderer.send('ui:dragStart'),
  dragEnd: () => ipcRenderer.send('ui:dragEnd'),
  detectMcp: () => ipcRenderer.invoke('mcp:detect') as Promise<boolean>,
};

contextBridge.exposeInMainWorld('dshbar', api);