
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'study_planner.db');

const API = 'http://localhost:3001/api';

async function runTests() {
  console.log('Starting API Tests...\n');
  let token1 = '';
  let token2 = '';
  const date = new Date().toISOString().split('T')[0];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.toISOString().split('T')[0];

  async function report(name, expected, res, data, condition) {
    const passed = condition ? '✅ PASS' : '❌ FAIL';
    console.log(`--- ${name} ---`);
    console.log(`Expected: ${expected}`);
    console.log(`Actual Status: ${res ? res.status : 'N/A'}`);
    if (data) console.log(`Response: ${JSON.stringify(data).substring(0, 200)}`);
    console.log(`Result: ${passed}\n`);
    return passed === '✅ PASS';
  }

  // 1. POST /api/auth/signup
  try {
    const res1 = await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: "Test User", email: `test_${Date.now()}@test.com`, password: "test123" })
    });
    const data1 = await res1.json();
    if (data1.token) token1 = data1.token;
    report('1. Signup', '201, token + user', res1, data1, res1.status === 201 && data1.token);
  } catch (e) { console.log(`1. Signup Failed: ${e.message}\n`); }

  // 2. POST /api/auth/login
  try {
    // using the email from test 1 is tricky if dynamic, let's just create a known one or use the dynamic one.
    // wait, the prompt says test@test.com. Let's just use test@test.com for login, but signup might fail if it already exists.
    // I'll clean the DB first for 'test@test.com'
    const db = new Database(dbPath);
    db.prepare('DELETE FROM users WHERE email = ?').run('test@test.com');
    db.prepare('DELETE FROM users WHERE email = ?').run('test2@test.com');
    db.close();

    const res1 = await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: "Test User", email: "test@test.com", password: "test123" })
    });
    const data1 = await res1.json();
    token1 = data1.token;
    report('1. Signup (Retry with test@test.com)', '201, token + user', res1, data1, res1.status === 201 && data1.token);

    const res2 = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: "test@test.com", password: "test123" })
    });
    const data2 = await res2.json();
    report('2. Login', '200, token + hasProfile', res2, data2, res2.status === 200 && data2.token);
  } catch (e) { console.log(`2. Login Failed: ${e.message}\n`); }

  // 3. GET /api/auth/me
  try {
    const res3 = await fetch(`${API}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    const data3 = await res3.json();
    report('3. Get Me', '200, current user', res3, data3, res3.status === 200 && data3.user);
  } catch (e) { console.log(`3. Get Me Failed: ${e.message}\n`); }

  // 4. PUT /api/profile
  try {
    const res4 = await fetch(`${API}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ age: 17, class: "12th", exam_type: "JEE Mains", school_hours_per_day: 6, available_study_minutes: 90 })
    });
    const data4 = await res4.json();
    report('4. Update Profile', '200, available_study_minutes saved', res4, data4, res4.status === 200 && data4.profile && data4.profile.available_study_minutes === 90);
  } catch (e) { console.log(`4. Update Profile Failed: ${e.message}\n`); }

  // 5. GET /api/profile
  try {
    const res5 = await fetch(`${API}/profile`, {
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    const data5 = await res5.json();
    report('5. Get Profile', '200, includes available_study_minutes', res5, data5, res5.status === 200 && data5.profile && data5.profile.available_study_minutes === 90);
  } catch (e) { console.log(`5. Get Profile Failed: ${e.message}\n`); }

  // 6. DB checks
  try {
    const db = new Database(dbPath);
    let pass6 = false;
    let data6 = {};
    try {
      const buckets = db.prepare('SELECT * FROM skill_buckets').all();
      const templates = db.prepare(`
        SELECT tt.id, sb.name, tt.task_type, tt.duration_minutes, tt.difficulty
        FROM task_templates tt JOIN skill_buckets sb ON tt.skill_bucket_id = sb.id
      `).all();
      data6 = { buckets: buckets.length, templates: templates.length };
      pass6 = (buckets.length === 3 && templates.length === 12);
    } catch(err) {
      data6 = { error: err.message };
    }
    db.close();
    report('6. DB Checks', '3 skill_buckets, 12 task_templates', null, data6, pass6);
  } catch (e) { console.log(`6. DB Checks Failed: ${e.message}\n`); }

  // 7. POST /api/daily-tasks (task 1)
  try {
    const res7 = await fetch(`${API}/daily-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ date: date, task_template_id: 1 })
    });
    const data7 = await res7.json();
    report('7. Create Task 1', '201, task created', res7, data7, res7.status === 201);
  } catch (e) { console.log(`7. Create Task 1 Failed: ${e.message}\n`); }

  // 8. POST /api/daily-tasks (task 2)
  try {
    const res8 = await fetch(`${API}/daily-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ date: date, task_template_id: 4 })
    });
    const data8 = await res8.json();
    report('8. Create Task 2', '201, task created', res8, data8, res8.status === 201);
  } catch (e) { console.log(`8. Create Task 2 Failed: ${e.message}\n`); }

  // 9. CONSTRAINT TEST - max 2
  try {
    const res9 = await fetch(`${API}/daily-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ date: date, task_template_id: 2 })
    });
    const data9 = await res9.json();
    report('9. Constraint - Max 2 per day', '400, max 2 allowed', res9, data9, res9.status === 400 && data9.error && data9.error.includes('Maximum of 2'));
  } catch (e) { console.log(`9. Constraint Max 2 Failed: ${e.message}\n`); }

  // 10. CONSTRAINT TEST - invalid template
  try {
    const res10 = await fetch(`${API}/daily-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ date: date, task_template_id: 9999 })
    });
    const data10 = await res10.json();
    report('10. Constraint - Invalid Template', '400, invalid task_template_id', res10, data10, res10.status === 400);
  } catch (e) { console.log(`10. Constraint Invalid Template Failed: ${e.message}\n`); }

  // 11. CONSTRAINT TEST - study minutes exceeded
  try {
    await fetch(`${API}/daily-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ date: tomorrow, task_template_id: 5 }) // 75 min
    });
    const res11 = await fetch(`${API}/daily-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ date: tomorrow, task_template_id: 1 }) // 60 min -> 135 total
    });
    const data11 = await res11.json();
    report('11. Constraint - Study Minutes', '400, exceeding available_study_minutes', res11, data11, res11.status === 400 && data11.error && data11.error.includes('exceed'));
  } catch (e) { console.log(`11. Constraint Study Minutes Failed: ${e.message}\n`); }

  // 12. GET /api/daily-tasks?date=DATE
  let taskIdToUpdate = 1;
  try {
    const res12 = await fetch(`${API}/daily-tasks?date=${date}`, {
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    const data12 = await res12.json();
    if (data12.tasks && data12.tasks.length > 0) {
      taskIdToUpdate = data12.tasks[0].id;
    }
    report('12. Get Daily Tasks', '200, returns 2 tasks with template info', res12, data12, res12.status === 200 && data12.tasks && data12.tasks.length === 2 && data12.tasks[0].skill_bucket_id !== undefined);
  } catch (e) { console.log(`12. Get Daily Tasks Failed: ${e.message}\n`); }

  // 13. PATCH /api/daily-tasks/1
  try {
    const res13 = await fetch(`${API}/daily-tasks/${taskIdToUpdate}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token1}` },
      body: JSON.stringify({ status: 'done' })
    });
    const data13 = await res13.json();
    report('13. Update Task Status', '200, status updated', res13, data13, res13.status === 200);
  } catch (e) { console.log(`13. Update Task Status Failed: ${e.message}\n`); }

  // 14. CONSTRAINT TEST - ownership
  try {
    const res14a = await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: "User 2", email: "test2@test.com", password: "password123" })
    });
    const data14a = await res14a.json();
    token2 = data14a.token;

    const res14 = await fetch(`${API}/daily-tasks/${taskIdToUpdate}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token2}` },
      body: JSON.stringify({ status: 'skipped' })
    });
    const data14 = await res14.json();
    report('14. Constraint - Ownership', '404, task not found', res14, data14, res14.status === 404);
  } catch (e) { console.log(`14. Constraint Ownership Failed: ${e.message}\n`); }

  // 15. DELETE /api/daily-tasks/1
  try {
    const res15 = await fetch(`${API}/daily-tasks/${taskIdToUpdate}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    const data15 = await res15.json();
    report('15. Delete Task', '200, task deleted', res15, data15, res15.status === 200);
  } catch (e) { console.log(`15. Delete Task Failed: ${e.message}\n`); }
}

runTests();
