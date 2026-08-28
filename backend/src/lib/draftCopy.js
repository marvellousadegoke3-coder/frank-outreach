import Anthropic from '@anthropic-ai/sdk';

let anthropic = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// [first name], Frank Digitals — SENDER_FIRST_NAME is the human sending
// these, not the lead. Falls back to the bare agency name if unset.
function signatureLine() {
  const senderName = process.env.SENDER_FIRST_NAME;
  return senderName ? `${senderName}, Frank Digitals` : 'Frank Digitals';
}

const STEP_ANGLE = {
  1: 'a cold intro anchored to the specific signal given below — this is the first email this lead has ever received from us',
  2: 'a follow-up sent 2 days after the first email: add one new piece of value or a short proof point, do not just "bump" the thread',
  3: 'a breakup email sent 5 days after the first email: polite, low-pressure, inviting them to reply if priorities change',
};

const SUBJECT_ANGLE = {
  1: 'curiosity or observation based — hint at the signal without stating it outright',
  2: 'a short bump, e.g. "following up" or "quick bump"',
  3: 'closing-the-loop tone, e.g. "one more thing" or "closing the loop"',
};

function buildSystemPrompt(step) {
  return [
    'You write cold outreach emails for Frank Digitals, a B2B AI automation agency.',
    'The recipient is always a decision-maker — CEO, founder, owner, or principal/managing partner — never a generic employee or department contact.',
    `Write ${STEP_ANGLE[step] ?? STEP_ANGLE[1]}.`,
    '',
    'TONE: founder-to-founder, peer-to-peer — never vendor-to-employee, never corporate vendor-speak. No generic flattery, no exclamation points, no emoji.',
    '',
    'SUBJECT LINE: under 4 words, lowercase, no punctuation, no emoji, no sales language, never the words "ai" or "automation".',
    `Angle for this subject: ${SUBJECT_ANGLE[step] ?? SUBJECT_ANGLE[1]}.`,
    '',
    'BODY: plain text only, 50-125 words, no HTML, no images, no links (none were supplied, so never fabricate one). Structure, in this order:',
    "1. One concrete observation tied to the lead's signal/company/domain/niche given below.",
    '2. One line reframing the cost of that problem in time or missed revenue.',
    "3. One soft, interest-based CTA — ask if they'd want to see how, never \"book a call\" or similar hard CTA.",
    '',
    `Sign the email as exactly "${signatureLine()}" on its own final line.`,
    'Do not include any internal or system tags in your response.',
    'Respond with ONLY a JSON object: {"subject": "...", "body": "..."}',
  ].join('\n');
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Guards against the model drifting from hard constraints we can't afford to
// relax (banned words in the subject, wildly off body length) — anything
// that fails this falls back to the deterministic template rather than
// shipping copy that breaks the spec.
function violatesSpec({ subject, body }) {
  const subjectWords = wordCount(subject);
  if (subjectWords === 0 || subjectWords > 4) return true;
  if (/\bai\b|\bautomation\b/i.test(subject)) return true;
  if (/[.!?]/.test(subject)) return true;

  const bodyWords = wordCount(body);
  if (bodyWords < 40 || bodyWords > 140) return true;
  if (body.includes('!')) return true;
  if (/https?:\/\//i.test(body)) return true;

  return false;
}

function fallbackDraft(step, lead) {
  const name = lead.first_name || 'there';
  const company = lead.company || 'your business';
  const signal = lead.signal || `how things run day-to-day at ${company}`;
  const signature = signatureLine();

  if (step === 1) {
    return {
      subject: 'quick observation',
      body: `Hi ${name},\n\nNoticed ${signal} over at ${company}. That kind of gap usually costs an hour or two a day somewhere — often more in follow-up that never happens.\n\nWould you want to see how a few other owners in a similar spot fixed this?\n\n${signature}`,
    };
  }
  if (step === 2) {
    return {
      subject: 'following up',
      body: `Hi ${name},\n\nOne more thing on ${signal} — we recently helped a similar owner close that exact gap in under a week, no new hires involved.\n\nWorth a quick look at how it worked?\n\n${signature}`,
    };
  }
  return {
    subject: 'closing the loop',
    body: `Hi ${name},\n\nHaven't heard back, so I'll take that as this isn't a priority right now. If ${signal} becomes one later, just reply and I'll share what we do.\n\n${signature}`,
  };
}

// Drafts a subject + plain-text body for a given follow-up step, grounded in
// the lead's specific signal (not a generic niche pitch) and written
// founder-to-founder. Falls back to a deterministic template — matching the
// same subject/body/tone spec — when ANTHROPIC_API_KEY isn't set, the API
// call fails, or the model's output violates a hard constraint.
export async function draftMessage({ step, lead }) {
  const client = getClient();
  if (!client) return fallbackDraft(step, lead);

  const context = [
    `Company: ${lead.company || 'unknown'}`,
    `Domain: ${lead.domain || 'unknown'}`,
    `Niche: ${lead.niche || 'unknown'}`,
    `Signal (why this lead was sourced): ${lead.signal || 'none given'}`,
    `First name: ${lead.first_name || ''}`,
    `City/Country: ${lead.city || ''} ${lead.country || ''}`,
  ].join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      thinking: { type: 'disabled' },
      system: buildSystemPrompt(step),
      messages: [{ role: 'user', content: context }],
    });

    // Sonnet 5 has adaptive thinking on by default, so content[0] is often a
    // thinking block rather than text — find the actual text block instead
    // of assuming position 0.
    const text = msg.content?.find((block) => block.type === 'text')?.text ?? '';
    const parsed = JSON.parse(extractJson(text));
    if (!parsed.subject || !parsed.body) throw new Error('missing subject/body in draft response');

    const draft = { subject: String(parsed.subject).toLowerCase().trim(), body: String(parsed.body).trim() };

    if (violatesSpec(draft)) {
      console.error(`[draftCopy] Claude draft violated spec, using fallback template — subject="${draft.subject}"`);
      return fallbackDraft(step, lead);
    }

    return draft;
  } catch (err) {
    console.error(
      `[draftCopy] Claude call failed, using fallback template — status=${err.status ?? 'n/a'} message=${err.message}`,
      err.error ?? ''
    );
    return fallbackDraft(step, lead);
  }
}
