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

function toStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function createDateIfValid(year, month, day) {
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return toStartOfDay(date);
}

function parseSheetDate(value) {
  if (value === null || value === undefined || value === '') return null;

  // When valueRenderOption=UNFORMATTED_VALUE, date cells often come as serial numbers.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.round((value - 25569) * 86400 * 1000);
    const parsed = new Date(millis);
    if (Number.isNaN(parsed.getTime())) return null;
    return toStartOfDay(parsed);
  }

  const text = String(value).trim();
  if (!text) return null;

  const match = text.match(/^(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const c = Number(match[3]);

    if (match[1].length === 4) {
      return createDateIfValid(a, b, c);
    }

    if (match[3].length === 4) {
      // Prefer dd/mm/yyyy (Indonesian), fallback to mm/dd/yyyy.
      return createDateIfValid(c, b, a) || createDateIfValid(c, a, b);
    }
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return toStartOfDay(parsed);
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}`;
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
function parseAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  const text = String(value || '').trim();
  if (!text) return 0;

  // Keep only digits and optional leading minus sign (handles "Rp 45.000", "45,000", etc.)
  const normalized = text.replace(/[^\d-]/g, '');
  if (!normalized || normalized === '-') return 0;

  const parsed = parseInt(normalized, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseMessage(body) {
  const parts = body.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const category = parts[0].toLowerCase();
  const amount = parseAmount(parts[1]);
  const notes = parts.slice(2).join(' ') || '-';

  if (amount <= 0) return null;
  return { category, amount, notes };
}

async function getSheetRecords() {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ['Sheet1!A2:A', 'Sheet1!C2:C', 'Sheet1!D2:D', 'Sheet1!E2:E', 'Sheet1!F2:F'],
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });

  const [dates, categories, amounts, notes, months] = (response.data.valueRanges || []).map(
    range => range.values || []
  );

  const maxRows = Math.max(
    dates.length,
    categories.length,
    amounts.length,
    notes.length,
    months.length
  );
  const records = [];

  for (let i = 0; i < maxRows; i += 1) {
    const dateRaw = dates[i]?.[0] ?? '';
    const category = String(categories[i]?.[0] ?? '').trim();
    const amountRaw = amounts[i]?.[0] ?? '';
    const notesRaw = String(notes[i]?.[0] ?? '').trim();
    const monthRaw = String(months[i]?.[0] ?? '').trim();

    if (!dateRaw && !category && !amountRaw && !notesRaw && !monthRaw) {
      continue;
    }

    records.push({
      date: parseSheetDate(dateRaw),
      category: category || 'lainnya',
      amount: parseAmount(amountRaw),
      notes: notesRaw || '-',
      monthText: monthRaw,
    });
  }

  return records;
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

  const allRows = await getSheetRecords();
  const currentMonthKey = getMonthKey(now);
  let monthTotal = 0;
  allRows.forEach(record => {
    if (record.date && getMonthKey(record.date) === currentMonthKey) {
      monthTotal += record.amount;
      return;
    }

    // Fallback for legacy rows without parseable date but with month text in column F.
    if (!record.date && record.monthText === month) {
      monthTotal += record.amount;
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
  const rows = await getSheetRecords();
  const now = getJakartaNow();
  const thisMonth = now.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
  const thisMonthKey = getMonthKey(now);

  let total = 0;
  const byCategory = {};
  rows.forEach(record => {
    if (record.date && getMonthKey(record.date) === thisMonthKey) {
      total += record.amount;
      byCategory[record.category] = (byCategory[record.category] || 0) + record.amount;
      return;
    }

    // Fallback for legacy rows without parseable date but with month text in column F.
    if (!record.date && record.monthText === thisMonth) {
      total += record.amount;
      byCategory[record.category] = (byCategory[record.category] || 0) + record.amount;
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

async function getDailySummary() {
  const rows = await getSheetRecords();
  const todayDate = toStartOfDay(getJakartaNow());
  const today = todayDate.toLocaleDateString('id-ID');

  let total = 0;
  const entries = [];
  rows.forEach(record => {
    if (!record.date || record.date.getTime() !== todayDate.getTime()) return;

    total += record.amount;
    entries.push(`- ${record.category}: Rp ${record.amount.toLocaleString('id-ID')} - ${record.notes}`);
  });

  if (entries.length === 0) {
    return '📅 Belum ada pengeluaran hari ini.';
  }

  return `📅 Hari ini, ${today}\n\n${entries.join('\n')}\n\nTotal: Rp ${total.toLocaleString('id-ID')}`;
}

async function getWeeklySummary() {
  const rows = await getSheetRecords();

  const now = getJakartaNow();
  const monday = toStartOfDay(now);
  const dayOfWeek = monday.getDay(); // 0=Sunday, 1=Monday
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(monday.getDate() - diffToMonday);

  let total = 0;
  const byCategory = {};
  rows.forEach(record => {
    if (!record.date || record.date < monday || record.date > now) return;

    total += record.amount;
    byCategory[record.category] = (byCategory[record.category] || 0) + record.amount;
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
      const summary = await getDailySummary();
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
