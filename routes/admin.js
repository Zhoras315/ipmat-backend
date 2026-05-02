import { Router } from 'express';
import db from '../db.js';
import { adminOnly } from '../middleware/admin.js';

const router = Router();

// All admin routes require admin auth
router.use(adminOnly);

// ── User list (all non-admin users with full context) ────────────────────────
router.get('/users', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.name, u.email,
             u.email_verified, u.auth_provider, u.created_at,
             p.class, p.age, p.school_hours_per_day,
             p.available_study_minutes, p.plan_start_date,
             toa.completed_tasks_7d, toa.partial_tasks_7d, toa.skipped_tasks_7d,
             toa.completed_tasks_30d, toa.skipped_tasks_30d,
             scs.overload_detected, scs.task_cap_adjustment
      FROM users u
      LEFT JOIN profiles p   ON p.user_id    = u.id
      LEFT JOIN task_outcome_aggregates toa ON toa.student_id = u.id
      LEFT JOIN system_control_state    scs ON scs.student_id = u.id
      WHERE u.is_admin = 0
      ORDER BY u.created_at DESC
    `).all();

    res.json({ users });
  } catch (err) {
    console.error('Admin /users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete a user account ─────────────────────────────────────────────────────
router.delete('/users/:id', (req, res) => {
  try {
    const targetId = Number(req.params.id);

    // Cannot delete yourself
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    // Cannot delete other admins
    const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (target.is_admin) {
      return res.status(403).json({ error: 'Admin accounts cannot be deleted via this panel.' });
    }

    // CASCADE on the users table handles all child rows automatically
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

    res.json({ deleted: targetId });
  } catch (err) {
    console.error('Admin DELETE /users/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Student overview (analytics-focused, kept for backward compat) ────────────
router.get('/students', (req, res) => {
  try {
    const students = db.prepare(`
      SELECT u.id, u.name, u.email, p.class,
             toa.completed_tasks_7d, toa.partial_tasks_7d, toa.skipped_tasks_7d,
             toa.completed_tasks_30d, toa.skipped_tasks_30d,
             scs.task_cap_adjustment, scs.overload_detected,
             scs.suppressed_subject_ids, scs.suppression_expires_at,
             scs.weekly_loop_last_run, scs.monthly_loop_last_run
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN task_outcome_aggregates toa ON toa.student_id = u.id
      LEFT JOIN system_control_state scs ON scs.student_id = u.id
      WHERE u.is_admin = 0
      ORDER BY u.id ASC
    `).all();

    res.json({ students });
  } catch (err) {
    console.error('Admin /students error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Topic exposure heatmap ────────────────────────────────────────────────────
// For each topic: name, subject, per-student exposure counts + modifiers
router.get('/topic-exposure', (req, res) => {
  try {
    const topics = db.prepare(`
      SELECT t.topic_id, t.name AS topic_name, s.name AS subject_name,
             t.difficulty_weight, t.baseline_intensity
      FROM topics t
      JOIN subjects s ON s.subject_id = t.subject_id
      WHERE t.is_active = 1
      ORDER BY s.subject_id, t.topic_id
    `).all();

    const exposures = db.prepare(`
      SELECT te.student_id, te.topic_id,
             te.exposure_count, te.last_exposed_date,
             te.rolling_30_day_frequency, te.priority_modifier,
             u.name AS student_name
      FROM topic_exposure te
      JOIN users u ON u.id = te.student_id
      ORDER BY te.topic_id, te.student_id
    `).all();

    // Group exposures by topic_id
    const byTopic = {};
    for (const e of exposures) {
      (byTopic[e.topic_id] ??= []).push(e);
    }

    const heatmap = topics.map(t => ({
      ...t,
      exposures: byTopic[t.topic_id] || [],
    }));

    res.json({ heatmap });
  } catch (err) {
    console.error('Admin /topic-exposure error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Subject density (last 30 days per student) ────────────────────────────────
router.get('/subject-density', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id AS student_id, u.name AS student_name,
             s.name AS subject_name,
             COUNT(*) AS tasks_30d,
             COUNT(CASE WHEN dt.status = 'done'    THEN 1 END) AS done_30d,
             COUNT(CASE WHEN dt.status = 'partial' THEN 1 END) AS partial_30d,
             COUNT(CASE WHEN dt.status = 'skipped' THEN 1 END) AS skipped_30d
      FROM daily_tasks dt
      JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
      JOIN topics   t ON t.topic_id   = dttl.topic_id
      JOIN subjects s ON s.subject_id = t.subject_id
      JOIN users    u ON u.id         = dt.student_id
      WHERE dt.date_assigned >= date('now', '-30 days')
        AND u.is_admin = 0
      GROUP BY dt.student_id, s.subject_id
      ORDER BY u.id, s.subject_id
    `).all();

    res.json({ density: rows });
  } catch (err) {
    console.error('Admin /subject-density error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Outcome trends (last 14 days, per-day totals across all students) ─────────
router.get('/outcome-trends', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT dt.date_assigned AS date,
             COUNT(*)                                            AS total,
             COUNT(CASE WHEN dt.status = 'done'    THEN 1 END) AS done,
             COUNT(CASE WHEN dt.status = 'partial' THEN 1 END) AS partial,
             COUNT(CASE WHEN dt.status = 'skipped' THEN 1 END) AS skipped,
             COUNT(CASE WHEN dt.status = 'pending' THEN 1 END) AS pending
      FROM daily_tasks dt
      JOIN users u ON u.id = dt.student_id
      WHERE dt.date_assigned >= date('now', '-14 days')
        AND u.is_admin = 0
      GROUP BY dt.date_assigned
      ORDER BY dt.date_assigned ASC
    `).all();

    res.json({ trends: rows });
  } catch (err) {
    console.error('Admin /outcome-trends error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Control states ─────────────────────────────────────────────────────────────
router.get('/control-states', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id AS student_id, u.name, p.class,
             scs.task_cap_adjustment, scs.overload_detected,
             scs.suppressed_subject_ids, scs.suppression_expires_at,
             scs.weekly_loop_last_run, scs.monthly_loop_last_run,
             toa.skipped_tasks_7d, toa.completed_tasks_7d
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN system_control_state scs ON scs.student_id = u.id
      LEFT JOIN task_outcome_aggregates toa ON toa.student_id = u.id
      WHERE u.is_admin = 0
      ORDER BY u.id
    `).all();

    res.json({ states: rows });
  } catch (err) {
    console.error('Admin /control-states error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
