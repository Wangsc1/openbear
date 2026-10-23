/**
 * 详情面板的纯解析逻辑（不依赖 React，便于单测）：
 * - 终端结果：后端 Bash 结果的 "key: value" 头 + "output:" 之后的真实输出；退出码；
 * - 文件读取结果：<file …> 包裹 + "   行号\t内容" 行；
 * - 搜索结果：WebSearch 的 Markdown 列表 / MCP web_search 的 JSON；
 * - 通用：JSON、"key: value" 列表识别；耗时与时间格式化；工具结论（完成/失败/退出码/运行中/已停止）。
 */

export function parseMaybeJson(value: unknown): any {
  let current: unknown = value;
  for (let i = 0; i < 2 && typeof current === 'string'; i += 1) {
    const text = current.trim();
    if (!text || !/^[[{"]/.test(text)) break;
    try {
      current = JSON.parse(text);
    } catch {
      break;
    }
  }
  return current;
}

export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type TerminalResult = { meta: Array<{ key: string; value: string }>; output: string; exitCode: number | null };

/** 后端 Bash/Process 结果：头部若干 "key: value"，"output:" 行之后是命令输出。 */
export function parseTerminalResult(raw: string): TerminalResult {
  const text = String(raw || '');
  const lines = text.split('\n');
  const meta: Array<{ key: string; value: string }> = [];
  let outputStart = -1;
  for (let i = 0; i < Math.min(lines.length, 24); i += 1) {
    const line = lines[i];
    if (/^output:\s*$/.test(line)) {
      outputStart = i + 1;
      break;
    }
    const m = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (!m) break;
    meta.push({ key: m[1], value: m[2] });
  }
  const exit = meta.find((item) => item.key === 'exit_code');
  const exitCode = exit && /^-?\d+$/.test(exit.value.trim()) ? Number(exit.value.trim()) : null;
  if (outputStart < 0) return { meta: meta.length && meta.length === lines.filter(Boolean).length ? meta : [], output: meta.length && meta.length === lines.filter(Boolean).length ? '' : text, exitCode };
  return { meta, output: lines.slice(outputStart).join('\n').replace(/\n+$/, ''), exitCode };
}

/** 输出里“看起来是失败”的行（红色显示）。 */
export function isFailureLine(line: string): boolean {
  // 驼峰异常名（OperationalError / KeyError）大小写敏感匹配，避免 “terror” 之类误报
  return /\b(error|errors|failed|failure|fail|fatal|traceback|exception|panic)\b|not found|No such file|Permission denied|^E\s|^\s*✗|^FAIL/i.test(line) || /[a-z0-9](Error|Exception)\b|\b[A-Z]\w*(Error|Exception)\b/.test(line);
}

export type FileLine = { no: string; text: string };

/** Read 结果：去掉 <file …> 头尾，拆出行号。不是这种格式时返回 null。 */
export function parseFileResult(raw: string): { path: string; lines: FileLine[]; note: string } | null {
  const text = String(raw || '');
  const head = /^<file\s+([^>]*)>\n?/.exec(text);
  const body = head ? text.slice(head[0].length).replace(/\n?<\/file>\s*$/, '') : text;
  const rows = body.split('\n');
  const numbered = rows.filter((row) => /^\s*\d+\t/.test(row)).length;
  if (!head && numbered < Math.max(1, rows.length * 0.6)) return null;
  const attrs = head?.[1] || '';
  const path = /path="([^"]*)"/.exec(attrs)?.[1] || '';
  const total = /total_lines="(\d+)"/.exec(attrs)?.[1];
  const truncated = /truncated="true"/.test(attrs);
  const lines: FileLine[] = [];
  for (const row of rows) {
    const m = /^\s*(\d+)\t(.*)$/.exec(row);
    if (m) lines.push({ no: m[1], text: m[2] });
    else if (lines.length || row.trim()) lines.push({ no: '', text: row });
  }
  while (lines.length && !lines[lines.length - 1].no && !lines[lines.length - 1].text.trim()) lines.pop();
  const note = [total ? `共 ${total} 行` : '', truncated ? '已截断' : ''].filter(Boolean).join(' · ');
  return { path, lines, note };
}

export type SearchHit = { title: string; url: string; snippet: string };

/** 搜索结果：MCP web_search JSON（results / structuredContent）或 WebSearch 的 Markdown 列表。 */
export function parseSearchResult(raw: string): SearchHit[] {
  const text = String(raw || '');
  const fromList = (list: any): SearchHit[] =>
    Array.isArray(list)
      ? list
          .filter((item) => item && (item.url || item.title))
          .map((item) => ({ title: String(item.title || item.url || ''), url: String(item.url || ''), snippet: String(item.snippet || item.content || item.description || item.text || '').replace(/\s+/g, ' ').trim() }))
      : [];
  const data = parseMaybeJson(text);
  let source = text;
  if (data && typeof data === 'object') {
    if (Array.isArray((data as any).results)) return fromList((data as any).results);
    const preview = String((data as any).preview || '');
    if (preview) source = preview;
    const inner = /structuredContent:\s*\n([\s\S]*)$/.exec(preview)?.[1];
    const parsed = inner ? parseMaybeJson(inner) : null;
    if (parsed && Array.isArray(parsed.results)) return fromList(parsed.results);
  }
  const structured = /structuredContent:\s*\n([\s\S]*)$/.exec(text)?.[1];
  if (structured) {
    const parsed = parseMaybeJson(structured);
    if (parsed && Array.isArray(parsed.results)) return fromList(parsed.results);
  }
  // 预览常被截断（不是合法 JSON、字符串里有原始换行）：按 "title" / "url" / "snippet" 字段宽松提取
  const loose: SearchHit[] = [];
  const fieldRe = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"url"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"(?:snippet|content|description)"\s*:\s*"((?:[^"\\]|\\.)*))?/g;
  let f: RegExpExecArray | null;
  while ((f = fieldRe.exec(source))) {
    const unescape = (s = '') => s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    loose.push({ title: unescape(f[1]), url: unescape(f[2]), snippet: unescape(f[3]).replace(/\s+/g, ' ').trim().slice(0, 400) });
  }
  if (loose.length) return loose;
  const hits: SearchHit[] = [];
  const re = /^###\s+\d+\.\s+(.+)\n-\s+\*\*URL\*\*:\s*(\S+)\n?((?:-\s+(?!\*\*URL).*\n?)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    hits.push({ title: m[1].trim(), url: m[2].trim(), snippet: m[3].replace(/^-\s+/gm, '').replace(/\s+/g, ' ').trim() });
  }
  return hits;
}

