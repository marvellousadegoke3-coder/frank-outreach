import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

let oauthClient;

function getOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;

  if (!oauthClient) {
    oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oauthClient.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  }
  return oauthClient;
}

function buildRawMessage({ from, to, subject, text, messageId, inReplyTo, references }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const message = `${headers.join('\r\n')}\r\n\r\n${text}`;
  return Buffer.from(message).toString('base64url');
}

async function gmailApiSend(client, { raw, threadId }) {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('failed to obtain Gmail access token from refresh token');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail API send failed: ${res.status} ${errText}`);
  }
  return res.json();
}

// Sends via the Gmail API (OAuth refresh-token flow) when GOOGLE_CLIENT_ID/
// GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN are configured. Otherwise logs
// the message and returns a synthetic id, so the pipeline still runs
// end-to-end before OAuth is set up.
//
// Always mints our own RFC 2822 Message-ID (stored in messages.message_id)
// rather than relying on Gmail's API id, so /webhook/inbound's
// In-Reply-To/References matching keeps working regardless of send path.
// When `inReplyTo`/`references`/`threadId` are passed (follow-up steps),
// both the email headers and the Gmail conversation thread carry over.
export async function sendMail({ from, to, subject, text, inReplyTo, references, threadId }) {
  const messageId = `<${randomUUID()}@frank-outreach>`;
  const client = getOAuthClient();

  if (!client) {
    console.log(`[gmail:stub] to=${to} from=${from} subject=${JSON.stringify(subject)}\n${text}`);
    return { messageId, threadId: threadId ?? null, stubbed: true };
  }

  const raw = buildRawMessage({ from, to, subject, text, messageId, inReplyTo, references });
  const result = await gmailApiSend(client, { raw, threadId });

  return { messageId, threadId: result.threadId ?? threadId ?? null, stubbed: false };
}
