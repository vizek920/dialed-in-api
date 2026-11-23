// حساب النقاط. المواقع كلها نسب من 0 إلى 100 على المقياس
// (0 = الطرف الأيسر، 100 = الطرف الأيمن).

// نقاط النطاق الذي وقع فيه المؤشر. النطاقات الخمسة متجاورة وعرض كل منها zoneWidth
// والنطاق الأوسط محوره الهدف تمامًا. خارجها = صفر.
export function bandPoints(pos, q) {
  const k = Math.floor((pos - q.target + 2.5 * q.zoneWidth) / q.zoneWidth);
  return k >= 0 && k <= 4 ? q.points[k] : 0;
}

// entries: [{ playerId, team, pos }]  حيث pos = null إن لم يحرّك اللاعب مؤشره.
// القواعد: كل لاعب يأخذ نقاط نطاقه، ومن لم يحرّك مؤشره يأخذ صفرًا،
// والأقرب إلى الهدف بين من حرّكوا يأخذ +1 (وكذلك من تساووا في القرب).
export function scoreRound(q, entries) {
  const rows = entries.map((e) => {
    const moved = typeof e.pos === 'number';
    return {
      playerId: e.playerId,
      team: e.team,
      pos: moved ? e.pos : null,
      distance: moved ? Math.abs(e.pos - q.target) : null,
      points: moved ? bandPoints(e.pos, q) : 0,
      bonus: 0,
      total: 0,
    };
  });

  const movedRows = rows.filter((r) => r.distance !== null);
  if (movedRows.length) {
    const best = Math.min(...movedRows.map((r) => r.distance));
    for (const r of movedRows) {
      if (Math.abs(r.distance - best) < 1e-9) r.bonus = 1;
    }
  }
  for (const r of rows) r.total = r.points + r.bonus;
  return rows;
}
