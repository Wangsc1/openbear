// Safari 15.0 has getRandomValues but not randomUUID. IDs remain RFC 4122 v4;
// never substitute Math.random or timestamps for cryptographic randomness.
export function randomUuid(cryptoObject = globalThis.crypto) {
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
  if (typeof cryptoObject?.getRandomValues !== 'function') throw new Error('当前浏览器缺少安全随机数支持');
  const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
