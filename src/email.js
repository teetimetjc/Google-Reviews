import nodemailer from 'nodemailer';

export function createTransport(env) {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

export async function sendDigest({ transport, from, to, subject, html, text }) {
  await transport.sendMail({ from, to, subject, html, text });
}
