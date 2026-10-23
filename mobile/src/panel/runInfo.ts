/** 运行状态与本次运行计时（B4-03）的纯逻辑：与 ConversationView 导航栏副标题的口径一致。 */
import type { ChatRow } from '../data/rows';

/** 当前轮开始时间：从尾部找最后一条用户消息；没有时回退到会话列表的 activeStartedAtMs。 */
export function runStartedAtMs(rows: ChatRow[] | undefined, fallback = 0): number {
  if (rows) {
    for (let i = rows.length - 1, seen = 0; i >= 0 && seen < 400; i -= 1, seen += 1) {
      const row = rows[i];
      if (row.type === 'user' && row.createdAtMs) return row.createdAtMs;
    }
  }
  return Number(fallback || 0);
}

/** 尾部是否有待回答的交互问答（等待你的回答）。 */
export function waitingForAnswer(rows: ChatRow[] | undefined): boolean {
  if (!rows) return false;
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < 400; i -= 1, seen += 1) {
    const row = rows[i];
    if (row.type === 'user') return false;
    if (row.type === 'interaction' && (row.status === 'running' || row.status === 'pending')) return true;
  }
  return false;
}
