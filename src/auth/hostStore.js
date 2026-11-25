import { hashPassword } from './password.js';

// متجر حسابات المضيفين والمشرفين.
// الآن: في الذاكرة، يُملأ من متغيرات البيئة ويُدار من لوحة الإدارة (يضيع عند إعادة التشغيل
// ما عدا حسابات البيئة). في مرحلة Supabase يُستبدل بمتجر يقرأ جدول hosts بنفس الدوال.
//
// HOST_ACCOUNTS=اسم:كلمة_مرور,اسم2:كلمة_مرور2
// ADMIN_USERS=اسم  (من هؤلاء يصبح مديرًا)
// الأدوار: host (مضيف) | moderator (مشرف: الغرف والمقترحات) | admin (مدير كامل)
export const ROLES = ['host', 'moderator', 'admin'];

export class MemoryHostStore {
  constructor(accounts = []) {
    this.byId = new Map();
    this.seq = 0;
    for (const a of accounts) this.add(a);
  }

  add({ username, password, displayName, role = 'host', active = true }) {
    const name = String(username || '').trim();
    if (!name || !password) return null;
    const id = `h${(this.seq += 1)}`;
    const host = {
      id,
      username: name,
      displayName: (displayName || name).trim(),
      passwordHash: hashPassword(password),
      role,
      active,
      createdAt: Date.now(),
      lastLoginAt: null,
    };
    this.byId.set(id, host);
    return host;
  }

  async findByUsername(username) {
    const key = String(username || '').trim().toLowerCase();
    for (const h of this.byId.values()) if (h.username.toLowerCase() === key) return { ...h };
    return null;
  }

  async findById(id) {
    const h = this.byId.get(String(id));
    return h ? { ...h } : null;
  }

  async list() {
    return [...this.byId.values()].map((h) => ({ ...h })).sort((a, b) => a.createdAt - b.createdAt);
  }

  async create(data) {
    if (await this.findByUsername(data.username)) return null;
    return { ...this.add(data) };
  }

  async update(id, patch) {
    const h = this.byId.get(String(id));
    if (!h) return null;
    if (typeof patch.displayName === 'string') h.displayName = patch.displayName;
    if (ROLES.includes(patch.role)) h.role = patch.role;
    if (typeof patch.active === 'boolean') h.active = patch.active;
    if (typeof patch.password === 'string' && patch.password) h.passwordHash = hashPassword(patch.password);
    return { ...h };
  }

  async touchLogin(id) {
    const h = this.byId.get(String(id));
    if (h) h.lastLoginAt = Date.now();
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
