require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

function getGoogleCredentialsFromEnv() {
  const rawCredentials = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!rawCredentials) {
    throw new Error('Missing GOOGLE_CREDENTIALS_JSON in environment variables.');
  }

  try {
    return JSON.parse(rawCredentials);
  } catch (err) {
    throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON. Use a single-line JSON string.');
  }
}

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: getGoogleCredentialsFromEnv(),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Parse message format: "category amount notes"
// e.g. "makan 45000 nasi padang di warteg"
function parseMessage(body) {
  const parts = body.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const category = parts[0].toLowerCase();
  const amount = parseInt(parts[1]);
  const notes = parts.slice(2).join(' ') || '-';

  if (isNaN(amount)) return null;
  return { category, amount, notes };
}

async function appendToSheet(data) {
  const now = new Date();
  const date = now.toLocaleDateString('id-ID');
  const time = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const month = now.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
  const week = `Week ${Math.ceil(now.getDate() / 7)}`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A:G',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[date, time, data.category, data.amount, data.notes, month, week]],
    },
  });
}

async function getSummary() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A:G',
  });
  const rows = res.data.values || [];
  const thisMonth = new Date().toLocaleString('id-ID', { month: 'long', year: 'numeric' });

  let total = 0;
  const byCategory = {};

  rows.slice(1).forEach(row => {
    if (row[5] === thisMonth) {
      const amount = parseInt(row[3]) || 0;
      const cat = row[2] || 'lainnya';
      total += amount;
      byCategory[cat] = (byCategory[cat] || 0) + amount;
    }
  });

  let summary = `📊 *Summary ${thisMonth}*\n\n`;
  Object.entries(byCategory).sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
    summary += `• ${cat}: Rp ${amt.toLocaleString('id-ID')}\n`;
  });
  summary += `\n*Total: Rp ${total.toLocaleString('id-ID')}*`;
  return summary;
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const body = req.body.Body?.trim() || '';

  try {
    if (body.startsWith('/summary')) {
      const summary = await getSummary();
      twiml.message(summary);
    } else {
      const parsed = parseMessage(body);
      if (!parsed) {
        twiml.message('Format: *kategori jumlah keterangan*\nContoh: makan 45000 nasi padang');
      } else {
        await appendToSheet(parsed);
        twiml.message(`✅ Tercatat!\n• ${parsed.category}: Rp ${parsed.amount.toLocaleString('id-ID')}\n• ${parsed.notes}`);
      }
    }
  } catch (err) {
    console.error(err);
    twiml.message('❌ Error, coba lagi ya.');
  }

  res.type('text/xml').send(twiml.toString());
});

app.listen(3000, () => console.log('Bot running on port 3000'));
