// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr + 'T00:00:00').getTime()) / 86400000);
}

function dateOffset(today, days) {
  const d = new Date(today + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function weekStart(today) {
  const d = new Date(today + 'T00:00:00');
  d.setDate(d.getDate() - 6);
  return d.toISOString().split('T')[0];
}

// ── Aggregate computation ─────────────────────────────────────────────────────

function computeAggregates(db, studentId) {
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'done'    AND date_assigned >= date('now','-7 days')  THEN 1 END) AS completed_tasks_7d,
      COUNT(CASE WHEN status = 'partial' AND date_assigned >= date('now','-7 days')  THEN 1 END) AS partial_tasks_7d,
      COUNT(CASE WHEN status = 'skipped' AND date_assigned >= date('now','-7 days')  THEN 1 END) AS skipped_tasks_7d,
      COUNT(CASE WHEN status = 'done'    AND date_assigned >= date('now','-30 days') THEN 1 END) AS completed_tasks_30d,
      COUNT(CASE WHEN status = 'skipped' AND date_assigned >= date('now','-30 days') THEN 1 END) AS skipped_tasks_30d
    FROM daily_tasks
    WHERE student_id = ?
  `).get(studentId);
}

function upsertAggregates(db, studentId, aggs) {
  const now = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO task_outcome_aggregates
      (student_id, completed_tasks_7d, partial_tasks_7d, skipped_tasks_7d,
       completed_tasks_30d, skipped_tasks_30d, last_computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      completed_tasks_7d  = excluded.completed_tasks_7d,
      partial_tasks_7d    = excluded.partial_tasks_7d,
      skipped_tasks_7d    = excluded.skipped_tasks_7d,
      completed_tasks_30d = excluded.completed_tasks_30d,
      skipped_tasks_30d   = excluded.skipped_tasks_30d,
      last_computed_at    = excluded.last_computed_at
  `).run(
    studentId,
    aggs.completed_tasks_7d, aggs.partial_tasks_7d, aggs.skipped_tasks_7d,
    aggs.completed_tasks_30d, aggs.skipped_tasks_30d, now
  );
}

// ── Overload detection ────────────────────────────────────────────────────────

function detectOverload(aggs) {
  const { skipped_tasks_7d: skipped, completed_tasks_7d: done } = aggs;
  // Only trigger if meaningful activity exists (≥2 skips, and skips ≥ completions)
  return skipped >= 2 && skipped >= done;
}

// ── Subject load ──────────────────────────────────────────────────────────────

function computeSubjectLoads(db, studentId, from) {
  const rows = db.prepare(`
    SELECT s.subject_id, s.name AS subject_name, COUNT(*) AS tasks_assigned
    FROM daily_tasks dt
    JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
    JOIN topics   t ON t.topic_id   = dttl.topic_id
    JOIN subjects s ON s.subject_id = t.subject_id
    WHERE dt.student_id = ? AND dt.date_assigned >= ?
    GROUP BY s.subject_id
  `).all(studentId, from);

  if (rows.length === 0) return [];

  const avgLoad = rows.reduce((s, r) => s + r.tasks_assigned, 0) / rows.length;
  return rows.map(r => ({
    ...r,
    load_index: r.tasks_assigned / 7,
    is_dominant: r.tasks_assigned > avgLoad * 2.0,
  }));
}

function persistSubjectLoads(db, studentId, loads, weekStartDate) {
  const now = new Date().toISOString().split('T')[0];
  const stmt = db.prepare(`
    INSERT INTO subject_load_index
      (student_id, subject_id, week_start, tasks_assigned, available_days, load_index, computed_at)
    VALUES (?, ?, ?, ?, 7, ?, ?)
    ON CONFLICT(student_id, subject_id, week_start) DO UPDATE SET
      tasks_assigned = excluded.tasks_assigned,
      load_index     = excluded.load_index,
      computed_at    = excluded.computed_at
  `);
  db.transaction(() => {
    for (const l of loads) stmt.run(studentId, l.subject_id, weekStartDate, l.tasks_assigned, l.load_index, now);
  })();
}

// ── Control state helpers ─────────────────────────────────────────────────────

function upsertControlState(db, studentId, updates) {
  const current = db.prepare(
    'SELECT * FROM system_control_state WHERE student_id = ?'
  ).get(studentId) || {};

  const next = {
    task_cap_adjustment:    current.task_cap_adjustment    ?? 0,
    suppressed_subject_ids: current.suppressed_subject_ids ?? '[]',
    suppression_expires_at: current.suppression_expires_at ?? null,
    overload_detected:      current.overload_detected      ?? 0,
    weekly_loop_last_run:   current.weekly_loop_last_run   ?? null,
    monthly_loop_last_run:  current.monthly_loop_last_run  ?? null,
    ...updates,
  };

  db.prepare(`
    INSERT INTO system_control_state
      (student_id, task_cap_adjustment, suppressed_subject_ids, suppression_expires_at,
       overload_detected, weekly_loop_last_run, monthly_loop_last_run)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      task_cap_adjustment    = excluded.task_cap_adjustment,
      suppressed_subject_ids = excluded.suppressed_subject_ids,
      suppression_expires_at = excluded.suppression_expires_at,
      overload_detected      = excluded.overload_detected,
      weekly_loop_last_run   = CASE WHEN excluded.weekly_loop_last_run IS NOT NULL
                                    THEN excluded.weekly_loop_last_run
                                    ELSE system_control_state.weekly_loop_last_run END,
      monthly_loop_last_run  = CASE WHEN excluded.monthly_loop_last_run IS NOT NULL
                                    THEN excluded.monthly_loop_last_run
                                    ELSE system_control_state.monthly_loop_last_run END
  `).run(
    studentId,
    next.task_cap_adjustment,
    next.suppressed_subject_ids,
    next.suppression_expires_at,
    next.overload_detected,
    next.weekly_loop_last_run,
    next.monthly_loop_last_run
  );
}

