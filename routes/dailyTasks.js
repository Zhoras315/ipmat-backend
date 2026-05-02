import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { generateDailyPlan } from '../lib/planGenerator.js';

const router = Router();

// Get daily tasks for a specific date (only the logged-in user's tasks)
router.get('/', authenticate, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required (YYYY-MM-DD)' });
    }

    const tasks = db.prepare(`
      SELECT dt.id, dt.user_id, dt.date, dt.status, dt.created_at,
             tt.id AS template_id, tt.task_type, tt.duration_minutes, tt.difficulty,
             sb.id AS skill_bucket_id, sb.name AS skill_bucket_name
      FROM generated_tasks dt
      JOIN task_templates tt ON dt.task_template_id = tt.id
      JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
      WHERE dt.user_id = ? AND dt.date = ?
      ORDER BY dt.created_at ASC
    `).all(req.user.id, date);

    res.json({ tasks });
  } catch (err) {
    console.error('Get daily tasks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a daily task with all constraint checks
router.post('/', authenticate, (req, res) => {
  try {
    const { date, task_template_id } = req.body;

    if (!date || !task_template_id) {
      return res.status(400).json({ error: 'date and task_template_id are required' });
    }

    // Constraint 4: task_template_id must reference an existing TaskTemplate
    const template = db.prepare(
      'SELECT * FROM task_templates WHERE id = ?'
    ).get(task_template_id);
    if (!template) {
      return res.status(400).json({ error: 'task_template_id does not reference an existing TaskTemplate' });
    }

    // Constraint 1: max 2 DailyTasks per user per day
    const { count } = db.prepare(
      'SELECT COUNT(*) AS count FROM generated_tasks WHERE user_id = ? AND date = ?'
    ).get(req.user.id, date);
    if (count >= 2) {
      return res.status(400).json({ error: 'Maximum of 2 daily tasks allowed per day' });
    }

    // Constraint 3: total duration must not exceed available_study_minutes
    const profile = db.prepare(
      'SELECT available_study_minutes FROM profiles WHERE user_id = ?'
    ).get(req.user.id);
    if (profile && profile.available_study_minutes != null) {
      const { used } = db.prepare(`
        SELECT COALESCE(SUM(tt.duration_minutes), 0) AS used
        FROM generated_tasks dt
        JOIN task_templates tt ON dt.task_template_id = tt.id
        WHERE dt.user_id = ? AND dt.date = ?
      `).get(req.user.id, date);

      if (used + template.duration_minutes > profile.available_study_minutes) {
        return res.status(400).json({
          error: `Adding this task would exceed your available study time. Used: ${used} min, Limit: ${profile.available_study_minutes} min, This task: ${template.duration_minutes} min`
        });
      }
    }

    const result = db.prepare(
      'INSERT INTO generated_tasks (user_id, date, task_template_id) VALUES (?, ?, ?)'
    ).run(req.user.id, date, task_template_id);

    const task = db.prepare(`
      SELECT dt.id, dt.user_id, dt.date, dt.status, dt.created_at,
             tt.id AS template_id, tt.task_type, tt.duration_minutes, tt.difficulty,
             sb.id AS skill_bucket_id, sb.name AS skill_bucket_name
      FROM generated_tasks dt
      JOIN task_templates tt ON dt.task_template_id = tt.id
      JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
      WHERE dt.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ task });
  } catch (err) {
    console.error('Create daily task error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate today's plan (idempotent — safe to call on every login)
router.post('/generate', authenticate, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = generateDailyPlan(db, req.user.id, today);
    res.json(result);
  } catch (err) {
    console.error('Generate plan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Explain why today's plan was generated the way it was
router.get('/explain', authenticate, (req, res) => {
  try {
    const today = new Date();
    const todayStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');

    const prev = new Date(today);
    prev.setDate(prev.getDate() - 1);
    const yesterdayStr = [
      prev.getFullYear(),
      String(prev.getMonth() + 1).padStart(2, '0'),
      String(prev.getDate()).padStart(2, '0'),
    ].join('-');

    const profile = db.prepare(
      'SELECT * FROM profiles WHERE user_id = ?'
    ).get(req.user.id);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const yesterdayTasks = db.prepare(`
      SELECT status, task_type
      FROM daily_tasks
      WHERE student_id = ? AND date_assigned = ?
    `).all(req.user.id, yesterdayStr);

    const todayTasks = db.prepare(`
      SELECT dt.task_type, t.difficulty_weight
      FROM daily_tasks dt
      LEFT JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
      LEFT JOIN topics t ON t.topic_id = dttl.topic_id
      WHERE dt.student_id = ? AND dt.date_assigned = ?
    `).all(req.user.id, todayStr);

    const bullets = buildExplanation(profile, yesterdayTasks, todayTasks);
    res.json({ bullets });
  } catch (err) {
    console.error('Explain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function buildExplanation(profile, yesterdayTasks, todayTasks) {
  const bullets = [];
  const schoolHours = profile.school_hours_per_day || 6;

  // 1 — School workload
  if (schoolHours >= 7) {
    bullets.push("School is on the heavier side today, so the plan is kept short.");
  } else if (schoolHours <= 4) {
    bullets.push("With a lighter school day, there's more room for a focused session.");
  } else {
    bullets.push("It's a regular school day, so the plan fits comfortably around it.");
  }

  // 2 — Yesterday's outcome (skip if no history yet)
  if (yesterdayTasks.length > 0) {
    const anySkipped = yesterdayTasks.some(t => t.status === 'skipped');
    const anyPartial = yesterdayTasks.some(t => t.status === 'partial');
    const allDone    = yesterdayTasks.every(t => t.status === 'done');

    if (anySkipped) {
      bullets.push("Yesterday had a session that was skipped, so today eases in a little.");
    } else if (anyPartial) {
      bullets.push("Yesterday's session was partly done, so today is kept gentle.");
    } else if (allDone) {
      bullets.push("Yesterday's session was completed, so today continues at a steady pace.");
    }
  }

  // 3 — Nature of today's tasks
  if (todayTasks.length > 0) {
    const types      = todayTasks.map(t => t.task_type);
    const hasFocused = types.includes('focused');
    const hasRevision = types.includes('revision');
    const hasLight   = types.includes('light');

    if (hasFocused && todayTasks.length >= 2) {
      bullets.push("One focused session is paired with lighter work to keep things balanced.");
    } else if (hasFocused) {
      bullets.push("There's enough time today for a focused practice session.");
    } else if (hasRevision) {
      bullets.push("Today focuses on revision to keep things moving without adding pressure.");
    } else if (hasLight) {
      bullets.push("A light review keeps preparation steady today.");
    }
  }

  return bullets.slice(0, 3);
}

// Update status (constraint 2: only the owner can update)
router.patch('/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'done', 'partial', 'skipped'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }

    // Constraint 2: task must belong to the logged-in user
    const task = db.prepare(
      'SELECT id FROM generated_tasks WHERE id = ? AND user_id = ?'
    ).get(id, req.user.id);
    if (!task) {
      return res.status(404).json({ error: 'Daily task not found' });
    }

    db.prepare('UPDATE generated_tasks SET status = ? WHERE id = ?').run(status, id);

    const updated = db.prepare(`
      SELECT dt.id, dt.user_id, dt.date, dt.status, dt.created_at,
             tt.id AS template_id, tt.task_type, tt.duration_minutes, tt.difficulty,
             sb.id AS skill_bucket_id, sb.name AS skill_bucket_name
      FROM generated_tasks dt
      JOIN task_templates tt ON dt.task_template_id = tt.id
      JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
      WHERE dt.id = ?
    `).get(id);

    res.json({ task: updated });
  } catch (err) {
    console.error('Update daily task error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete (constraint 2: only the owner can delete)
router.delete('/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;

    // Constraint 2: task must belong to the logged-in user
    const task = db.prepare(
      'SELECT id FROM generated_tasks WHERE id = ? AND user_id = ?'
    ).get(id, req.user.id);
    if (!task) {
      return res.status(404).json({ error: 'Daily task not found' });
    }

    db.prepare('DELETE FROM generated_tasks WHERE id = ?').run(id);
    res.json({ message: 'Daily task deleted' });
  } catch (err) {
    console.error('Delete daily task error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
