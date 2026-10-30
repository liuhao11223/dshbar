// 渲染层全局类型声明：preload 注入的 window.dshbar。
import type { DshbarApi } from '../shared/types';

declare global {
  interface Window {
    dshbar: DshbarApi;
  }
}

export {};