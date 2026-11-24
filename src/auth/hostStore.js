import { hashPassword } from './password.js';

// متجر حسابات المضيفين.
// الآن: في الذاكرة، يُملأ من متغيرات البيئة. في مرحلة Supabase يُستبدل بمتجر يقرأ جدول hosts
// بنفس الواجهة (findByUsername) فلا يتغير بقية الكود.
//
// HOST_ACCOUNTS=اسم:كلمة_مرور,اسم2:كلمة_مرور2
// ADMIN_USERS=اسم  (من هؤلاء يصبح مديرًا في المرحلة 5)
export class MemoryHostStore {
  constructor(accounts = []) {
    this.byName = new Map();
    for (const a of accounts) this.add(a);
  }

  add({ username, password, role = 'host', active = true }) {
    const key = String(username).trim().toLowerCase();
    if (!key || !password) return;
    this.byName.set(key, {
      id: `h_${key}`,
      username: String(username).trim(),
      passwordHash: hashPassword(password),
      role,
      active,
    });
  }

  async findByUsername(username) {
    return this.byName.get(String(username || '').trim().toLowerCase()) || null;
  }
}

export function hostStoreFromEnv(env = process.env) {
  const admins = new Set(
    (env.ADMIN_USERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const accounts = (env.HOST_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      if (i < 1) return null;
      const username = pair.slice(0, i);
      return { username, password: pair.slice(i + 1), role: admins.has(username.toLowerCase()) ? 'admin' : 'host' };
    })
    .filter(Boolean);
  if (accounts.length === 0) console.warn('[auth] لا توجد حسابات مضيفين: اضبط HOST_ACCOUNTS.');
  return new MemoryHostStore(accounts);
}
