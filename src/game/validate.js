import { LIMITS, DEFAULT_POINTS, DEFAULT_ZONE_WIDTH, DEFAULT_TIME_SEC } from './constants.js';
import { fail } from './errors.js';

// ينظّف نصًا من المستخدم: يزيل الرموز الخفية ويوحّد المسافات ويفحص الطول
export function cleanText(value, min, max) {
  if (typeof value !== 'string') return null;
  const s = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < min || s.length > max) return null;
  return s;
}

const isInt = (n) => Number.isInteger(n);

// يتحقق من سؤال ويُرجعه بصيغته الداخلية. القيود مطابقة لجدول questions في قاعدة البيانات.
export function validateQuestion(input) {
  if (!input || typeof input !== 'object') fail('bad_question');

  const item = cleanText(input.item, 1, 80);
  const left = cleanText(input.left, 1, 24);
  const right = cleanText(input.right, 1, 24);
  if (!item || !left || !right) fail('bad_question');

  const zoneWidth = input.zoneWidth === undefined ? DEFAULT_ZONE_WIDTH : Number(input.zoneWidth);
  if (!Number.isFinite(zoneWidth) || zoneWidth < 2 || zoneWidth > 10) fail('bad_question');

  const target = Number(input.target);
  if (!Number.isFinite(target)) fail('bad_question');
  // يجب أن تتسع النطاقات الخمسة حول الهدف داخل المقياس
  if (target < zoneWidth * 2.5 || target > 100 - zoneWidth * 2.5) fail('bad_target');

  const points = input.points === undefined ? [...DEFAULT_POINTS] : input.points;
  if (!Array.isArray(points) || points.length !== 5 || !points.every((p) => isInt(p) && p >= 0 && p <= 10)) {
    fail('bad_question');
  }

  const timeSec = input.timeSec === undefined ? DEFAULT_TIME_SEC : input.timeSec;
  if (!isInt(timeSec) || timeSec < 10 || timeSec > 180) fail('bad_question');

  return { item, left, right, target: Math.round(target * 100) / 100, zoneWidth, points: [...points], timeSec };
}

// يتحقق من إعدادات إنشاء الغرفة
export function validateRoomSettings(input) {
  if (!input || typeof input !== 'object') fail('bad_settings');

  const name = cleanText(input.name, LIMITS.roomNameMin, LIMITS.roomNameMax);
  if (!name) fail('bad_room_name');

  const teamSize = input.teamSize;
  if (!isInt(teamSize) || teamSize < LIMITS.teamSizeMin || teamSize > LIMITS.teamSizeMax) fail('bad_team_size');

  const totalRounds = input.totalRounds;
  if (!isInt(totalRounds) || totalRounds < LIMITS.roundsMin || totalRounds > LIMITS.roundsMax) fail('bad_rounds');

  const rawQuestions = input.questions === undefined ? [] : input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length > LIMITS.questionsMax) fail('bad_question');
  const questions = rawQuestions.map(validateQuestion);

  return { name, isPublic: input.isPublic === true, teamSize, totalRounds, questions };
}
