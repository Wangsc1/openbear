/**
 * 产物链接识别与 Markdown 切分（纯逻辑，无 React，供单测）。
 *
 * Web 在渲染后的 DOM 上把 /api/conversations/{cid}/artifacts/{aid}/content 链接换成产物卡片（artifactCards.js）。
 * App 的正文是原生 Markdown 视图，无法在里面嵌组件：这里在送入渲染器前把“独占一段的产物链接”切出来，
 * 让行视图在原位置插入原生产物卡片；行内（夹在句子里）的产物链接保持为链接，点击时打开预览。
 * 图片形式 ![](…/content?preview=1) 保持为 Markdown 图片（原生渲染），并在其后追加“复制工作区路径”入口（B2-80）。
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH_RE = new RegExp(`^/api/conversations/(${UUID})/artifacts/(${UUID})/content$`, 'i');

export type ArtifactIdentity = {
  conversationUuid: string;
  artifactUuid: string;
  key: string;
  contentUrl: string;
  metadataUrl: string;
  downloadUrl: string;
  download: boolean;
};

/** 与 Web artifactFromUrl 相同的识别规则（只接受当前服务器的相对路径或同源绝对地址）。 */
export function artifactFromUrl(value: string, origin = ''): ArtifactIdentity | null {
  if (typeof value !== 'string' || !value) return null;
  let path = value;
  let query = '';
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (!origin || url.origin !== new URL(origin).origin || url.username || url.password) return null;
      path = url.pathname;
      query = url.search;
    } else {
      const q = value.indexOf('?');
      const h = value.indexOf('#');
      const end = Math.min(...[q, h].filter((n) => n >= 0), value.length);
      path = value.slice(0, end);
      query = q >= 0 ? value.slice(q, h > q ? h : undefined) : '';
    }
  } catch {
    return null;
  }
  const match = PATH_RE.exec(path);
  if (!match) return null;
  const [, conversationUuid, artifactUuid] = match;
  const contentUrl = `/api/conversations/${conversationUuid}/artifacts/${artifactUuid}/content`;
  const download = /(?:^|[?&])download=(1|true|yes|on)(?:&|$)/i.test(query);
  return {
    conversationUuid, artifactUuid, key: `${conversationUuid}:${artifactUuid}`,
    contentUrl, metadataUrl: contentUrl.slice(0, -'/content'.length), downloadUrl: `${contentUrl}?download=1`, download,
  };
}

export type MarkdownPiece = { kind: 'md'; text: string } | { kind: 'artifact'; identity: ArtifactIdentity; label: string };

const LINK_LINE = /^\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]\s*)*(?:[-*+]\s+)?\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*\)\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]\s*)*$/u;

/**
 * 把一个 Markdown 片段按“独占一行的产物链接”切开。代码块内、表格内、图片链接不处理。
 * 没有产物链接时返回 [{kind:'md', text}]（同一字符串），调用方据此走原来的路径。
 */
export function splitArtifactPieces(markdown: string, origin = ''): MarkdownPiece[] {
  const text = String(markdown || '');
  if (!text.includes('/artifacts/')) return [{ kind: 'md', text }];
  const lines = text.split('\n');
  const out: MarkdownPiece[] = [];
  let buffer: string[] = [];
  let fence = '';
  const flush = () => {
    if (!buffer.length) return;
    const chunk = buffer.join('\n');
    if (chunk.trim()) out.push({ kind: 'md', text: chunk });
    buffer = [];
  };
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      buffer.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      buffer.push(line);
      continue;
    }
    const m = LINK_LINE.exec(line);
    const identity = m ? artifactFromUrl(m[2], origin) : null;
    if (m && identity && !identity.download && !/^\s*\|/.test(line)) {
      flush();
      out.push({ kind: 'artifact', identity, label: m[1].replace(/\\(.)/g, '$1').trim() });
      continue;
    }
    buffer.push(line);
  }
  flush();
  if (!out.some((p) => p.kind === 'artifact')) return [{ kind: 'md', text }];
  return out;
}

/** Markdown 里引用的产物图片（![alt](…/content?preview=1)），用于“复制工作区路径”。 */
export function artifactImagesIn(markdown: string, origin = ''): ArtifactIdentity[] {
  const out: ArtifactIdentity[] = [];
  const seen = new Set<string>();
  for (const m of String(markdown || '').matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    const id = artifactFromUrl(m[1], origin);
    if (id && !seen.has(id.key)) {
      seen.add(id.key);
      out.push(id);
    }
  }
  return out;
}

/** Markdown 里全部图片地址（点按看大图、左右切换）。 */
export function markdownImageUrls(markdown: string): string[] {
  return [...String(markdown || '').matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map((m) => m[1]);
}
