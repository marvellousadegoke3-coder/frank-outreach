import nodemailer from 'nodemailer';

let transporter;

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

// Sends via SMTP when SMTP_HOST/USER/PASS are configured. Otherwise logs the
// message and returns a synthetic message id so the pipeline (message row +
// event logging) still runs end-to-end before real mailbox creds exist.
export async function sendMail({ from, to, subject, text }) {
  const t = getTransporter();

  if (!t) {
    const messageId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[mailer:stub] to=${to} from=${from} subject=${JSON.stringify(subject)}\n${text}`);
    return { messageId, stubbed: true };
  }

  const info = await t.sendMail({ from, to, subject, text });
  return { messageId: info.messageId, stubbed: false };
}
