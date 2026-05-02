import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Pure presence query — status is irrelevant, only topic appearance matters
function topicsInRange(studentId, days) {
  return db.prepare(`
    SELECT DISTINCT s.name AS subject_name, t.name AS topic_name
    FROM daily_tasks dt
    JOIN daily_task_topic_link dttl ON dttl.task_id = dt.task_id
    JOIN topics   t ON t.topic_id   = dttl.topic_id
    JOIN subjects s ON s.subject_id = t.subject_id
    WHERE dt.student_id = ?
      AND dt.date_assigned >= date('now', '-' || ? || ' days')
    ORDER BY s.name ASC, t.name ASC
  `).all(studentId, days);
}

function groupBySubject(rows) {
  const map = new Map();
  for (const { subject_name, topic_name } of rows) {
    if (!map.has(subject_name)) map.set(subject_name, []);
    map.get(subject_name).push(topic_name);
  }
  return [...map.entries()].map(([subject, topics]) => ({ subject, topics }));
}

router.get('/weekly', authenticate, (req, res) => {
  try {
    const groups = groupBySubject(topicsInRange(req.user.id, 7));
    res.json({
      title:       'This week included:',
      groups,
      has_content: groups.length > 0,
      footer:      groups.length > 0
        ? 'Some topics may appear more than once intentionally.'
        : null,
    });
  } catch (err) {
    console.error('Summaries /weekly error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/monthly', authenticate, (req, res) => {
  try {
    const groups = groupBySubject(topicsInRange(req.user.id, 30));
    res.json({
      title:       'Over the past month, your plan included:',
      groups,
      has_content: groups.length > 0,
      footer:      groups.length > 0
        ? 'Topics repeat over time to support familiarity.'
        : null,
    });
  } catch (err) {
    console.error('Summaries /monthly error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
