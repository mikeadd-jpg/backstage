// Read-only Google Sheets access through the service account in
// GOOGLE_SERVICE_ACCOUNT_JSON. Each sheet Backstage reads is shared with that account as
// Viewer, so it sees those files and nothing else in Drive. Shared by the Profit tab
// (lib/profit.js) and the Inspiration tab (lib/inspiration.js).
import { google } from 'googleapis';

export function sheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  let key;
  try { key = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  const auth = new google.auth.JWT({
    email: key.client_email,
    // Env stores often turn the key's newlines into literal \n.
    key: String(key.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), serviceEmail: key.client_email };
}

/** True when the Sheets API refused because the file is not shared with the account. */
export function notShared(err) {
  const code = err && (err.code || (err.response && err.response.status));
  return code === 403 || code === 404;
}
