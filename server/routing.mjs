// Pyrus не хранит длительность у «Дата и время смены» — берём её из «Время работы» шаблона («9:00-18:00»)
export function durationFromShift(v) {
  const vals = Array.isArray(v?.values) ? v.values : [];
  for (const s of vals) {
    const m = String(s || '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/);
    if (!m) continue;
    let d = (+m[3] * 60 + +m[4]) - (+m[1] * 60 + +m[2]);
    if (d <= 0) d += 24 * 60; // ночная смена через полночь
    return d;
  }
  return 0;
}

export function scheduleRows({ members, tasks, telephony, now }) {
  const F = { dept: 1, person: 2, due: 3, shift: 5 };
  const LOCAL_OFFSET_MIN = 240; // UTC+4 — только для читаемых date_open/date_close

  const byId = new Map(members.map(m => [m.id, m]));

  const telMap = new Map();
  const durMap = new Map();
  for (const r of telephony) {
    if (r.task_id != null && r.task_id !== '') {
      telMap.set(Number(r.task_id), r.telephony !== false);
      if (r.duration_min != null && r.duration_min !== '' && Number(r.duration_min) > 0) durMap.set(Number(r.task_id), Number(r.duration_min));
    }
  }

  const from = now - 36 * 3600e3; // вчера
  const to = now + 3 * 86400e3;   // +3 дня

  const fmtLocal = ms => new Date(ms + LOCAL_OFFSET_MIN * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const catText = v => (Array.isArray(v?.values) ? v.values.filter(Boolean)[0] : v?.name) || '';

  const out = [];
  for (const t of tasks) {
    const f = id => (t.fields || []).find(x => x.id === id);
    const due = f(F.due);
    const person = f(F.person);
    if (!due?.value || !person?.value?.id) continue;
    const start = new Date(due.value).getTime();
    if (Number.isNaN(start)) continue;
    // сначала длительность, сохранённая сайтом (важна для кастомных смен), потом duration Pyrus, потом шаблон
    const durationMin = durMap.get(Number(t.id)) || Number(due.duration || 0) || durationFromShift(f(F.shift)?.value);
    const end = start + durationMin * 60000;
    if (end < from || start > to) continue;
    const m = byId.get(person.value.id) || {};
    out.push({
      task_id: t.id,
      person_id: person.value.id, // id сотрудника Pyrus — по нему исключаем ушедших на обед
      phone_number: String(m.phone || '').replace(/\D+/g, ''),
      name: `${m.last_name || ''} ${m.first_name || ''}`.trim(),
      date_open: fmtLocal(start),
      date_close: fmtLocal(end),
      start_utc: new Date(start).toISOString(),
      end_utc: new Date(end).toISOString(),
      podrazdelenie: catText(f(F.dept)?.value),
      smena: catText(f(F.shift)?.value),
      telephony: telMap.has(Number(t.id)) ? telMap.get(Number(t.id)) : true,
    });
  }
  return out;
}

export function departmentRoster({ members, roles, mango }) {
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).sort().join(' ');
  const DEPTS = [
    { key: 'TP', roleId: 1329812 },
  ];
  const byMemberId = new Map(members.map((m) => [m.id, m]));
  const byNumber = new Map(mango.filter((u) => u.number).map((u) => [String(u.number), u]));
  const byName = new Map(mango.map((u) => [norm(u.user_name), u]));

  const out = [];
  for (const dept of DEPTS) {
    const role = roles.find((r) => r.id === dept.roleId && !r.banned);
    for (const id of role?.member_ids || []) {
      const m = byMemberId.get(id);
      if (!m || m.banned) continue;
      const phone = String(m.phone || '').replace(/\D+/g, '');
      const fullName = `${m.last_name || ''} ${m.first_name || ''}`.trim();
      const u = (phone && byNumber.get(phone)) || byName.get(norm(fullName));
      if (!u) continue;
      out.push({
        key: `${dept.key}_${u.user_id}`,
        dept: dept.key,
        mango_user_id: String(u.user_id),
        person_id: m.id,
        name: fullName,
      });
    }
  }
  return out;
}

function activeShifts({ schedules, mangoUsers, lunches, now }) {
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).sort().join(' ');
  const mango = mangoUsers;
  const byNumber = new Map(mango.filter(u => u.number).map(u => [String(u.number), u]));
  const byName = new Map(mango.map(u => [norm(u.user_name), u]));

  const activeLunches = lunches.filter(l => l.status === 'active');
  const lunchIds = new Set(activeLunches.map(l => Number(l.member_id)));
  const lunchNames = new Set(activeLunches.map(l => norm(l.name)));
  const onLunch = r => (r.person_id != null && r.person_id !== '' && lunchIds.has(Number(r.person_id))) || lunchNames.has(norm(r.name));

  return schedules
    .filter(r => Date.parse(r.start_utc) <= now && now < Date.parse(r.end_utc))
    .filter(r => r.telephony !== false)
    .filter(r => !onLunch(r))
    .map(r => {
      const phone = String(r.phone_number || '').replace(/\D+/g, '');
      const u = (phone && byNumber.get(phone)) || byName.get(norm(r.name));
      return {
        phone_number: u ? String(u.number) : phone,
        name: r.name,
        date_open: r.date_open,
        date_close: r.date_close,
        podrazd: String(r.podrazdelenie || '').trim().toUpperCase(),
        smena: r.smena,
      };
    });
}

