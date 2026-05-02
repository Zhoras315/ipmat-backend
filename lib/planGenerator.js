const DIFFICULTY = ['easy', 'medium', 'heavy'];
const TYPE_PRIORITY = { focused_practice: 2, revision: 1, light_review: 0 };

function getYesterday(todayStr) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const date = new Date(y, m - 1, d - 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function classifyCapacity(schoolHours, yesterdayTasks) {
  const anySkipped = yesterdayTasks.some(t => t.status === 'skipped');
  const allDone =
    yesterdayTasks.length > 0 && yesterdayTasks.every(t => t.status === 'done');

  if (schoolHours >= 7 || anySkipped) return 'low';
  if (schoolHours <= 4 && allDone) return 'high';
  return 'normal';
}

function buildConstraints(capacity, yesterdayTasks) {
  const anySkipped = yesterdayTasks.some(t => t.status === 'skipped');
  const anyPartial = yesterdayTasks.some(t => t.status === 'partial');

  let maxTasks, maxFocused, allowedTypes, maxDurationPerTask, diffCap;

  switch (capacity) {
    case 'low':
      maxTasks = 1;
      maxFocused = 0;
      allowedTypes = ['revision', 'light_review'];
      maxDurationPerTask = 45;
      diffCap = 'easy';
      break;
    case 'high':
      maxTasks = 2;
      maxFocused = 2;
      allowedTypes = ['focused_practice', 'revision', 'light_review'];
      maxDurationPerTask = null;
      diffCap = 'heavy';
      break;
    default: // normal
      maxTasks = 2;
      maxFocused = 1;
      allowedTypes = ['focused_practice', 'revision', 'light_review'];
      maxDurationPerTask = null;
      diffCap = 'medium';
  }

  // Difficulty + type downgrade based on yesterday's outcome
  if (anySkipped) {
    allowedTypes = allowedTypes.filter(t => t !== 'focused_practice');
    maxFocused = 0;
    diffCap = DIFFICULTY[Math.max(0, DIFFICULTY.indexOf(diffCap) - 1)];
  } else if (anyPartial) {
    diffCap = DIFFICULTY[Math.max(0, DIFFICULTY.indexOf(diffCap) - 1)];
  }

  return { maxTasks, maxFocused, allowedTypes, maxDurationPerTask, diffCap };
}

function rankBuckets(db, userId, today) {
  // Find the last date each bucket was used (before today)
  const rows = db.prepare(`
    SELECT sb.id, sb.name, MAX(dt.date) AS last_used
    FROM skill_buckets sb
    LEFT JOIN task_templates tt ON tt.skill_bucket_id = sb.id
    LEFT JOIN generated_tasks dt
      ON dt.task_template_id = tt.id
      AND dt.user_id = ?
      AND dt.date < ?
    GROUP BY sb.id
    ORDER BY last_used ASC NULLS FIRST
  `).all(userId, today);

  const quantVerbal = rows.filter(r => r.name === 'Quantitative' || r.name === 'Verbal');
  const other = rows.filter(r => r.name !== 'Quantitative' && r.name !== 'Verbal');

  // Primary must be Quant or Verbal — pick least recently used
  const primary = quantVerbal[0];
  // Secondary preference: other Quant/Verbal first, then Logical Reasoning
  const secondaryCandidates = [...quantVerbal.slice(1), ...other];

  return { primary, secondaryCandidates };
}

function pickTemplate(templates, constraints, usedIds, focusedCount) {
  const { allowedTypes, maxDurationPerTask, diffCap, maxFocused } = constraints;
  const maxDiffIdx = DIFFICULTY.indexOf(diffCap);

  const candidates = templates.filter(t =>
    allowedTypes.includes(t.task_type) &&
    DIFFICULTY.indexOf(t.difficulty) <= maxDiffIdx &&
    (maxDurationPerTask === null || t.duration_minutes <= maxDurationPerTask) &&
    !usedIds.has(t.id) &&
    !(t.task_type === 'focused_practice' && focusedCount >= maxFocused)
  );

  if (candidates.length === 0) return null;

  // Prefer higher task type priority, then harder difficulty
  candidates.sort((a, b) => {
    const typeDiff = TYPE_PRIORITY[b.task_type] - TYPE_PRIORITY[a.task_type];
    if (typeDiff !== 0) return typeDiff;
    return DIFFICULTY.indexOf(b.difficulty) - DIFFICULTY.indexOf(a.difficulty);
  });

  return candidates[0];
}

export function generateDailyPlan(db, userId, today) {
  // Idempotent: return existing tasks if already generated
  const existing = db.prepare(
    'SELECT COUNT(*) AS count FROM generated_tasks WHERE user_id = ? AND date = ?'
  ).get(userId, today);

  if (existing.count > 0) {
    const tasks = fetchTasks(db, userId, today);
    return { generated: false, reason: 'already_exists', tasks };
  }

  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (!profile) {
    return { generated: false, reason: 'no_profile', tasks: [] };
  }

  const yesterday = getYesterday(today);
  const yesterdayTasks = db.prepare(`
    SELECT dt.status, tt.task_type, tt.difficulty, sb.name AS skill_bucket
    FROM generated_tasks dt
    JOIN task_templates tt ON dt.task_template_id = tt.id
    JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
    WHERE dt.user_id = ? AND dt.date = ?
  `).all(userId, yesterday);

  const capacity = classifyCapacity(profile.school_hours_per_day || 6, yesterdayTasks);
  const constraints = buildConstraints(capacity, yesterdayTasks);
  const availableMinutes = profile.available_study_minutes || 90;

  const allTemplates = db.prepare(`
    SELECT tt.*, sb.name AS skill_bucket_name
    FROM task_templates tt
    JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
  `).all();

  const { primary, secondaryCandidates } = rankBuckets(db, userId, today);

  const selected = [];
  const usedIds = new Set();
  let remainingMinutes = availableMinutes;
  let focusedCount = 0;

  // Slot 1 — must come from Quant or Verbal
  const primaryPool = allTemplates
    .filter(t => t.skill_bucket_id === primary.id && t.duration_minutes <= remainingMinutes);
  const pick1 = pickTemplate(primaryPool, constraints, usedIds, focusedCount);

  if (pick1) {
    selected.push(pick1);
    usedIds.add(pick1.id);
    remainingMinutes -= pick1.duration_minutes;
    if (pick1.task_type === 'focused_practice') focusedCount++;
  }

  // Slot 2 — different bucket, only if capacity allows and time remains
  if (constraints.maxTasks >= 2 && remainingMinutes > 0) {
    for (const bucket of secondaryCandidates) {
      const pool = allTemplates.filter(
        t => t.skill_bucket_id === bucket.id && t.duration_minutes <= remainingMinutes
      );
      const pick2 = pickTemplate(pool, constraints, usedIds, focusedCount);
      if (pick2) {
        selected.push(pick2);
        break;
      }
    }
  }

  if (selected.length === 0) {
    return { generated: false, reason: 'no_suitable_templates', tasks: [] };
  }

  const insert = db.prepare(
    'INSERT INTO generated_tasks (user_id, date, task_template_id) VALUES (?, ?, ?)'
  );
  db.transaction(() => {
    for (const t of selected) insert.run(userId, today, t.id);
  })();

  return { generated: true, capacity, tasks: fetchTasks(db, userId, today) };
}

function fetchTasks(db, userId, date) {
  return db.prepare(`
    SELECT dt.id, dt.user_id, dt.date, dt.status, dt.created_at,
           tt.id AS template_id, tt.task_type, tt.duration_minutes, tt.difficulty,
           sb.id AS skill_bucket_id, sb.name AS skill_bucket_name
    FROM generated_tasks dt
    JOIN task_templates tt ON dt.task_template_id = tt.id
    JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
    WHERE dt.user_id = ? AND dt.date = ?
    ORDER BY dt.created_at ASC
  `).all(userId, date);
}
