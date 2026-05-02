import nodemailer from 'nodemailer';
import { Resend } from 'resend';

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const FROM    = process.env.EMAIL_FROM || 'StudyPlanner <onboarding@resend.dev>';

// ── Resend (primary — real delivery) ─────────────────────────────────────────

let resendClient = null;
if (process.env.RESEND_API_KEY) {
  resendClient = new Resend(process.env.RESEND_API_KEY);
}

async function sendViaResend(to, subject, html, text) {
  const { error } = await resendClient.emails.send({ from: FROM, to, subject, html, text });
  if (error) throw new Error(`Resend error: ${error.message}`);
}

// ── Nodemailer SMTP (secondary — Gmail / custom SMTP) ─────────────────────────

let smtpTransport = null;
if (process.env.SMTP_HOST) {
  smtpTransport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Ethereal (dev fallback — not real delivery) ───────────────────────────────

let etherealTransport = null;

async function getEtherealTransport() {
  if (etherealTransport) return etherealTransport;
  const testAccount = await nodemailer.createTestAccount();
  etherealTransport = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  console.log('\n⚠  No RESEND_API_KEY or SMTP_HOST set — using Ethereal (dev preview only)');
  console.log('   Emails are NOT delivered to real inboxes.\n');
  return etherealTransport;
}

// ── Public send function ───────────────────────────────────────────────────────

export async function sendVerificationEmail(to, name, token) {
  const url = `${APP_URL}/verify-email?token=${token}`;

  const subject = 'Verify your StudyPlanner account';
  const text    = `Hi ${name},\n\nVerify your email address:\n${url}\n\nThis link expires in 24 hours.`;
  const html    = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="margin-bottom:8px;color:#1c1917;">Verify your email</h2>
      <p style="color:#4a4742;">Hi ${name},</p>
      <p style="color:#4a4742;">Click the button below to verify your email and activate your StudyPlanner account.</p>
      <a href="${url}"
         style="display:inline-block;margin:24px 0;padding:12px 28px;
                background:#6366f1;color:#fff;border-radius:8px;
                text-decoration:none;font-weight:600;font-size:15px;">
        Verify email
      </a>
      <p style="color:#78756f;font-size:13px;">
        This link expires in 24 hours. If you didn't create an account, you can ignore this email.
      </p>
    </div>`;

  // Priority: Resend → SMTP → Ethereal (dev)
  if (resendClient) {
    await sendViaResend(to, subject, html, text);
    console.log(`✉  Email sent via Resend → ${to}`);
    return;
  }

  if (smtpTransport) {
    await smtpTransport.sendMail({ from: FROM, to, subject, html, text });
    console.log(`✉  Email sent via SMTP → ${to}`);
    return;
  }

  // Dev fallback
  const t    = await getEtherealTransport();
  const info = await t.sendMail({ from: FROM, to, subject, html, text });
  const preview = nodemailer.getTestMessageUrl(info);
  console.log(`\n📧  Ethereal preview:\n    ${preview}`);
  console.log(`🔗  Direct link:\n    ${url}\n`);
}
