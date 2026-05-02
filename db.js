import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'study_planner.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Original tables ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    age INTEGER,
    class TEXT,
    exam_type TEXT,
    school_hours_per_day REAL DEFAULT 6,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    subject TEXT,
    date TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'partial', 'skipped')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);

  CREATE TABLE IF NOT EXISTS skill_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS task_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_bucket_id INTEGER NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('focused_practice', 'revision', 'light_review')),
    duration_minutes INTEGER NOT NULL CHECK(duration_minutes IN (30, 45, 60, 75)),
    difficulty TEXT NOT NULL CHECK(difficulty IN ('easy', 'medium', 'heavy')),
    FOREIGN KEY (skill_bucket_id) REFERENCES skill_buckets(id) ON DELETE CASCADE
  );
`);

// ── Migration: rename old daily_tasks → generated_tasks ──────────────────────
// The old daily_tasks was linked to task_templates (has task_template_id).
// The new daily_tasks is the redesigned student-facing table.
const oldCols = db.pragma('table_info(daily_tasks)');
if (oldCols.some(c => c.name === 'task_template_id')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    ALTER TABLE daily_tasks RENAME TO generated_tasks;
  `);
  db.pragma('foreign_keys = ON');
}

// ── generated_tasks (old auto-generated plan table, now renamed) ─────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS generated_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    task_template_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'partial', 'skipped')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (task_template_id) REFERENCES task_templates(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_generated_tasks_user_date ON generated_tasks(user_id, date);
`);

// ── Migrate: onboarding fields on profiles ────────────────────────────────────
const profileOnboardCols = db.pragma('table_info(profiles)');
if (!profileOnboardCols.some(c => c.name === 'ipmat_info_seen')) {
  db.exec('ALTER TABLE profiles ADD COLUMN ipmat_info_seen INTEGER NOT NULL DEFAULT 0');
}
if (!profileOnboardCols.some(c => c.name === 'plan_start_date')) {
  db.exec('ALTER TABLE profiles ADD COLUMN plan_start_date TEXT');
}

// ── Migrate: add available_study_minutes to profiles if not present ───────────
const profileCols = db.pragma('table_info(profiles)');
if (!profileCols.some(c => c.name === 'available_study_minutes')) {
  db.exec('ALTER TABLE profiles ADD COLUMN available_study_minutes INTEGER');
}

// ── Migrate: extend task_templates to allow duration_minutes = 75 ─────────────
const templateDef = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_templates'"
).get();
if (templateDef && !templateDef.sql.includes('75')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE task_templates_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_bucket_id INTEGER NOT NULL,
      task_type TEXT NOT NULL CHECK(task_type IN ('focused_practice', 'revision', 'light_review')),
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes IN (30, 45, 60, 75)),
      difficulty TEXT NOT NULL CHECK(difficulty IN ('easy', 'medium', 'heavy')),
      FOREIGN KEY (skill_bucket_id) REFERENCES skill_buckets(id) ON DELETE CASCADE
    );
    INSERT INTO task_templates_new SELECT * FROM task_templates;
    DROP TABLE task_templates;
    ALTER TABLE task_templates_new RENAME TO task_templates;
  `);
  db.pragma('foreign_keys = ON');
}

