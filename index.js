import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import taskRoutes from './routes/tasks.js';
import dailyTaskRoutes from './routes/dailyTasks.js';
import weeklySummaryRoutes from './routes/weeklySummary.js';
import planRoutes from './routes/plan.js';
import adminRoutes from './routes/admin.js';
import summariesRoutes from './routes/summaries.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://ipmatstudyplanner.surge.sh',
  process.env.CLIENT_URL,            // set this on Render if you use a custom domain
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/daily-tasks', dailyTaskRoutes);
app.use('/api/weekly-summary', weeklySummaryRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/summaries', summariesRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
});
