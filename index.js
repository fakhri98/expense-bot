require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

const TIME_ZONE = 'Asia/Jakarta';
const SHEET_RANGE = 'Sheet1!A:G';
const MONTHLY_BUDGET_RAW = Number(process.env.MONTHLY_BUDGET || 3245000);
const MONTHLY_BUDGET = Number.isFinite(MONTHLY_BUDGET_RAW) && MONTHLY_BUDGET_RAW > 0
  ? MONTHLY_BUDGET_RAW
  : 3245000;

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

function getSpreadsheetIdFromEnv() {
  const rawSpreadsheetId = process.env.SPREADSHEET_ID;
  if (!rawSpreadsheetId) {
    throw new Error('Missing SPREADSHEET_ID in environment variables.');
  }

  const match = rawSpreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : rawSpreadsheetId;
}

function getJakartaNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIME_ZONE }));
}

function parseIdDate(dateText) {
  const parts = (dateText || '').split('/');
  if (parts.length !== 3) return null;

  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = Number(parts[2]);
  if (!day || !month || !year) return null;

  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

const spreadsheetId = getSpreadsheetIdFromEnv();

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: getGoogleCredentialsFromEnv(),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Parse message format: "category amount notes"
// Example: "makan 45000 nasi padang di warteg"
function parseMessage(body) {
  const parts = body.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const category = parts[0].toLowerCase();
  const amount = parseInt(parts[1], 10);
  const notes = parts.slice(2).join(' ') || '-';

  if (Number.isNaN(amount)) return null;
  return { category, amount, notes };
}

async function getSheetRows() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SHEET_RANGE,
  });
  return response.data.values || [];
}

async function appendToSheet(data) {
  const now = getJakartaNow();
  const date = now.toLocaleDateString('id-ID');
  const time = now.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const month = now.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
  const week = `Week ${Math.ceil(now.getDate() / 7)}`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: SHEET_RANGE,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[date, time, data.category, data.amount, data.notes, month, week]],
    },
  });

  const allRows = await getSheetRows();
  let monthTotal = 0;
  allRows.slice(1).forEach(row => {
    if (row[5] === month) {
      monthTotal += parseInt(row[3], 10) || 0;
    }
  });

  const percent = MONTHLY_BUDGET > 0 ? Math.round((monthTotal / MONTHLY_BUDGET) * 100) : 0;

  if (percent >= 100) {
    return (
      `✅ Tercatat! ⚠️ *Budget bulan ini sudah habis!\n` +
      `Total: Rp ${monthTotal.toLocaleString('id-ID')} / Rp ${MONTHLY_BUDGET.toLocaleString('id-ID')}`
    );
  }

  if (percent >= 80) {
    return (
      `Tercatat.\n` +
      `- ${data.category}: Rp ${data.amount.toLocaleString('id-ID')}\n` +
      `- ${data.notes}\n\n` +
      `✅ Tercatat! ⚠️ Budget bulan ini sudah ${percent}% terpakai.`
    );
  }

  return (
    `✅ Tercatat!\n` +
    `- ${data.category}: Rp ${data.amount.toLocaleString('id-ID')}\n` +
    `- ${data.notes}`
  );
}

async function getSummary() {
  const rows = await getSheetRows();
  const thisMonth = getJakartaNow().toLocaleString('id-ID', { month: 'long', year: 'numeric' });

  let total = 0;
  const byCategory = {};
  rows.slice(1).forEach(row => {
    if (row[5] === thisMonth) {
      const amount = parseInt(row[3], 10) || 0;
      const category = row[2] || 'lainnya';
      total += amount;
      byCategory[category] = (byCategory[category] || 0) + amount;
    }
  });

  if (Object.keys(byCategory).length === 0) {
    return `Ringkasan ${thisMonth}: belum ada data.`;
  }

  let summary = `Summary ${thisMonth}\n\n`;
  Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([category, amount]) => {
      summary += `- ${category}: Rp ${amount.toLocaleString('id-ID')}\n`;
    });
  summary += `\nTotal: Rp ${total.toLocaleString('id-ID')}`;

  return summary;
}

