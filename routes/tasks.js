import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get tasks for a specific date
router.get('/', authenticate, (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required (YYYY-MM-DD)' });
    }

    const tasks = db.prepare(
      'SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY created_at ASC'
    ).all(req.user.id, date);

    res.json({ tasks });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a task
router.post('/', authenticate, (req, res) => {
  try {
    const { title, subject, date } = req.body;

    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date are required' });
    }

    const result = db.prepare(
      'INSERT INTO tasks (user_id, title, subject, date) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, title, subject || null, date);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ task });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update task status
router.patch('/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'done', 'partial', 'skipped'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }

    // Verify task belongs to user
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

    res.json({ task: updated });
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a task
router.delete('/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
