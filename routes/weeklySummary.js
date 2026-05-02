import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

function getLast7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push([
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-'));
  }
  return days;
}

function getOverall(tasks) {
  if (tasks.length === 0) return 'empty';
  const statuses = tasks.map(t => t.status);
  if (statuses.every(s => s === 'done'))    return 'done';
  if (statuses.every(s => s === 'skipped')) return 'skipped';
  if (statuses.every(s => s === 'pending')) return 'pending';
  if (statuses.some(s => s === 'partial'))  return 'partial';
  return 'mixed';
}

function generateInsight(daySummaries, subjectsEngaged) {
  const activeDays  = daySummaries.filter(d => d.overall !== 'empty' && d.overall !== 'pending');
  const doneDays    = daySummaries.filter(d => d.overall === 'done');
  const skippedDays = daySummaries.filter(d => d.overall === 'skipped');

  if (activeDays.length === 0) {
    return "No sessions recorded this week yet. Each day is its own opportunity.";
  }
  if (activeDays.length <= 2) {
    return "A quieter week — that's perfectly fine. The sessions you did show up for still count.";
  }
  if (doneDays.length >= 5) {
    return "You showed up and followed through most of this week. That consistency is the foundation of real preparation.";
  }
  if (skippedDays.length >= 3) {
    return "Some days were lighter this week. Rest and stepping back are part of any sustainable routine.";
  }
  if (subjectsEngaged.length >= 3) {
    return "All three subject areas got attention this week. A balanced approach prepares you for every section of IPMAT.";
  }
  if (subjectsEngaged.length === 2) {
    return "Two subject areas engaged this week. Building depth before spreading wide is a thoughtful approach.";
  }
  return "Another week of preparation behind you. Small, regular efforts add up to something meaningful.";
}

router.get('/', authenticate, (req, res) => {
  try {
    const days = getLast7Days();
    const from = days[0];
    const to   = days[days.length - 1];

    // Read from new daily_tasks + topic link
    const rows = db.prepare(`
      SELECT dt.date_assigned AS date, dt.status,
             s.name  AS subject_name,
             dt.task_type
      FROM daily_tasks dt
      LEFT JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
      LEFT JOIN topics  t ON t.topic_id  = dttl.topic_id
      LEFT JOIN subjects s ON s.subject_id = t.subject_id
      WHERE dt.student_id = ? AND dt.date_assigned >= ? AND dt.date_assigned <= ?
      ORDER BY dt.date_assigned ASC
    `).all(req.user.id, from, to);

    const byDate = {};
    for (const row of rows) {
      (byDate[row.date] ??= []).push(row);
    }

    const daySummaries = days.map(date => {
      const d = new Date(date + 'T00:00:00');
      const dayTasks = byDate[date] || [];
      return {
        date,
        label:     d.toLocaleDateString('en-IN', { weekday: 'short' }),
        shortDate: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        tasks:     dayTasks,
        overall:   getOverall(dayTasks),
      };
    });

    const subjectsEngaged = [...new Set(rows.map(r => r.subject_name).filter(Boolean))];
    const insight = generateInsight(daySummaries, subjectsEngaged);

    res.json({ days: daySummaries, subjectsEngaged, insight });
  } catch (err) {
    console.error('Weekly summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
