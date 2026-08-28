import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import healthRoutes from './routes/health.js';
import leadsRoutes from './routes/leads.js';
import verifyRoutes from './routes/verify.js';
import messagesRoutes from './routes/messages.js';
import eventsRoutes from './routes/events.js';
import suppressionRoutes from './routes/suppression.js';
import webhookRoutes from './routes/webhook.js';
import agentRoutes from './routes/agent.js';
import sourceLeadsRoutes from './routes/sourceLeads.js';

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));
app.use(express.json({ limit: '5mb' }));

app.use(healthRoutes);
app.use(leadsRoutes);
app.use(verifyRoutes);
app.use(messagesRoutes);
app.use(eventsRoutes);
app.use(suppressionRoutes);
app.use(webhookRoutes);
app.use(agentRoutes);
app.use(sourceLeadsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`frank-outreach backend listening on :${port}`);
});
