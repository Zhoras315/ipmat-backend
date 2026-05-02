import db from './db.js';

const skillBuckets = [
  { name: 'Quantitative' },
  { name: 'Verbal' },
  { name: 'Logical Reasoning' },
];

// 4 templates per skill bucket = 12 total
const templates = [
  // Quantitative
  { bucket: 'Quantitative', task_type: 'focused_practice', duration_minutes: 60, difficulty: 'heavy' },
  { bucket: 'Quantitative', task_type: 'focused_practice', duration_minutes: 45, difficulty: 'medium' },
  { bucket: 'Quantitative', task_type: 'revision',         duration_minutes: 45, difficulty: 'medium' },
  { bucket: 'Quantitative', task_type: 'light_review',     duration_minutes: 30, difficulty: 'easy'   },

  // Verbal
  { bucket: 'Verbal',       task_type: 'focused_practice', duration_minutes: 75, difficulty: 'heavy'  },
  { bucket: 'Verbal',       task_type: 'focused_practice', duration_minutes: 45, difficulty: 'medium' },
  { bucket: 'Verbal',       task_type: 'revision',         duration_minutes: 30, difficulty: 'easy'   },
  { bucket: 'Verbal',       task_type: 'light_review',     duration_minutes: 30, difficulty: 'easy'   },

  // Logical Reasoning
  { bucket: 'Logical Reasoning', task_type: 'focused_practice', duration_minutes: 75, difficulty: 'heavy'  },
  { bucket: 'Logical Reasoning', task_type: 'focused_practice', duration_minutes: 60, difficulty: 'medium' },
  { bucket: 'Logical Reasoning', task_type: 'revision',         duration_minutes: 45, difficulty: 'easy'   },
  { bucket: 'Logical Reasoning', task_type: 'light_review',     duration_minutes: 30, difficulty: 'easy'   },
];

const insertBucket = db.prepare(
  'INSERT OR IGNORE INTO skill_buckets (name) VALUES (?)'
);
const getBucket = db.prepare(
  'SELECT id FROM skill_buckets WHERE name = ?'
);
const insertTemplate = db.prepare(`
  INSERT OR IGNORE INTO task_templates (skill_bucket_id, task_type, duration_minutes, difficulty)
  VALUES (?, ?, ?, ?)
`);

const seed = db.transaction(() => {
  for (const { name } of skillBuckets) {
    insertBucket.run(name);
  }

  for (const t of templates) {
    const bucket = getBucket.get(t.bucket);
    insertTemplate.run(bucket.id, t.task_type, t.duration_minutes, t.difficulty);
  }
});

seed();

const bucketRows = db.prepare('SELECT * FROM skill_buckets').all();
const templateRows = db.prepare(`
  SELECT tt.id, sb.name AS skill_bucket, tt.task_type, tt.duration_minutes, tt.difficulty
  FROM task_templates tt
  JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
  ORDER BY sb.name, tt.task_type, tt.duration_minutes
`).all();

console.log('\nSkill Buckets:');
console.table(bucketRows);
console.log('\nTask Templates (12):');
console.table(templateRows);
console.log('\nSeed complete.');
