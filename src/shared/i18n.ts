/**
 * DSHBar · 界面文案字典（单一事实来源）。
 *
 * 仅渲染层使用（src/shared/i18n.ts 被排除在 tsconfig.json 之外，因此以 ESM 编译，
 * 不会与主进程的 CommonJS 输出在 dist/shared 下产生模块格式冲突）。
 * 主进程的原生托盘菜单文案在 main.ts 内联维护（二者互不依赖）。
 */
import type { Lang } from './types';

export type LangCode = 'zh' | 'en';

const zh = {
  'bar.collapsedHint': '点击展开，或按 Alt+W',
  'bar.expand': '展开任务条',
  'bar.collapse': '收起任务条',
  'task.none': '暂无任务 · 在 DSH 中创建',
  'task.complete': '标记完成',
  'task.pause': '暂停',
  'task.resume': '继续',
  'task.prev': '上一个任务',
  'task.next': '下一个任务',
  'task.remaining': '剩余',
  'task.elapsed': '已投入',
  'task.countdownDone': '超时',
  'task.aborted': '已取消',
  'mcp.available': 'DSH 可接入（已检测到 dshbar-mcp）',
  'mcp.missing': '未检测到 dshbar-mcp，暂无法接入 DSH',
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  'bar.collapsedHint': 'Click to expand, or press Alt+W',
  'bar.expand': 'Expand task bar',
  'bar.collapse': 'Collapse task bar',
  'task.none': 'No tasks · Create one in DSH',
  'task.complete': 'Mark complete',
  'task.pause': 'Pause',
  'task.resume': 'Resume',
  'task.prev': 'Previous task',
  'task.next': 'Next task',
  'task.remaining': 'Remaining',
  'task.elapsed': 'Elapsed',
  'task.countdownDone': 'Overdue',
  'task.aborted': 'Aborted',
  'mcp.available': 'DSH ready (dshbar-mcp detected)',
  'mcp.missing': 'dshbar-mcp not found; DSH integration unavailable',
};

const dictionaries: Record<LangCode, Record<MessageKey, string>> = { zh, en };

/** 根据用户语言设置解析出实际语言码；system 时按操作系统语言回退。 */
export function resolveLang(lang: Lang): LangCode {
  if (lang === 'zh' || lang === 'en') return lang;
  const sys = typeof navigator !== 'undefined' ? navigator.language : '';
  return sys.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 取指定用户语言设置下的文案字典。 */
export function messages(lang: Lang): Record<MessageKey, string> {
  return dictionaries[resolveLang(lang)];
}

/** 取单条文案（可带 {n} 占位符，目前未使用）。 */
export function t(lang: Lang, key: MessageKey): string {
  return messages(lang)[key];
}