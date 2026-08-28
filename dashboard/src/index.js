import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTotals, getByCampaign, getByNiche } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/stats', async (_req, res) => {
  try {
    const [totals, byCampaign, byNiche] = await Promise.all([
      getTotals(),
      getByCampaign(),
      getByNiche(),
    ]);
    res.json({ totals, byCampaign, byNiche, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (_req, res) => {
  try {
    await getTotals();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`frank-outreach dashboard listening on :${port}`);
});
