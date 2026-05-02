import { Router } from 'express';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get profile
router.get('/', authenticate, (req, res) => {
  try {
    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create or update profile (called from profile setup form)
router.put('/', authenticate, (req, res) => {
  try {
    const { age, class: studentClass, exam_type, school_hours_per_day, available_study_minutes } = req.body;

    const existing = db.prepare('SELECT id FROM profiles WHERE user_id = ?').get(req.user.id);

    if (existing) {
      db.prepare(`
        UPDATE profiles
        SET age = ?, class = ?, exam_type = ?, school_hours_per_day = ?, available_study_minutes = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(age, studentClass, exam_type, school_hours_per_day, available_study_minutes ?? null, req.user.id);
    } else {
      db.prepare(`
        INSERT INTO profiles (user_id, age, class, exam_type, school_hours_per_day, available_study_minutes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.user.id, age, studentClass, exam_type, school_hours_per_day, available_study_minutes ?? null);
    }

    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
    res.json({ profile });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark IPMAT info as seen and set plan start date (called from onboarding)
router.post('/start', authenticate, (req, res) => {
  try {
    const { start_date } = req.body;
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });

    const existing = db.prepare('SELECT id FROM profiles WHERE user_id = ?').get(req.user.id);
    if (!existing) return res.status(404).json({ error: 'Profile not found. Complete profile setup first.' });

    db.prepare(`
      UPDATE profiles
      SET ipmat_info_seen = 1, plan_start_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(start_date, req.user.id);

    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
    res.json({ profile });
  } catch (err) {
    console.error('Profile start error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
