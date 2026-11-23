import test from 'node:test';
import assert from 'node:assert/strict';
import { bandPoints, scoreRound } from '../src/game/scoring.js';

const q = { target: 50, zoneWidth: 6, points: [2, 3, 4, 3, 2] };

test('الهدف تمامًا = نقاط النطاق الأوسط', () => {
  assert.equal(bandPoints(50, q), 4);
  assert.equal(bandPoints(52.9, q), 4);
  assert.equal(bandPoints(47.1, q), 4);
});

test('النطاقات المتجاورة يمينًا ويسارًا', () => {
  assert.equal(bandPoints(55, q), 3);
  assert.equal(bandPoints(45, q), 3);
  assert.equal(bandPoints(60, q), 2);
  assert.equal(bandPoints(40, q), 2);
});

test('خارج النطاقات = صفر', () => {
  assert.equal(bandPoints(66, q), 0);
  assert.equal(bandPoints(34, q), 0);
  assert.equal(bandPoints(0, q), 0);
  assert.equal(bandPoints(100, q), 0);
});

test('نقاط غير متماثلة تُطبَّق على الجهة الصحيحة', () => {
  const asym = { target: 50, zoneWidth: 6, points: [1, 2, 5, 3, 4] };
  assert.equal(bandPoints(40, asym), 1); // أقصى اليسار
  assert.equal(bandPoints(60, asym), 4); // أقصى اليمين
});

test('الأقرب يأخذ +1 ومن لم يحرّك يأخذ صفرًا', () => {
  const rows = scoreRound(q, [
    { playerId: 'a', team: 'red', pos: 51 },
    { playerId: 'b', team: 'blue', pos: 56 },
  ]);
  assert.deepEqual(rows.map((r) => [r.points, r.bonus, r.total]), [[4, 1, 5], [3, 0, 3]]);

  const rows2 = scoreRound(q, [
    { playerId: 'a', team: 'red', pos: null },
    { playerId: 'b', team: 'blue', pos: 80 },
  ]);
  assert.deepEqual(rows2.map((r) => r.total), [0, 1]); // الأقرب بين من حرّكوا يأخذ البونص حتى خارج النطاقات
});

test('التعادل في القرب يمنح الاثنين البونص، ولا بونص إن لم يحرّك أحد', () => {
  const tie = scoreRound(q, [
    { playerId: 'a', team: 'red', pos: 45 },
    { playerId: 'b', team: 'blue', pos: 55 },
  ]);
  assert.deepEqual(tie.map((r) => r.bonus), [1, 1]);
  const none = scoreRound(q, [{ playerId: 'a', team: 'red', pos: null }]);
  assert.equal(none[0].total, 0);
});