/** 结果是否是“key: value”行列表（如 Edit/Write 的结果）。 */
export function parseKeyValueLines(raw: string): Array<{ key: string; value: string }> | null {
  const lines = String(raw || '').split('\n').filter((line) => line.trim());
  if (lines.length < 2 || lines.length > 40) return null;
  const pairs = lines.map((line) => /^([A-Za-z_][\w.-]{0,40}):\s?(.*)$/.exec(line));
  if (pairs.filter(Boolean).length < lines.length * 0.8) return null;
  return pairs.filter((m): m is RegExpExecArray => Boolean(m)).map((m) => ({ key: m[1], value: m[2] }));
}

export function formatDuration(ms: number): string {
  const value = Number(ms) || 0;
  if (value <= 0) return '';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  if (value < 60000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')} 秒`;
  const total = Math.round(value / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h} 小时 ${m} 分` : `${m} 分 ${s} 秒`;
}

export function formatClock(ms: number): string {
  const value = Number(ms) || 0;
  if (!value) return '';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return sameDay ? clock : `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

export type Outcome = { tone: 'ok' | 'error' | 'run' | 'muted'; label: string };

const RUNNING = new Set(['queued', 'running', 'pausing', 'resuming', 'stopping']);

/** 工具结论：运行中 / 已停止 / 退出码 N / 失败 / 完成。 */
export function toolOutcome(status: string, resultText: string, exitCode: number | null): Outcome {
  const st = String(status || '');
  if (RUNNING.has(st)) return { tone: 'run', label: '运行中' };
  if (st === 'cancelled' || st === 'interrupted') return { tone: 'muted', label: '已停止' };
  if (exitCode !== null && exitCode !== 0) return { tone: 'error', label: `退出码 ${exitCode}` };
  const headStatus = /^status:\s*(\w+)/m.exec(String(resultText || '').slice(0, 200))?.[1];
  if (st === 'failed' || st === 'error' || headStatus === 'failed' || headStatus === 'error') return { tone: 'error', label: '失败' };
  return { tone: 'ok', label: '完成' };
}

/** 文本截断（渲染上限），返回 [文本, 是否截断]。 */
export function clip(text: string, maxChars: number, maxLines = Infinity): [string, boolean] {
  let value = String(text || '');
  let cut = false;
  if (value.length > maxChars) {
    value = value.slice(0, maxChars);
    cut = true;
  }
  if (maxLines !== Infinity) {
    const lines = value.split('\n');
    if (lines.length > maxLines) {
      value = lines.slice(0, maxLines).join('\n');
      cut = true;
    }
  }
  return [value, cut];
}
