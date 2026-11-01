// DSHBar · 共享类型（单一事实来源）。
// 由 shell-dev 负责维护；主进程 / preload / 渲染层 / MCP 服务器共同依赖。
// 本文件只含类型与接口声明，不含任何运行时代码，
// 因此同时被 tsconfig.json（CommonJS）与 tsconfig.renderer.json（ESM）编译也不会产生模块格式冲突。

/**
 * aborted：MCP 服务器 dshbar_abort_work 专用（mcp-dev 增加）。
 * 仅追加可选字段/枚举值，对现有主进程/渲染层代码完全向后兼容。
 */
export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'aborted';

export interface Task {
  /** 稳定唯一 id，主进程用 crypto.randomUUID() 生成 */
  id: string;
  /** 用户语言概括的任务目标 */
  title: string;
  /** null = 正计时（无预估时长）；非空 = 倒计时 */
  estimatedSeconds: number | null;
  /** 已投入秒数（暂停/完成时保持该值） */
  elapsedSeconds: number;
  status: TaskStatus;
  /** 排序权重，递增 */
  order: number;
  /** ISO 时间字符串 */
  createdAt: string;
  /** 当前计时段的开始时间（ISO）；非 running 时为 null */
  startedAt: string | null;
  /** 最近一次修改时间（ISO） */
  updatedAt: string;
  /** 完成时备注（MCP dshbar_finish_work 写入；可选，向后兼容） */
  note?: string;
  /** 取消原因（MCP dshbar_abort_work 写入；可选，向后兼容） */
  abortReason?: string;
}

export type Lang = 'system' | 'zh' | 'en';

export interface Settings {
  lang: Lang;
  hotkey: string;
  launchAtLogin: boolean;
}

export interface StoreFile {
  version: 1;
  tasks: Task[];
  settings: Settings;
}

export type TaskAction =
  | { type: 'add'; task: Task }
  | { type: 'update'; id: string; patch: Partial<Task> }
  | { type: 'reorder'; ids: string[] }
  | { type: 'remove'; id: string }
  | { type: 'reset'; store: StoreFile };

/** 窗口形态：展开为任务卡，收起为顶部细线。 */
export type WindowMode = 'expanded' | 'collapsed';

/** 悬浮窗与屏幕工作区边缘的吸附关系：靠上边 / 靠下边 / 自由悬浮。 */
export type DockSide = 'top' | 'bottom' | 'free';

/** preload 通过 contextBridge 暴露给渲染层的 API 形状。 */
export interface DshbarApi {
  getStore(): Promise<StoreFile>;
  mutate(action: TaskAction): Promise<StoreFile>;
  updateSettings(patch: Partial<Settings>): Promise<StoreFile>;
  setCollapsed(collapsed: boolean): Promise<void>;
  moveWindow(dx: number, dy: number): Promise<void>;
  onChanged(cb: (store: StoreFile) => void): () => void;
  onModeChanged(cb: (mode: WindowMode) => void): () => void;
  /** 拖动开始/结束（拖动中窗口变为圆形时间盘）。 */
  onDragChanged(cb: (dragging: boolean) => void): () => void;
  /** 吸附边变化（top/bottom/free），收起细线贴对应屏幕边。 */
  onDockChanged(cb: (side: DockSide) => void): () => void;
  /** 启动时取一次当前 UI 状态（dock/dragging），避免错过 reveal 前的广播。 */
  getUiState(): Promise<{ dock: DockSide; dragging: boolean }>;
  /** 拖动开始/结束：渲染层按下卡片时通知主进程接管「窗口跟随光标」。 */
  dragStart(): void;
  dragEnd(): void;
  /** 系统 PATH 中是否存在 dshbar-mcp.cmd（可接入 DSH） */
  detectMcp(): Promise<boolean>;
}