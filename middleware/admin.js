import { authenticate } from './auth.js';
import db from '../db.js';

export function adminOnly(req, res, next) {
  authenticate(req, res, () => {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.user.id);
    if (!user?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}
