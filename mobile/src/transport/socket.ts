/**
 * 对话 WebSocket：/api/conversations/{uuid}/ws?afterFrameSeq=X&bootstrap=incremental
 * 以及全局事件 WebSocket：/api/events/ws。
 *
 * 认证与 REST 相同：App 令牌（网关还有上下文令牌）放在握手请求头里（RN WebSocket 的 headers 选项）。
 * 后端对 App 令牌请求不做浏览器 Origin 校验，所以 Android 自动附带的 origin 头和反向代理改写 Host 都不影响连接。
 */
import type { ConversationSocket, SocketFactory } from '../data/conversationStore';
import { authHeaders, type ServerConnection, toWsUrl } from './http';

type RNWebSocket = new (url: string, protocols?: string | string[] | null, options?: { headers?: Record<string, string> }) => WebSocket;

function openSocket(connection: ServerConnection, path: string): WebSocket {
  const Ctor = WebSocket as unknown as RNWebSocket;
  return new Ctor(toWsUrl(connection.baseUrl, path), null, { headers: authHeaders(connection) });
}

export function createConversationSocketFactory(connection: ServerConnection): SocketFactory {
  return (uuid, afterFrameSeq, handlers) => {
    const ws = openSocket(connection, `/api/conversations/${encodeURIComponent(uuid)}/ws?afterFrameSeq=${afterFrameSeq}&bootstrap=incremental`);
    let closed = false;
    let ping: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      handlers.onOpen();
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
    };
    ws.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(String(event.data)));
      } catch {
        /* 非 JSON 帧忽略 */
      }
    };
    ws.onclose = (event) => {
      if (ping) clearInterval(ping);
      if (!closed) handlers.onClose(event.code, event.reason);
    };
    ws.onerror = () => {
      /* onclose 会随后触发 */
    };
    const socket: ConversationSocket = {
      send(payload) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        return true;
      },
      close() {
        closed = true;
        if (ping) clearInterval(ping);
        ws.close();
      },
    };
    return socket;
  };
}

export type GlobalEvent = { type: string; items?: any[]; upserts?: any[]; removed?: string[]; [key: string]: any };

/** 全局事件 WS（会话树状态、运行中标记、未读）。断线后按退避重连（2s 起，最长 30s）。 */
export function connectGlobalEvents(
  connection: ServerConnection,
  onEvent: (event: GlobalEvent) => void,
  onState?: (open: boolean) => void,
  /** 可选（B3 加）：拿到向当前连接发命令的函数（引用目录 resync 等）；断开后为 null */
  onSender?: (send: ((payload: Record<string, unknown>) => boolean) | null) => void,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = 2000;
  const open = () => {
    ws = openSocket(connection, '/api/events/ws');
    const current = ws;
    ws.onopen = () => {
      delay = 2000;
      onSender?.((payload) => {
        if (current.readyState !== WebSocket.OPEN) return false;
        current.send(JSON.stringify(payload));
        return true;
      });
      onState?.(true);
    };
    ws.onmessage = (event) => {
      try {
        onEvent(JSON.parse(String(event.data)));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onSender?.(null);
      onState?.(false);
      if (stopped) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