// ── New foundation tables ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS subjects (
    subject_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS topics (
    topic_id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    short_description TEXT,
    difficulty_weight TEXT NOT NULL DEFAULT 'medium'
      CHECK(difficulty_weight IN ('light', 'medium', 'heavy')),
    estimated_hours_min REAL NOT NULL DEFAULT 1,
    estimated_hours_max REAL NOT NULL DEFAULT 2,
    recommended_sessions_min INTEGER NOT NULL DEFAULT 1,
    recommended_sessions_max INTEGER NOT NULL DEFAULT 3,
    priority_bias TEXT NOT NULL DEFAULT 'neutral'
      CHECK(priority_bias IN ('low', 'neutral', 'high')),
    is_active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (subject_id) REFERENCES subjects(subject_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subtopics (
    subtopic_id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    difficulty_tag TEXT NOT NULL DEFAULT 'medium'
      CHECK(difficulty_tag IN ('light', 'medium', 'heavy')),
    is_active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS student_context (
    student_id INTEGER NOT NULL PRIMARY KEY,
    academic_stage TEXT NOT NULL
      CHECK(academic_stage IN ('Class 11', 'Class 12', 'Post-12')),
    target_exam TEXT NOT NULL DEFAULT 'IPMAT',
    exam_month TEXT NOT NULL DEFAULT 'May'
      CHECK(exam_month IN ('May', 'June')),
    school_hours_per_day REAL,
    self_study_hours_range TEXT,
    start_date TEXT,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS daily_tasks (
    task_id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('focused', 'light', 'revision')),
    title TEXT NOT NULL,
    estimated_time INTEGER NOT NULL CHECK(estimated_time IN (15, 30, 45)),
    date_assigned TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'done', 'partial', 'skipped')),
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_daily_tasks_student_date
    ON daily_tasks(student_id, date_assigned);

  CREATE TABLE IF NOT EXISTS daily_task_topic_link (
    task_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    is_suggested INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (task_id, topic_id),
    FOREIGN KEY (task_id) REFERENCES daily_tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS topic_exposure (
    exposure_id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    exposure_count INTEGER NOT NULL DEFAULT 0,
    last_exposed_date TEXT,
    system_confidence TEXT NOT NULL DEFAULT 'low'
      CHECK(system_confidence IN ('low', 'medium', 'stable')),
    UNIQUE(student_id, topic_id),
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
  );
`);

// ── Migrate: add ipmat_info_seen + plan_start_date to profiles ───────────────
// (runs before profiles table is created, but IF NOT EXISTS guards mean
//  ALTER TABLE is the safe path for existing DBs)
// These run after db.exec so profiles table is guaranteed to exist.

// ── Migrate: auth + verification columns on users ────────────────────────────
const userCols = db.pragma('table_info(users)');
if (!userCols.some(c => c.name === 'is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.some(c => c.name === 'email_verified')) {
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  // Existing users predate the requirement — mark them verified automatically
  db.exec('UPDATE users SET email_verified = 1');
}
if (!userCols.some(c => c.name === 'verification_token')) {
  db.exec('ALTER TABLE users ADD COLUMN verification_token TEXT');
}
if (!userCols.some(c => c.name === 'verification_expires_at')) {
  db.exec('ALTER TABLE users ADD COLUMN verification_expires_at TEXT');
}
if (!userCols.some(c => c.name === 'google_id')) {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
}
if (!userCols.some(c => c.name === 'auth_provider')) {
  db.exec("ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'");
}

// ── Migrate: add rolling frequencies + priority_modifier to topic_exposure ────
const teCols = db.pragma('table_info(topic_exposure)');
if (!teCols.some(c => c.name === 'rolling_30_day_frequency')) {
  db.exec('ALTER TABLE topic_exposure ADD COLUMN rolling_30_day_frequency REAL DEFAULT 0');
}
if (!teCols.some(c => c.name === 'rolling_90_day_frequency')) {
  db.exec('ALTER TABLE topic_exposure ADD COLUMN rolling_90_day_frequency REAL DEFAULT 0');
}
if (!teCols.some(c => c.name === 'priority_modifier')) {
  db.exec('ALTER TABLE topic_exposure ADD COLUMN priority_modifier REAL NOT NULL DEFAULT 1.0');
}

// ── Stage 3 internal analytics tables ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS task_outcome_aggregates (
    student_id          INTEGER PRIMARY KEY,
    completed_tasks_7d  INTEGER DEFAULT 0,
    partial_tasks_7d    INTEGER DEFAULT 0,
    skipped_tasks_7d    INTEGER DEFAULT 0,
    completed_tasks_30d INTEGER DEFAULT 0,
    skipped_tasks_30d   INTEGER DEFAULT 0,
    last_computed_at    TEXT,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS system_control_state (
    student_id              INTEGER PRIMARY KEY,
    task_cap_adjustment     INTEGER NOT NULL DEFAULT 0,
    suppressed_subject_ids  TEXT    NOT NULL DEFAULT '[]',
    suppression_expires_at  TEXT,
    overload_detected       INTEGER NOT NULL DEFAULT 0,
    weekly_loop_last_run    TEXT,
    monthly_loop_last_run   TEXT,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subject_load_index (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL,
    subject_id    INTEGER NOT NULL,
    week_start    TEXT    NOT NULL,
    tasks_assigned INTEGER DEFAULT 0,
    available_days INTEGER DEFAULT 7,
    load_index    REAL    DEFAULT 0,
    computed_at   TEXT,
    UNIQUE(student_id, subject_id, week_start),
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(subject_id) ON DELETE CASCADE
  );
`);

// ── Migrate: add baseline_intensity to topics ─────────────────────────────────
const topicCols = db.pragma('table_info(topics)');
if (!topicCols.some(c => c.name === 'baseline_intensity')) {
  db.exec(`ALTER TABLE topics ADD COLUMN baseline_intensity TEXT NOT NULL DEFAULT 'medium'`);
}

// ── Pre-fill subjects (run once) ─────────────────────────────────────────────
const subjectCount = db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n;
if (subjectCount === 0) {
  const ins = db.prepare('INSERT INTO subjects (name, description) VALUES (?, ?)');
  db.transaction(() => {
    ins.run('Quantitative Aptitude',
      'Number theory, algebra, arithmetic, and data interpretation.');
    ins.run('Verbal Ability',
      'Reading comprehension, vocabulary, grammar, and language skills.');
    ins.run('Logical Reasoning',
      'Analytical reasoning, puzzles, series, and logical deduction.');
  })();
}

// ── Seed IPMAT topics (run once) ─────────────────────────────────────────────
const topicCount = db.prepare('SELECT COUNT(*) AS n FROM topics').get().n;
if (topicCount === 0) {
  const getSubject  = db.prepare('SELECT subject_id FROM subjects WHERE name = ?');
  const insertTopic = db.prepare(`
    INSERT INTO topics
      (subject_id, name, difficulty_weight, baseline_intensity, priority_bias,
       estimated_hours_min, estimated_hours_max, recommended_sessions_min, recommended_sessions_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    const qaId = getSubject.get('Quantitative Aptitude').subject_id;
    const vaId = getSubject.get('Verbal Ability').subject_id;
    const lrId = getSubject.get('Logical Reasoning').subject_id;

    // Quantitative Aptitude
    insertTopic.run(qaId, 'Number System',           'heavy',  'high',   'high',    2, 4, 3, 6);
    insertTopic.run(qaId, 'Algebra',                 'heavy',  'high',   'high',    2, 4, 3, 6);
    insertTopic.run(qaId, 'Arithmetic',              'medium', 'high',   'high',    2, 3, 2, 5);
    insertTopic.run(qaId, 'Geometry & Mensuration',  'heavy',  'medium', 'neutral', 2, 4, 2, 5);
    insertTopic.run(qaId, 'Data Interpretation',     'medium', 'medium', 'neutral', 1, 3, 2, 4);

    // Verbal Ability
    insertTopic.run(vaId, 'Reading Comprehension',   'medium', 'high',   'high',    1, 3, 2, 5);
    insertTopic.run(vaId, 'Vocabulary',              'light',  'medium', 'neutral', 1, 2, 1, 3);
    insertTopic.run(vaId, 'Grammar & Usage',         'light',  'medium', 'neutral', 1, 2, 1, 3);
    insertTopic.run(vaId, 'Para Jumbles',            'medium', 'medium', 'neutral', 1, 2, 1, 3);
    insertTopic.run(vaId, 'Critical Reasoning',      'medium', 'medium', 'neutral', 1, 2, 1, 3);

    // Logical Reasoning
    insertTopic.run(lrId, 'Arrangements & Puzzles',  'medium', 'high',   'high',    1, 3, 2, 4);
    insertTopic.run(lrId, 'Series & Sequences',      'light',  'medium', 'neutral', 1, 2, 1, 3);
    insertTopic.run(lrId, 'Syllogisms',              'light',  'medium', 'neutral', 1, 2, 1, 3);
    insertTopic.run(lrId, 'Data Sufficiency',        'medium', 'medium', 'neutral', 1, 2, 1, 3);
    insertTopic.run(lrId, 'Blood Relations',         'light',  'low',    'low',     1, 2, 1, 2);
    insertTopic.run(lrId, 'Coding-Decoding',         'light',  'low',    'low',     1, 2, 1, 2);
  })();
}

// ── Seed admin account (run once) ────────────────────────────────────────────
const adminEmail = 'dhku31549@gmail.com';
const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!adminExists) {
  const hash = bcrypt.hashSync('Test@123', 10);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, email_verified, is_admin)
    VALUES (?, ?, ?, 1, 1)
  `).run('Admin', adminEmail, hash);
}

export default db;
