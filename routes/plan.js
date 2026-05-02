import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { getTimeHorizon, generatePlan, applyOutcome } from '../lib/exposureEngine.js';

const router = Router();

function todayStr() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// Generate (or return) today's plan
router.post('/generate', authenticate, (req, res) => {
  try {
    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
    if (!profile) return res.status(400).json({ error: 'Profile not found. Complete setup first.' });

    const today = todayStr();

    // Respect user's chosen start date — no tasks before planning begins
    if (profile.plan_start_date && profile.plan_start_date > today) {
      return res.json({ generated: false, notStarted: true, startsOn: profile.plan_start_date, tasks: [] });
    }

    const horizon = getTimeHorizon(profile.class);
    const result  = generatePlan(db, req.user.id, today, horizon);

    res.json(result);
  } catch (err) {
    console.error('Plan generate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark a task done / partial / skipped
router.patch('/tasks/:taskId', authenticate, (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const { status } = req.body;

    const valid = ['done', 'partial', 'skipped', 'pending'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    }

    const updated = applyOutcome(db, taskId, req.user.id, status);
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    res.json({ task: updated });
  } catch (err) {
    console.error('Plan task update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
