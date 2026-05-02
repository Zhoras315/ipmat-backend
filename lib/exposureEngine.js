import { runControlLoopIfNeeded, getControlState } from './controlLoop.js';

// ── Constants ────────────────────────────────────────────────────────────────

const INTENSITY_SCORE  = { low: 1, medium: 2, high: 3 };
const DIFFICULTY_SCORE = { light: 1, medium: 2, heavy: 3 };
const TIME_MULTIPLIER  = { long: 0.6, medium: 1.0, short: 1.6 };
const MAX_TASKS        = { long: 1, medium: 2, short: 3 };

const TASK_TYPE_LABEL = {
  focused:  'Focused Practice',
  light:    'Light Review',
  revision: 'Revision',
};

// ── Time horizon ─────────────────────────────────────────────────────────────

export function getTimeHorizon(academicClass) {
  if (academicClass === '11th' || academicClass === 'Class 11') return 'long';
  if (academicClass === '12th' || academicClass === 'Class 12') return 'medium';
  return 'short'; // Dropper / Post-12
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function sessionDensity(topic, horizon) {
  const intensity  = INTENSITY_SCORE[topic.baseline_intensity]  ?? 2;
  const difficulty = DIFFICULTY_SCORE[topic.difficulty_weight]  ?? 2;
  const multiplier = TIME_MULTIPLIER[horizon] ?? 1.0;
  return intensity * difficulty * multiplier;
}

function priorityScore(topic, horizon) {
  const base     = sessionDensity(topic, horizon) / (topic.exposure_count + 1);
  const modifier = topic.priority_modifier ?? 1.0;
  return base * modifier;
}

// ── Task shape derivation ─────────────────────────────────────────────────────

function deriveTaskType(topic, horizon, forceLight) {
  if (topic.exposure_count === 0 || forceLight) return 'light';

  const { difficulty_weight } = topic;
  if (horizon === 'short') return difficulty_weight === 'light' ? 'revision' : 'focused';
  if (horizon === 'long')  return difficulty_weight === 'heavy' ? 'revision' : 'light';
  return difficulty_weight === 'heavy' ? 'focused' : 'revision';
}

function deriveEstimatedTime(topic, taskType) {
  if (taskType === 'light')    return 15;
  if (taskType === 'revision') return 30;
  return topic.difficulty_weight === 'heavy' ? 45 : 30;
}

// ── Core generation ───────────────────────────────────────────────────────────

export function generatePlan(db, studentId, today, horizon) {
  // Idempotent: return existing tasks if already generated for today
  const existing = db.prepare(
    'SELECT COUNT(*) AS n FROM daily_tasks WHERE student_id = ? AND date_assigned = ?'
  ).get(studentId, today);
  if (existing.n > 0) return { generated: false, tasks: fetchTodayTasks(db, studentId, today) };

  // Run control loops if due, then read current state
  runControlLoopIfNeeded(db, studentId, today);
  const ctrl = getControlState(db, studentId, today);

  const rawMax      = MAX_TASKS[horizon] ?? 1;
  const effectiveCap = Math.max(1, rawMax + ctrl.task_cap_adjustment);
  const forceLight   = ctrl.overload_detected;

  // All active topics enriched with exposure and priority_modifier
  const topics = db.prepare(`
    SELECT t.topic_id, t.name, t.difficulty_weight, t.baseline_intensity,
           s.name AS subject_name, s.subject_id,
           COALESCE(te.exposure_count, 0)    AS exposure_count,
           COALESCE(te.priority_modifier, 1) AS priority_modifier
    FROM topics t
    JOIN subjects s ON s.subject_id = t.subject_id
    LEFT JOIN topic_exposure te
      ON te.topic_id = t.topic_id AND te.student_id = ?
    WHERE t.is_active = 1 AND s.is_active = 1
  `).all(studentId);

  // Subjects seen in the last 3 days — for recency balance
  const recentSubjectIds = new Set(
    db.prepare(`
      SELECT DISTINCT s.subject_id
      FROM daily_tasks dt
      JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
      JOIN topics   t ON t.topic_id   = dttl.topic_id
      JOIN subjects s ON s.subject_id = t.subject_id
      WHERE dt.student_id = ?
        AND dt.date_assigned >= date(?, '-3 days')
        AND dt.date_assigned < ?
    `).all(studentId, today, today).map(r => r.subject_id)
  );

  // Score, apply control weights, rank
  const ranked = topics
    .map(t => {
      const recencyPenalty    = recentSubjectIds.has(t.subject_id) ? 0.5 : 1;
      const suppressPenalty   = ctrl.suppressed_subject_ids.includes(t.subject_id) ? 0.3 : 1;
      return {
        ...t,
        score: priorityScore(t, horizon) * recencyPenalty * suppressPenalty,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Select topics respecting effective cap and subject diversity
  const selected    = [];
  const usedSubjects = new Set();

  for (const topic of ranked) {
    if (selected.length >= effectiveCap) break;
    if (!usedSubjects.has(topic.subject_id)) {
      selected.push(topic);
      usedSubjects.add(topic.subject_id);
    }
  }
  if (selected.length < effectiveCap) {
    for (const topic of ranked) {
      if (selected.length >= effectiveCap) break;
      if (!selected.some(s => s.topic_id === topic.topic_id)) selected.push(topic);
    }
  }

  if (selected.length === 0) return { generated: false, tasks: [] };

  const insertTask    = db.prepare(`
    INSERT INTO daily_tasks (student_id, task_type, title, estimated_time, date_assigned)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertLink    = db.prepare(
    'INSERT INTO daily_task_topic_link (task_id, topic_id, is_suggested) VALUES (?, ?, 1)'
  );
  const initExposure  = db.prepare(
    'INSERT OR IGNORE INTO topic_exposure (student_id, topic_id, exposure_count) VALUES (?, ?, 0)'
  );

  db.transaction(() => {
    for (const topic of selected) {
      const derived  = deriveTaskType(topic, horizon, forceLight);
      // Revision eligibility: topic must have prior exposure (exposure_count >= 1)
      const taskType = derived === 'revision' && topic.exposure_count < 1 ? 'light' : derived;
      const estimatedTime = deriveEstimatedTime(topic, taskType);
      const title         = `${topic.name} — ${TASK_TYPE_LABEL[taskType]}`;
      const { lastInsertRowid } = insertTask.run(studentId, taskType, title, estimatedTime, today);
      insertLink.run(lastInsertRowid, topic.topic_id);
      initExposure.run(studentId, topic.topic_id);
    }
  })();

  return { generated: true, tasks: fetchTodayTasks(db, studentId, today) };
}

// ── Outcome handling ──────────────────────────────────────────────────────────

export function applyOutcome(db, taskId, studentId, status) {
  const task = db.prepare(
    'SELECT task_id FROM daily_tasks WHERE task_id = ? AND student_id = ?'
  ).get(taskId, studentId);
  if (!task) return null;

  db.prepare('UPDATE daily_tasks SET status = ? WHERE task_id = ?').run(status, taskId);

  const delta = status === 'done' ? 1 : status === 'partial' ? 0.5 : 0;
  if (delta > 0) {
    const link = db.prepare(
      'SELECT topic_id FROM daily_task_topic_link WHERE task_id = ?'
    ).get(taskId);
    if (link) {
      const today = new Date().toISOString().split('T')[0];
      const existing = db.prepare(
        'SELECT exposure_id FROM topic_exposure WHERE student_id = ? AND topic_id = ?'
      ).get(studentId, link.topic_id);
      if (existing) {
        db.prepare(`
          UPDATE topic_exposure
          SET exposure_count = exposure_count + ?, last_exposed_date = ?
          WHERE student_id = ? AND topic_id = ?
        `).run(delta, today, studentId, link.topic_id);
      } else {
        db.prepare(`
          INSERT INTO topic_exposure (student_id, topic_id, exposure_count, last_exposed_date)
          VALUES (?, ?, ?, ?)
        `).run(studentId, link.topic_id, delta, today);
      }
    }
  }

  return db.prepare(`
    SELECT dt.task_id, dt.student_id, dt.task_type, dt.title,
           dt.estimated_time, dt.date_assigned, dt.status,
           t.name AS topic_name, s.name AS subject_name
    FROM daily_tasks dt
    LEFT JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
    LEFT JOIN topics   t ON t.topic_id   = dttl.topic_id
    LEFT JOIN subjects s ON s.subject_id = t.subject_id
    WHERE dt.task_id = ?
  `).get(taskId);
}

// ── Internal fetch ────────────────────────────────────────────────────────────

export function fetchTodayTasks(db, studentId, today) {
  return db.prepare(`
    SELECT dt.task_id, dt.student_id, dt.task_type, dt.title,
           dt.estimated_time, dt.date_assigned, dt.status,
           t.name AS topic_name, s.name AS subject_name
    FROM daily_tasks dt
    LEFT JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
    LEFT JOIN topics   t ON t.topic_id   = dttl.topic_id
    LEFT JOIN subjects s ON s.subject_id = t.subject_id
    WHERE dt.student_id = ? AND dt.date_assigned = ?
    ORDER BY dt.task_id ASC
  `).all(studentId, today);
}
