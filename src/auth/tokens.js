import crypto from 'node:crypto';

// رموز دخول بصيغة JWT (HS256) بدون مكتبات خارجية.
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const fromB64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

let secret = process.env.JWT_SECRET;
if (!secret) {
  // بدون سر ثابت تنتهي صلاحية كل الجلسات عند كل إعادة تشغيل. اضبط JWT_SECRET في الإنتاج.
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET غير مضبوط: استُخدم سر مؤقت (ستنتهي الجلسات عند إعادة التشغيل).');
}

const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(payload, ttlSec = 12 * 3600) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

// يُرجع محتوى الرمز إن كان سليمًا وغير منتهٍ، وإلا null
export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = Buffer.from(sign(`${header}.${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const head = JSON.parse(fromB64(header));
    if (head.alg !== 'HS256') return null;
    const payload = JSON.parse(fromB64(body));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
