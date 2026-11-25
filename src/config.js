import 'dotenv/config';

const parseList = (value) =>
  (value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

export const config = {
  port: Number(process.env.PORT) || 3001,
  clientOrigins: parseList(process.env.CLIENT_ORIGINS || 'http://localhost:5173'),
  isProduction: process.env.NODE_ENV === 'production',
};

// فحص الأصل المسموح (يُستخدم في CORS وSocket.IO)
export function isAllowedOrigin(origin) {
  // طلبات بدون Origin (فحص الصحة، أدوات الاختبار) مسموحة
  if (!origin) return true;
  return config.clientOrigins.includes(origin.replace(/\/+$/, ''));
}
