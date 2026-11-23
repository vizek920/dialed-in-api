export const TEAMS = ['red', 'blue'];

// معرّفات الشخصيات الشتوية الجاهزة (تطابق رسومات الواجهة)
export const AVATARS = [
  'penguin',
  'bear',
  'fox',
  'snowman',
  'owl',
  'reindeer',
  'seal',
  'hare',
  'husky',
  'yeti',
  'snowcat',
  'walrus',
];

export const LIMITS = {
  nameMin: 2,
  nameMax: 16,
  roomNameMin: 2,
  roomNameMax: 30,
  teamSizeMin: 1,
  teamSizeMax: 8,
  roundsMin: 1,
  roundsMax: 40,
  questionsMax: 60,
  chatMax: 200,
  chatKeep: 100,
  maxRooms: 300,
};

export const TIMING = {
  hostGraceMs: 45_000, // مهلة عودة المضيف قبل نقل القيادة (الغرف العامة)
  emptyRoomTtlMs: 10 * 60_000, // حذف الغرفة الفارغة
  finishedRoomTtlMs: 30 * 60_000, // حذف الغرفة المنتهية
  moveMinIntervalMs: 30, // أقل فاصل بين تحريكات المؤشر من اللاعب نفسه
  chatMinIntervalMs: 700,
};

export const DEFAULT_POINTS = [2, 3, 4, 3, 2];
export const DEFAULT_ZONE_WIDTH = 5.56;
export const DEFAULT_TIME_SEC = 40;