export function mangoGroups({ schedules, mangoUsers, lunches, rosterRows, groupId, now }) {
  const LOCAL_OFFSET_MIN = 240; // UTC+4
  const localHour = new Date(now + LOCAL_OFFSET_MIN * 60000).getUTCHours();
  const isWorkingHours = localHour >= 9 && localHour < 21;

  const byNumber = new Map(mangoUsers.filter((u) => u.number).map((u) => [String(u.number), u]));

  const rosterByDept = new Map();
  for (const r of rosterRows) {
    if (!r || r.mango_user_id == null) continue;
    const arr = rosterByDept.get(r.dept) || [];
    arr.push({ id: String(r.mango_user_id), personId: Number(r.person_id), name: r.name });
    rosterByDept.set(r.dept, arr);
  }

  const shiftRows = activeShifts({ schedules, mangoUsers, lunches, now });

  // Кто сейчас на обеде (до тех пор, пока сам не нажал «вернулся») — их не включаем и в аварийный состав
  const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).sort().join(' ');
  const activeLunches = lunches.filter(l => l?.status === 'active');
  const lunchNames = activeLunches.map(l => l.name);
  const lunchIds = new Set(activeLunches.map(l => Number(l.member_id)).filter(Boolean));
  const lunchSet = new Set(lunchNames.map(normName));

  const DEPTS = [
    { key: 'TP', name: 'ТП', groupId },
  ];

  const results = [];
  for (const dept of DEPTS) {
    const onShift = shiftRows.filter((r) => r.podrazd === dept.name);
    const matchedIds = [...new Set(
      onShift.map((r) => byNumber.get(String(r.phone_number))).filter(Boolean).map((u) => String(u.user_id))
    )];

    let operatorIds = matchedIds;
    let isFallback = false;
    let fallbackNames = [];
    if (operatorIds.length === 0 && isWorkingHours) {
      isFallback = true;
      const roster = (rosterByDept.get(dept.key) || []).filter(r => !lunchIds.has(r.personId) && !lunchSet.has(normName(r.name)));
      operatorIds = [...new Set(roster.map((r) => r.id))];
      fallbackNames = roster.map((r) => r.name);
    }

    const payload = { group_id: dept.groupId, group: { operators: operatorIds.map((id) => ({ id })) } };
    results.push({
      payload,
      dept: dept.key,
      deptName: dept.name,
      isFallback,
      operatorCount: operatorIds.length,
      fallbackNames,
      lunchNames,
    });
  }

  return results;
}
