require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Przechowywanie danych (plik JSON) ───────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ slots: [], bookings: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Twilio ──────────────────────────────────────────────────────────────────
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  if (!twilioClient) {
    console.log(`[SMS – tryb testowy] Do: ${to}\nTreść: ${body}`);
    return;
  }
  // Normalizacja numeru do formatu E.164
  let phone = to.replace(/\s+/g, '');
  if (phone.startsWith('0')) phone = '+48' + phone.slice(1);
  else if (!phone.startsWith('+')) phone = '+48' + phone;

  await twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

// ─── Google Calendar ─────────────────────────────────────────────────────────
let calendarClient = null;

async function getCalendarClient() {
  if (calendarClient) return calendarClient;
  const keyFile = path.join(__dirname, 'service-account.json');
  if (!fs.existsSync(keyFile)) return null;

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const authClient = await auth.getClient();
  calendarClient = google.calendar({ version: 'v3', auth: authClient });
  return calendarClient;
}

async function addToGoogleCalendar(slot, booking) {
  const calendar = await getCalendarClient();
  if (!calendar) {
    console.log('[Google Calendar – brak pliku service-account.json] Pomijam synchronizację.');
    return null;
  }
  const event = {
    summary: `⚽ Trening – ${booking.playerName}`,
    description: `Zawodnik: ${booking.playerName}\nTelefon: ${booking.phone}${booking.notes ? '\nUwagi: ' + booking.notes : ''}`,
    start: { dateTime: slot.start, timeZone: 'Europe/Warsaw' },
    end:   { dateTime: slot.end,   timeZone: 'Europe/Warsaw' },
    colorId: '2', // zielony
  };
  try {
    const res = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: event,
    });
    return res.data.id;
  } catch (err) {
    console.error('Google Calendar błąd:', err.message);
    return null;
  }
}

async function deleteFromGoogleCalendar(eventId) {
  const calendar = await getCalendarClient();
  if (!calendar || !eventId) return;
  try {
    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      eventId,
    });
  } catch (err) {
    console.error('Google Calendar błąd przy usuwaniu:', err.message);
  }
}

// ─── Middleware weryfikacji admina ────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.body?.adminPassword || req.query?.adminPassword || req.headers['x-admin-password'];
  const configured = process.env.ADMIN_PASSWORD || 'admin123';
  if (pwd !== configured) {
    return res.status(401).json({ error: 'Błędne hasło administratora' });
  }
  next();
}

