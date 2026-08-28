#!/usr/bin/env node
// One-time local script to authorize this app against your sending Gmail
// account and print a refresh token for GOOGLE_REFRESH_TOKEN.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/gmail-auth.js
//
// It opens (or prints) a Google consent URL, spins up a temporary local
// server to catch the OAuth redirect, exchanges the code for tokens, and
// prints the refresh token. No manual copy/paste of a code is needed.

import http from 'node:http';
import { exec } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars before running this script.');
  console.error('Example: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/gmail-auth.js');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh_token even if this account already granted access before
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

console.log('\nOpen this URL in the browser signed into the Gmail account you want to send FROM:\n');
console.log(authUrl);
console.log('\nApprove access — you will be redirected to a localhost page and this script will pick it up automatically.\n');

if (process.platform === 'darwin') {
  exec(`open "${authUrl}"`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' }).end(`<html><body>Authorization failed: ${error}. You can close this tab.</body></html>`);
    console.error(`\nAuthorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>Authorized — you can close this tab and return to the terminal.</body></html>');

  try {
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      console.log('\nNo refresh_token was returned. This usually means this Google account already');
      console.log('has an active grant for this OAuth client. Revoke it at');
      console.log('https://myaccount.google.com/permissions and re-run this script.');
      process.exit(1);
    }

    console.log('\nSuccess! Set this as GOOGLE_REFRESH_TOKEN:\n');
    console.log(tokens.refresh_token);
    console.log('');
  } catch (err) {
    console.error('\nToken exchange failed:', err.message);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