async function getDailySummary(mode) {
  const rows = await getSheetRows();
  const today = getJakartaNow().toLocaleDateString('id-ID');

  let total = 0;
  const entries = [];
  rows.slice(1).forEach(row => {
    if (row[0] === today) {
      const amount = parseInt(row[3], 10) || 0;
      total += amount;
      entries.push(`- ${row[2] || 'lainnya'}: Rp ${amount.toLocaleString('id-ID')} - ${row[4] || '-'}`);
    }
  });

  if (entries.length === 0) {
    return '📅 Belum ada pengeluaran hari ini.';
  }

  return `📅 Hari ini, ${today}\n\n${entries.join('\n')}\n\nTotal: Rp ${total.toLocaleString('id-ID')}`;
}

async function getWeeklySummary() {
  const rows = await getSheetRows();

  const now = getJakartaNow();
  const monday = new Date(now);
  const dayOfWeek = monday.getDay(); // 0=Sunday, 1=Monday
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(monday.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);

  let total = 0;
  const byCategory = {};
  rows.slice(1).forEach(row => {
    const rowDate = parseIdDate(row[0]);
    if (!rowDate || rowDate < monday || rowDate > now) return;

    const amount = parseInt(row[3], 10) || 0;
    const category = row[2] || 'lainnya';
    total += amount;
    byCategory[category] = (byCategory[category] || 0) + amount;
  });

  if (Object.keys(byCategory).length === 0) {
    return 'Belum ada pengeluaran minggu ini.';
  }

  let summary = '📆 Minggu ini\n\n';
  Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([category, amount]) => {
      summary += `- ${category}: Rp ${amount.toLocaleString('id-ID')}\n`;
    });
  summary += `\nTotal: Rp ${total.toLocaleString('id-ID')}`;
  return summary;
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const body = req.body.Body?.trim() || '';
  const bodyLower = body.toLowerCase();

  try {
    if (bodyLower === '/help' || bodyLower === 'help') {
      twiml.message(
        `🤖 *Expense Bot - Cara Pakai*\n\n` +
          `*Catat pengeluaran:*\n_kategori jumlah keterangan_\nContoh: makan 45000 nasi padang\n\n` +
          `*Kategori umum:*\nmakan, transport, belanja, tagihan, hiburan, kesehatan, lainnya\n\n` +
          `*Perintah:*\n` +
          `/summary - ringkasan bulan ini\n` +
          `/today - pengeluaran hari ini\n` +
          `/week - pengeluaran minggu ini\n` +
          `/help - tampilkan bantuan ini`
      );
      return res.type('text/xml').send(twiml.toString());
    }

    if (bodyLower === '/today') {
      const summary = await getDailySummary('today');
      twiml.message(summary);
      return res.type('text/xml').send(twiml.toString());
    }

    if (bodyLower === '/week') {
      const summary = await getWeeklySummary();
      twiml.message(summary);
      return res.type('text/xml').send(twiml.toString());
    }

    if (bodyLower.startsWith('/summary')) {
      const summary = await getSummary();
      twiml.message(summary);
      return res.type('text/xml').send(twiml.toString());
    }

    const parsed = parseMessage(body);
    if (!parsed) {
      twiml.message(
        `Format: *kategori jumlah keterangan*\n` +
          `Contoh: makan 45000 nasi padang\n\n` +
          `Ketik /help untuk lihat semua perintah.`
      );
    } else {
      const resultMessage = await appendToSheet(parsed);
      twiml.message(resultMessage);
    }
  } catch (err) {
    console.error(err);
    twiml.message('Error, coba lagi ya.');
  }

  return res.type('text/xml').send(twiml.toString());
});

app.listen(3000, () => console.log('Bot running on port 3000'));
