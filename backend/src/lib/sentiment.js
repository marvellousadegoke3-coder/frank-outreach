import Anthropic from '@anthropic-ai/sdk';

const LABELS = ['positive', 'neutral', 'negative', 'unsubscribe', 'meeting_booked', 'auto_reply'];

let anthropic = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

function keywordFallback(text) {
  const t = (text || '').toLowerCase();
  if (/unsubscribe|remove me|stop emailing|take me off/.test(t)) return 'unsubscribe';
  if (/book(ed)? a (call|meeting|time)|calendly|scheduled a (call|meeting)|let's meet|sounds good, let's/.test(t)) {
    return 'meeting_booked';
  }
  if (/out of office|automatic reply|auto-reply|vacation/.test(t)) return 'auto_reply';
  if (/not interested|no thanks|please stop|remove my|unsub/.test(t)) return 'negative';
  if (/interested|sounds great|tell me more|yes,|sure,|let's talk|schedule/.test(t)) return 'positive';
  return 'neutral';
}

// Classifies an inbound reply's sentiment. Uses Claude when ANTHROPIC_API_KEY
// is configured, otherwise falls back to a keyword heuristic so the pipeline
// still functions without the key.
export async function classifySentiment({ subject, body }) {
  const client = getClient();
  if (!client) {
    return { sentiment: keywordFallback(`${subject}\n${body}`), method: 'keyword' };
  }

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 20,
      thinking: { type: 'disabled' },
      system:
        `Classify the sentiment of a cold-outreach email reply. Respond with exactly one word from this list, nothing else: ${LABELS.join(', ')}. Do not include any internal or system tags in your response.`,
      messages: [
        {
          role: 'user',
          content: `Subject: ${subject || ''}\n\nBody:\n${(body || '').slice(0, 4000)}`,
        },
      ],
    });

    // Sonnet 5 has adaptive thinking on by default, so content[0] is often a
    // thinking block rather than text — find the actual text block instead
    // of assuming position 0.
    const text = msg.content?.find((block) => block.type === 'text')?.text?.trim().toLowerCase() ?? '';
    const label = LABELS.find((l) => text.includes(l));
    return { sentiment: label || 'neutral', method: 'claude' };
  } catch (err) {
    console.error(
      `[sentiment] Claude call failed, using keyword fallback — status=${err.status ?? 'n/a'} message=${err.message}`,
      err.error ?? ''
    );
    return { sentiment: keywordFallback(`${subject}\n${body}`), method: 'keyword_fallback_after_error' };
  }
}
