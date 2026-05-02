import db from './db.js';

const topicCount = db.prepare('SELECT COUNT(*) AS n FROM topics').get().n;
if (topicCount > 0) {
  console.log(`Topics already seeded (${topicCount} rows). Skipping.`);
  process.exit(0);
}

const subjectId = name =>
  db.prepare('SELECT subject_id FROM subjects WHERE name = ?').get(name)?.subject_id;

const ins = db.prepare(`
  INSERT INTO topics
    (subject_id, name, short_description, difficulty_weight,
     estimated_hours_min, estimated_hours_max,
     recommended_sessions_min, recommended_sessions_max,
     priority_bias, baseline_intensity, is_active)
  VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'neutral', ?, 1)
`);

const seed = db.transaction(() => {
  const qa = subjectId('Quantitative Aptitude');
  const va = subjectId('Verbal Ability');
  const lr = subjectId('Logical Reasoning');

  // ── Quantitative Aptitude ───────────────────────────────────────────────
  ins.run(qa, 'Number System',
    'Divisibility, factors, remainders, and number properties.',
    'heavy', 18, 25, 'high');

  ins.run(qa, 'Arithmetic',
    'Percentages, ratios, profit-loss, time-speed-distance, and mixtures.',
    'heavy', 25, 35, 'high');

  ins.run(qa, 'Algebra',
    'Linear and quadratic equations, inequalities, and functions.',
    'medium', 12, 18, 'medium');

  ins.run(qa, 'Modern Math',
    'Permutations, combinations, probability, and set theory.',
    'medium', 10, 15, 'medium');

  ins.run(qa, 'Data Interpretation',
    'Tables, charts, and caselets requiring calculation and analysis.',
    'light', 8, 12, 'low');

  // ── Verbal Ability ──────────────────────────────────────────────────────
  ins.run(va, 'Reading Comprehension',
    'Inference, tone, structure, and detailed reading of passages.',
    'heavy', 30, 40, 'high');

  ins.run(va, 'Grammar & Usage',
    'Sentence correction, subject-verb agreement, and idioms.',
    'medium', 12, 18, 'medium');

  ins.run(va, 'Vocabulary (Contextual)',
    'Word meanings, analogies, and fill-in-the-blank usage.',
    'light', 10, 20, 'medium');

  ins.run(va, 'Verbal Reasoning',
    'Para-jumbles, para-completion, and critical reasoning.',
    'medium', 8, 12, 'medium');

  // ── Logical Reasoning ───────────────────────────────────────────────────
  ins.run(lr, 'Arrangements & Ordering',
    'Linear and circular seating, ordering constraints.',
    'heavy', 12, 18, 'high');

  ins.run(lr, 'Logical Deductions',
    'Syllogisms, statements, and conclusions.',
    'medium', 8, 12, 'medium');

  ins.run(lr, 'Series & Patterns',
    'Number series, letter series, and visual patterns.',
    'medium', 6, 10, 'medium');

  ins.run(lr, 'Blood Relations',
    'Family tree problems and coded relation questions.',
    'light', 4, 6, 'low');
});

seed();

const rows = db.prepare(`
  SELECT t.topic_id, s.name AS subject, t.name, t.difficulty_weight, t.baseline_intensity
  FROM topics t JOIN subjects s ON s.subject_id = t.subject_id
  ORDER BY s.subject_id, t.topic_id
`).all();

console.log('\nSeeded topics:');
console.table(rows);
console.log('\nDone.');