// ── Weekly rebalancing loop ───────────────────────────────────────────────────

function runWeeklyLoop(db, studentId, today) {
  const aggs  = computeAggregates(db, studentId);
  upsertAggregates(db, studentId, aggs);

  const from  = weekStart(today);
  const loads = computeSubjectLoads(db, studentId, from);
  persistSubjectLoads(db, studentId, loads, from);

  const overloaded = detectOverload(aggs);
  const dominant   = loads.find(l => l.is_dominant) || null;

  const updates = { weekly_loop_last_run: today };

  if (overloaded) {
    updates.task_cap_adjustment    = -1;
    updates.overload_detected      = 1;
    updates.suppression_expires_at = dateOffset(today, 7);
  } else {
    // Clear overload state if student has recovered
    updates.task_cap_adjustment = 0;
    updates.overload_detected   = 0;
  }

  if (dominant && !overloaded) {
    // Suppress dominant subject for 3 days, but don't stack with overload reduction
    updates.suppressed_subject_ids = JSON.stringify([dominant.subject_id]);
    updates.suppression_expires_at = dateOffset(today, 3);
  } else if (!overloaded) {
    updates.suppressed_subject_ids = '[]';
    updates.suppression_expires_at = null;
  }

  upsertControlState(db, studentId, updates);
}

// ── Monthly stability loop ────────────────────────────────────────────────────

function runMonthlyLoop(db, studentId, today) {
  // Recompute rolling frequencies for all topics this student has ever seen
  const topics = db.prepare(`
    SELECT te.topic_id
    FROM topic_exposure te
    WHERE te.student_id = ?
  `).all(studentId);

  const freq30Stmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM daily_tasks dt
    JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
    WHERE dt.student_id = ? AND dttl.topic_id = ?
      AND dt.date_assigned >= date(?, '-30 days')
      AND dt.status != 'skipped'
  `);
  const freq90Stmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM daily_tasks dt
    JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
    WHERE dt.student_id = ? AND dttl.topic_id = ?
      AND dt.date_assigned >= date(?, '-90 days')
      AND dt.status != 'skipped'
  `);
  const updateFreqStmt = db.prepare(`
    UPDATE topic_exposure
    SET rolling_30_day_frequency = ?,
        rolling_90_day_frequency = ?
    WHERE student_id = ? AND topic_id = ?
  `);
  const updateModifierStmt = db.prepare(`
    UPDATE topic_exposure
    SET priority_modifier = ?
    WHERE student_id = ? AND topic_id = ?
  `);

  db.transaction(() => {
    for (const { topic_id } of topics) {
      const f30 = freq30Stmt.get(studentId, topic_id, today).n;
      const f90 = freq90Stmt.get(studentId, topic_id, today).n;

      updateFreqStmt.run(f30, f90, studentId, topic_id);

      // Neglected: not seen in 45+ days
      const te = db.prepare(
        'SELECT last_exposed_date FROM topic_exposure WHERE student_id = ? AND topic_id = ?'
      ).get(studentId, topic_id);

      const sinceExposure = daysSince(te?.last_exposed_date);
      let modifier = 1.0;
      if (sinceExposure >= 45) modifier = 1.5;      // gently resurface
      else if (f30 >= 8)       modifier = 0.6;      // cool down overexposed

      updateModifierStmt.run(modifier, studentId, topic_id);
    }
  })();

  upsertControlState(db, studentId, { monthly_loop_last_run: today });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function runControlLoopIfNeeded(db, studentId, today) {
  const state = db.prepare(
    'SELECT weekly_loop_last_run, monthly_loop_last_run FROM system_control_state WHERE student_id = ?'
  ).get(studentId);

  const weeklyDue  = !state || daysSince(state.weekly_loop_last_run)  >= 7;
  const monthlyDue = !state || daysSince(state.monthly_loop_last_run) >= 30;

  if (weeklyDue)  runWeeklyLoop(db, studentId, today);
  if (monthlyDue) runMonthlyLoop(db, studentId, today);
}

export function getControlState(db, studentId, today) {
  const state = db.prepare(
    'SELECT * FROM system_control_state WHERE student_id = ?'
  ).get(studentId);

  if (!state) return {
    task_cap_adjustment: 0,
    suppressed_subject_ids: [],
    overload_detected: false,
  };

  // Clear expired suppression
  const suppressedIds = JSON.parse(state.suppressed_subject_ids || '[]');
  const suppActive = state.suppression_expires_at && state.suppression_expires_at >= today;

  return {
    task_cap_adjustment:    state.task_cap_adjustment ?? 0,
    suppressed_subject_ids: suppActive ? suppressedIds : [],
    overload_detected:      !!state.overload_detected,
  };
}
