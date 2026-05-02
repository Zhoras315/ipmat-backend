import db from './db.js';
import bcrypt from 'bcryptjs';

const EMAIL    = 'dhku31549@gmail.com';
const PASSWORD = 'Test@123';
const NAME     = 'Admin';

const hash     = bcrypt.hashSync(PASSWORD, 10);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);

if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, is_admin = 1, name = ? WHERE email = ?')
    .run(hash, NAME, EMAIL);
  console.log('Admin updated:', EMAIL);
} else {
  db.prepare('INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)')
    .run(NAME, EMAIL, hash);
  console.log('Admin created:', EMAIL);
}

const verify = db.prepare('SELECT id, name, email, is_admin FROM users WHERE email = ?').get(EMAIL);
console.log('Admin record:', verify);
