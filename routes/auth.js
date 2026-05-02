import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import db from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { sendVerificationEmail } from '../lib/mailer.js';

const router = Router();

function makeJwt(userId, email) {
  return jwt.sign({ id: userId, email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, is_admin: u.is_admin ?? 0 };
}

// ── Sign up (email + password) ────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id, auth_provider FROM users WHERE email = ?').get(email);
    if (existing) {
      const msg = existing.auth_provider === 'google'
        ? 'This email is linked to a Google account. Please sign in with Google.'
        : 'An account with this email already exists';
      return res.status(409).json({ error: msg });
    }

    const password_hash = bcrypt.hashSync(password, 10);
    const vToken   = crypto.randomBytes(32).toString('hex');
    const vExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO users (name, email, password_hash, email_verified, verification_token, verification_expires_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(name, email, password_hash, vToken, vExpires);

    await sendVerificationEmail(email, name, vToken);

    res.status(201).json({ requiresVerification: true, email });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Verify email ──────────────────────────────────────────────────────────────
router.get('/verify-email', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token is required' });

    const user = db.prepare(`
      SELECT * FROM users
      WHERE verification_token = ? AND verification_expires_at > ?
    `).get(token, new Date().toISOString());

    if (!user) {
      return res.status(400).json({ error: 'This link is invalid or has expired.' });
    }

    db.prepare(`
      UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires_at = NULL
      WHERE id = ?
    `).run(user.id);

    const jwtToken = makeJwt(user.id, user.email);
    const hasProfile = !!db.prepare('SELECT id FROM profiles WHERE user_id = ?').get(user.id);

    res.json({ token: jwtToken, user: safeUser(user), hasProfile });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Resend verification ───────────────────────────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND email_verified = 0').get(email);

    // Always return the same message to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If that email is registered and unverified, a new link has been sent.' });
    }

    const vToken   = crypto.randomBytes(32).toString('hex');
    const vExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.prepare('UPDATE users SET verification_token = ?, verification_expires_at = ? WHERE id = ?')
      .run(vToken, vExpires, user.id);

    await sendVerificationEmail(email, user.name, vToken);

    res.json({ message: 'If that email is registered and unverified, a new link has been sent.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Login (email + password) ──────────────────────────────────────────────────
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user || user.auth_provider === 'google') {
      // Google-only accounts won't have a password hash
      if (user?.auth_provider === 'google') {
        return res.status(401).json({ error: 'This account uses Google Sign-In. Please sign in with Google.' });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before signing in.',
        needsVerification: true,
        email: user.email,
      });
    }

    const token    = makeJwt(user.id, user.email);
    const profile  = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(user.id);
    const hasProfile = !!profile;

    res.json({ token, user: safeUser(user), hasProfile });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential is required' });

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'Google sign-in is not configured on this server' });

    const client = new OAuth2Client(clientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Invalid Google credential' });
    }

    const { sub: googleId, email, name } = payload;

    // Find by Google ID first, then by email
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        // Link existing account with Google
        db.prepare('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?')
          .run(googleId, user.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      } else {
        // Create new Google user (no password hash needed)
        const result = db.prepare(`
          INSERT INTO users (name, email, password_hash, email_verified, google_id, auth_provider)
          VALUES (?, ?, '', 1, ?, 'google')
        `).run(name, email, googleId);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      }
    }

    const token    = makeJwt(user.id, user.email);
    const hasProfile = !!db.prepare('SELECT id FROM profiles WHERE user_id = ?').get(user.id);

    res.json({ token, user: safeUser(user), hasProfile });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Get current user ──────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email, is_admin, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id);
    res.json({ user, hasProfile: !!profile, profile: profile || null });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
