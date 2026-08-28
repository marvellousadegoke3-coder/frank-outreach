import Anthropic from '@anthropic-ai/sdk';

let anthropic = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

const STEP_ANGLE = {
  1: 'a cold intro: first touch, brief and curious, referencing their specific niche/signal',
  2: 'a bump / add-value follow-up: surface one new piece of value or insight, do not repeat the first email',
  3: 'a breakup email: short, low-pressure, final touch that gives them an easy out',
};

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

function fallbackDraft(step, lead) {
  const name = lead.first_name || 'there';
  const company = lead.company || 'your team';

  if (step === 1) {
    return {
      subject: 'quick question',
      body: `Hi ${name},\n\nNoticed ${company} might be a fit for what we do in ${lead.niche || 'your space'} — worth a quick look?\n\nHappy to share how we've helped similar teams if useful.\n\nBest`,
    };
  }
  if (step === 2) {
    return {
      subject: 'one more thing',
      body: `Hi ${name},\n\nFollowing up — we recently helped a similar company save real hours on this. Curious if it's relevant to ${company} right now.\n\nOpen to a quick chat if so.`,
    };
  }
  return {
    subject: 'should i stop',
    body: `Hi ${name},\n\nHaven't heard back, so I'll assume now isn't the right time. If that changes, I'm here.\n\nAll the best`,
  };
}

// Drafts a subject + plain-text body for a given follow-up step, grounded in
// the lead's niche/company/signal. Falls back to a deterministic template
// when ANTHROPIC_API_KEY isn't set or the API call fails, so /agent/run
// never blocks on it.
export async function draftMessage({ step, lead }) {
  const client = getClient();
  if (!client) return fallbackDraft(step, lead);

  const angle = STEP_ANGLE[step] ?? STEP_ANGLE[1];
  const context = [
    `Company: ${lead.company || 'unknown'}`,
    `Niche: ${lead.niche || 'unknown'}`,
    `Signal: ${lead.signal || 'none'}`,
    `First name: ${lead.first_name || ''}`,
    `City/Country: ${lead.city || ''} ${lead.country || ''}`,
  ].join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 300,
      system:
        `You write short cold outreach emails for a B2B AI automation agency. Write ${angle}. ` +
        'Rules: body under 100 words, plain text only (no markdown), exactly one soft call-to-action, ' +
        "grounded in the lead's niche/company/signal given below, no generic filler or hype. " +
        'Subject must be lowercase, under 4 words, no punctuation. ' +
        'Respond with ONLY a JSON object: {"subject": "...", "body": "..."}',
      messages: [{ role: 'user', content: context }],
    });

    const text = msg.content?.[0]?.text ?? '';
    const parsed = JSON.parse(extractJson(text));
    if (!parsed.subject || !parsed.body) throw new Error('missing subject/body in draft response');

    return { subject: String(parsed.subject).toLowerCase().trim(), body: String(parsed.body).trim() };
  } catch (err) {
    return fallbackDraft(step, lead);
  }
}
