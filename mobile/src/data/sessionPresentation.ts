/**
 * 登录设备展示：与 web/src/sessionPresentation.js 相同的规则（设备、浏览器、时间），
 * 另外识别 App 自己的 User-Agent（OpenBear-App/x.y）。
 */
function majorVersion(userAgent: string, pattern: RegExp): string {
  const match = String(userAgent || '').match(pattern);
  return match?.[1] ? ` ${match[1]}` : '';
}

export function describeSessionUserAgent(userAgent = ''): { os: string; browser: string; version: string; deviceKind: 'mobile' | 'desktop'; label: string } {
  const ua = String(userAgent || '');
  let os = '未知设备';
  let deviceKind: 'mobile' | 'desktop' = 'desktop';
  if (/iPhone/i.test(ua)) {
    os = 'iPhone';
    deviceKind = 'mobile';
  } else if (/iPad/i.test(ua)) {
    os = 'iPad';
    deviceKind = 'mobile';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
    deviceKind = 'mobile';
  } else if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '未知浏览器';
  // 手机上标题行放不下版本号，App 的版本单独给出，由界面放到次要信息里
  let version = '';
  if (/OpenBear-App\//i.test(ua)) {
    browser = 'OpenBear App';
    version = majorVersion(ua, /OpenBear-App\/([\d.]+)/i).trim();
  }
  else if (/Edg\//i.test(ua)) browser = `Edge${majorVersion(ua, /Edg\/(\d+)/i)}`;
  else if (/OPR\//i.test(ua)) browser = `Opera${majorVersion(ua, /OPR\/(\d+)/i)}`;
  else if (/CriOS\//i.test(ua)) browser = `Chrome${majorVersion(ua, /CriOS\/(\d+)/i)}`;
  else if (/Chrome\//i.test(ua)) browser = `Chrome${majorVersion(ua, /Chrome\/(\d+)/i)}`;
  else if (/FxiOS\//i.test(ua)) browser = `Firefox${majorVersion(ua, /FxiOS\/(\d+)/i)}`;
  else if (/Firefox\//i.test(ua)) browser = `Firefox${majorVersion(ua, /Firefox\/(\d+)/i)}`;
  else if (/Safari\//i.test(ua)) browser = `Safari${majorVersion(ua, /Version\/(\d+)/i)}`;
  return { os, browser, version, deviceKind, label: `${os} · ${browser}` };
}

export function formatSessionTime(timestamp: number): string {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  const d = new Date(value * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeSessionTime(timestamp: number, nowMs = Date.now()): string {
  const value = Number(timestamp || 0);
  if (!value) return '未知';
  const seconds = Math.max(0, Math.floor((Number(nowMs) - value * 1000) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatSessionTime(value);
}

/** 与 web/src/views/instances/instanceHelpers.js passwordHint 一致（网关账号的弱密码提示）。 */
export function passwordHint(value: string): string {
  if (!value) return '';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((re) => re.test(value)).length;
  if (value.length < 8) return '密码较短，容易被猜到；建议至少 8 位。';
  if (value.length < 12 && kinds < 3) return '建议 12 位以上，或混合大小写字母、数字和符号。';
  return '';
}