// ─── Formatowanie daty po polsku ──────────────────────────────────────────────
function formatDate(isoString) {
  return new Date(isoString).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ════════════════════════════════════════════════════════════
// API – SLOTY (wolne terminy)
// ════════════════════════════════════════════════════════════

// Pobierz wszystkie sloty (publiczne – bez szczegółów rezerwacji)
app.get('/api/slots', (req, res) => {
  const data = loadData();
  const now = new Date();
  // Zwróć sloty z przyszłości (lub ostatnich 1h dla widoku)
  const slots = data.slots
    .filter(s => new Date(s.end) >= new Date(now - 60 * 60 * 1000))
    .map(s => ({
      id: s.id,
      title: s.booked ? '🔒 Zajęty' : '✅ Wolny',
      start: s.start,
      end: s.end,
      booked: s.booked,
      color: s.booked ? '#e74c3c' : '#27ae60',
      textColor: '#ffffff',
    }));
  res.json(slots);
});

// Dodaj slot (admin)
app.post('/api/slots', requireAdmin, (req, res) => {
  const { start, end, repeat, repeatWeeks } = req.body;
  if (!start || !end) return res.status(400).json({ error: 'Brakuje start lub end' });

  const data = loadData();
  const created = [];

  const addSlot = (s, e) => {
    const slot = { id: uuidv4(), start: s, end: e, booked: false, booking: null, gcalEventId: null };
    data.slots.push(slot);
    created.push(slot);
  };

  addSlot(start, end);

  // Opcja: powtarzaj co tydzień
  if (repeat && repeatWeeks > 1) {
    const startDate = new Date(start);
    const endDate   = new Date(end);
    for (let i = 1; i < repeatWeeks; i++) {
      const ns = new Date(startDate); ns.setDate(ns.getDate() + 7 * i);
      const ne = new Date(endDate);   ne.setDate(ne.getDate() + 7 * i);
      addSlot(ns.toISOString(), ne.toISOString());
    }
  }

  saveData(data);
  res.json({ success: true, slots: created });
});

// Usuń slot (admin)
app.delete('/api/slots/:id', requireAdmin, async (req, res) => {
  const data = loadData();
  const slot = data.slots.find(s => s.id === req.params.id);
  if (!slot) return res.status(404).json({ error: 'Slot nie istnieje' });

  if (slot.gcalEventId) await deleteFromGoogleCalendar(slot.gcalEventId);
  data.slots = data.slots.filter(s => s.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// Masowe dodawanie slotów na podstawie szablonu tygodniowego (admin)
app.post('/api/slots/bulk', requireAdmin, (req, res) => {
  // body: { weeks: 4, schedule: [{ day: 1, hour: 9, minute: 0, durationMin: 60 }, ...] }
  const { weeks = 4, schedule, startFrom } = req.body;
  if (!schedule || !Array.isArray(schedule)) return res.status(400).json({ error: 'Brakuje schedule' });

  const data = loadData();
  const created = [];
  const baseDate = startFrom ? new Date(startFrom) : new Date();

  // Wróć do poniedziałku bieżącego/następnego tygodnia
  const monday = new Date(baseDate);
  const dow = monday.getDay();
  const diff = dow === 0 ? 1 : (1 - dow);
  monday.setDate(monday.getDate() + diff);
  monday.setHours(0, 0, 0, 0);

  for (let w = 0; w < weeks; w++) {
    for (const s of schedule) {
      const start = new Date(monday);
      start.setDate(start.getDate() + w * 7 + (s.day - 1)); // day: 1=pon … 7=nd
      start.setHours(s.hour, s.minute || 0, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + (s.durationMin || 60));
      const slot = { id: uuidv4(), start: start.toISOString(), end: end.toISOString(), booked: false, booking: null, gcalEventId: null };
      data.slots.push(slot);
      created.push(slot);
    }
  }
  saveData(data);
  res.json({ success: true, count: created.length, slots: created });
});

// ════════════════════════════════════════════════════════════
// API – REZERWACJE
// ════════════════════════════════════════════════════════════

// Dokonaj rezerwacji (publiczne)
app.post('/api/book', async (req, res) => {
  const { slotId, playerName, phone, notes } = req.body;
  if (!slotId || !playerName || !phone) {
    return res.status(400).json({ error: 'Brakuje slotId, playerName lub phone' });
  }

  const data = loadData();
  const slot = data.slots.find(s => s.id === slotId);
  if (!slot)        return res.status(404).json({ error: 'Termin nie istnieje' });
  if (slot.booked)  return res.status(409).json({ error: 'Termin jest już zajęty' });

  const booking = {
    id: uuidv4(),
    slotId,
    playerName,
    phone,
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };

  slot.booked  = true;
  slot.booking = booking;
  data.bookings.push(booking);

  // Google Calendar
  const gcalId = await addToGoogleCalendar(slot, booking);
  if (gcalId) slot.gcalEventId = gcalId;

  saveData(data);

  const dateStr = formatDate(slot.start);

  // SMS do zawodnika
  try {
    await sendSMS(
      phone,
      `Cześć ${playerName}! 🎉 Twój trening został zarezerwowany na ${dateStr}. Do zobaczenia na boisku! – Centrum Szkolenia Piłkarza`
    );
  } catch (e) {
    console.error('SMS do zawodnika – błąd:', e.message);
  }

  // SMS do trenera
  if (process.env.TRAINER_PHONE) {
    try {
      await sendSMS(
        process.env.TRAINER_PHONE,
        `📋 Nowa rezerwacja: ${playerName} (${phone}) – ${dateStr}`
      );
    } catch (e) {
      console.error('SMS do trenera – błąd:', e.message);
    }
  }

  res.json({ success: true, booking, message: `Rezerwacja potwierdzona! SMS wysłany na ${phone}.` });
});

// Anuluj rezerwację (admin)
app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
  const data = loadData();
  const booking = data.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Rezerwacja nie istnieje' });

  const slot = data.slots.find(s => s.id === booking.slotId);
  if (slot) {
    if (slot.gcalEventId) await deleteFromGoogleCalendar(slot.gcalEventId);
    slot.booked = false;
    slot.booking = null;
    slot.gcalEventId = null;
  }
  data.bookings = data.bookings.filter(b => b.id !== req.params.id);
  saveData(data);

  // SMS o anulowaniu
  if (booking.phone) {
    try {
      await sendSMS(
        booking.phone,
        `Cześć ${booking.playerName}, Twój trening został anulowany przez trenera. Skontaktuj się w celu rezerwacji nowego terminu. – Centrum Szkolenia Piłkarza`
      );
    } catch (e) { /* ignoruj */ }
  }

  res.json({ success: true });
});

// Lista rezerwacji (admin)
app.get('/api/bookings', requireAdmin, (req, res) => {
  const data = loadData();
  const bookings = data.bookings.map(b => {
    const slot = data.slots.find(s => s.id === b.slotId);
    return { ...b, slot: slot || null };
  });
  res.json(bookings);
});

// ─── Start serwera ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⚽  Kalendarz rezerwacji działa na http://localhost:${PORT}`);
  console.log(`🔑  Hasło admina: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  if (!twilioClient) console.log('⚠️   Twilio nie skonfigurowane – SMS działają w trybie testowym (konsola)');
  if (!fs.existsSync(path.join(__dirname, 'service-account.json')))
    console.log('⚠️   Google Calendar nie skonfigurowane – brak service-account.json');
});
