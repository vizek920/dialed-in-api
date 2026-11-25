import { DEFAULT_POINTS, DEFAULT_ZONE_WIDTH, DEFAULT_TIME_SEC } from '../game/constants.js';

// بنك الأسئلة والتصنيفات.
// الآن: في الذاكرة (يعود لبياناته الأولى عند كل إعادة تشغيل). في مرحلة Supabase يُستبدل بمتجر
// يقرأ جدولي categories وquestions بنفس الدوال، فلا يتغير بقية الكود.
//
// حالة السؤال: private (لصاحبه فقط) | pending (مقترح بانتظار المراجعة) | approved (في بنك الموقع) | rejected
const SEED = [
  ['ماركات وسيارات', 'ساعة أوميغا', 'نادر', 'منتشر', 38],
  ['ماركات وسيارات', 'سيارة فيراري', 'نادر', 'منتشر', 22],
  ['ماركات وسيارات', 'هاتف آيفون', 'نادر', 'منتشر', 80],
  ['طعام ومشروبات', 'الكبسة', 'مكروه', 'محبوب', 82],
  ['طعام ومشروبات', 'الأناناس على البيتزا', 'مكروه', 'محبوب', 35],
  ['طعام ومشروبات', 'القهوة العربية', 'مكروه', 'محبوب', 78],
  ['حيوانات', 'الأسد', 'ضعيف', 'قوي', 82],
  ['حيوانات', 'القطة', 'خطيرة', 'أليفة', 72],
  ['ألعاب وترفيه', 'لعبة الشطرنج', 'سهلة', 'صعبة', 75],
  ['ألعاب وترفيه', 'السفر إلى القمر', 'مستحيل', 'ممكن', 20],
  ['حياة يومية', 'السهر حتى الفجر', 'سيئ', 'جيد', 25],
  ['حياة يومية', 'الشاي بالنعناع', 'مكروه', 'محبوب', 80],
];

export class MemoryBankStore {
  constructor({ seed = true } = {}) {
    this.categories = new Map();
    this.questions = new Map();
    this.seq = 0;
    if (seed) this.seedDefaults();
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  seedDefaults() {
    const ids = new Map();
    let order = 0;
    for (const [cat, item, left, right, target] of SEED) {
      if (!ids.has(cat)) {
        order += 1;
        const c = this.addCategory(cat, order);
        ids.set(cat, c.id);
      }
      this.addQuestion({
        ownerId: null,
        ownerName: null,
        categoryId: ids.get(cat),
        item,
        left,
        right,
        target,
        zoneWidth: DEFAULT_ZONE_WIDTH,
        points: [...DEFAULT_POINTS],
        timeSec: DEFAULT_TIME_SEC,
        status: 'approved',
      });
    }
  }

  // ───── التصنيفات ─────
  addCategory(name, sortOrder = 0) {
    const c = { id: this.nextId('c'), name, sortOrder, isActive: true, createdAt: Date.now() };
    this.categories.set(c.id, c);
    return c;
  }

  async listCategories({ activeOnly = false } = {}) {
    return [...this.categories.values()]
      .filter((c) => !activeOnly || c.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
      .map((c) => ({ ...c }));
  }

  async getCategory(id) {
    const c = this.categories.get(String(id));
    return c ? { ...c } : null;
  }

  async findCategoryByName(name) {
    const n = name.trim().toLowerCase();
    for (const c of this.categories.values()) if (c.name.toLowerCase() === n) return { ...c };
    return null;
  }

  async createCategory(name) {
    const max = Math.max(0, ...[...this.categories.values()].map((c) => c.sortOrder));
    return { ...this.addCategory(name, max + 1) };
  }

  async updateCategory(id, patch) {
    const c = this.categories.get(String(id));
    if (!c) return null;
    if (typeof patch.name === 'string') c.name = patch.name;
    if (typeof patch.isActive === 'boolean') c.isActive = patch.isActive;
    return { ...c };
  }

  // حذف التصنيف لا يحذف أسئلته: تصبح بلا تصنيف
  async deleteCategory(id) {
    const key = String(id);
    if (!this.categories.delete(key)) return false;
    for (const q of this.questions.values()) if (q.categoryId === key) q.categoryId = null;
    return true;
  }

  // ───── الأسئلة ─────
  addQuestion(data) {
    const now = Date.now();
    const q = {
      id: this.nextId('q'),
      ownerId: data.ownerId ?? null,
      ownerName: data.ownerName ?? null,
      categoryId: data.categoryId ? String(data.categoryId) : null,
      item: data.item,
      left: data.left,
      right: data.right,
      target: data.target,
      zoneWidth: data.zoneWidth,
      points: [...data.points],
      timeSec: data.timeSec,
      status: data.status || 'private',
      rejectReason: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.questions.set(q.id, q);
    return q;
  }

  async createQuestion(data) {
    return { ...this.addQuestion(data) };
  }

  async getQuestion(id) {
    const q = this.questions.get(String(id));
    return q ? { ...q } : null;
  }

  // يرشّح بالحالة والتصنيف والمالك والنص؛ الأحدث أولًا
  async listQuestions({ status, categoryId, ownerId, search, limit = 500 } = {}) {
    const needle = search ? search.trim().toLowerCase() : '';
    const out = [];
    for (const q of this.questions.values()) {
      if (status && q.status !== status) continue;
      if (categoryId !== undefined && q.categoryId !== (categoryId === null ? null : String(categoryId))) continue;
      if (ownerId !== undefined && q.ownerId !== ownerId) continue;
      if (needle && !`${q.item} ${q.left} ${q.right}`.toLowerCase().includes(needle)) continue;
      out.push({ ...q });
    }
    out.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return out.slice(0, limit);
  }

  async countQuestions({ status, ownerId } = {}) {
    let n = 0;
    for (const q of this.questions.values()) {
      if (status && q.status !== status) continue;
      if (ownerId !== undefined && q.ownerId !== ownerId) continue;
      n += 1;
    }
    return n;
  }

  async updateQuestion(id, patch) {
    const q = this.questions.get(String(id));
    if (!q) return null;
    const allowed = [
      'categoryId', 'item', 'left', 'right', 'target', 'zoneWidth', 'points', 'timeSec',
      'status', 'rejectReason', 'reviewedBy', 'reviewedAt',
    ];
    for (const k of allowed) {
      if (patch[k] !== undefined) q[k] = k === 'points' ? [...patch[k]] : k === 'categoryId' && patch[k] ? String(patch[k]) : patch[k];
    }
    q.updatedAt = Date.now();
    return { ...q };
  }

  async deleteQuestion(id) {
    return this.questions.delete(String(id));
  }
}
