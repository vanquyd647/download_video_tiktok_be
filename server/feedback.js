import nodemailer from 'nodemailer';

let transporter = null;

export function isFeedbackMailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.FEEDBACK_TO);
}

export function validateFeedback(payload = {}) {
  const kind = normalizeKind(payload.kind);
  const message = String(payload.message || '').trim();
  const contact = String(payload.contact || '').trim();
  const pageUrl = String(payload.pageUrl || '').trim();

  if (message.length < 8) {
    const error = new Error('Please describe the issue or improvement in a little more detail.');
    error.status = 400;
    throw error;
  }

  if (message.length > 3000) {
    const error = new Error('Feedback is too long. Please keep it under 3000 characters.');
    error.status = 400;
    throw error;
  }

  if (contact && contact.length > 160) {
    const error = new Error('Contact info is too long.');
    error.status = 400;
    throw error;
  }

  if (pageUrl && pageUrl.length > 500) {
    const error = new Error('Page URL is too long.');
    error.status = 400;
    throw error;
  }

  return {
    kind,
    message,
    contact,
    pageUrl,
  };
}

export async function sendFeedbackMail(feedback, meta = {}) {
  if (!isFeedbackMailConfigured()) {
    const error = new Error('Feedback email is not configured.');
    error.status = 503;
    throw error;
  }

  const to = process.env.FEEDBACK_TO;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = `[LinkVault feedback] ${feedback.kind}`;
  const text = [
    `Type: ${feedback.kind}`,
    `Contact: ${feedback.contact || 'Not provided'}`,
    `Page: ${feedback.pageUrl || 'Not provided'}`,
    `IP: ${meta.ip || 'unknown'}`,
    `User-Agent: ${meta.userAgent || 'unknown'}`,
    '',
    feedback.message,
  ].join('\n');

  await getTransporter().sendMail({
    from,
    to,
    replyTo: isEmail(feedback.contact) ? feedback.contact : undefined,
    subject,
    text,
  });
}

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return transporter;
}

function normalizeKind(value) {
  if (value === 'error') return 'Error report';
  if (value === 'improvement') return 'Improvement request';
  return 'General feedback';
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}
