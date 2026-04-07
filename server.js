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

// ─── Przechowywanie danych ────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

// Google Drive – trwałe przechowywanie danych (uŸywa tego samego service account co Calendar)
const GDRIVE_FILENAME = 'csp-bookings.json';
let _driveClient  = null;
let _driveFileId  = null;   // zapamiętujemy ID pliku po pierwszym wyszukaniu

async function getDriveClient() {
  if (_driveClient) return _driveClient;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/calendar',
      ],
    });
    const authClient = await auth.getClient();
    _driveClient = google.drive({ version: 'v3', auth: authClient });
    return _driveClient;
  } catch (e) {
    console.error('Google Drive błąd inicjalizacji:', e.message);
    return null;
  }
}

async function getDriveFileId(drive) {
  if (_driveFileId) return _driveFileId;
  try {
    const folderClause = process.env.DRIVE_FOLDER_ID
      ? ` and '${process.env.DRIVE_FOLDER_ID}' in parents`
      : '';
    const res = await drive.files.list({
      q: `name='${GDRIVE_FILENAME}' and trashed=false${folderClause}`,
      spaces: 'drive',
      fields: 'files(id)',
    });
    if (res.data.files && res.data.files.length > 0) {
      _driveFileId = res.data.files[0].id;
    }
  } catch (e) {
    console.error('Drive – błąd wyszukiwania pliku:', e.message);
  }
  return _driveFileId;
}

function migrateSlots(slots) {
  return slots.map(s => {
    if (!s.bookings) {
      s.bookings = (s.booked && s.booking) ? [s.booking] : [];
      delete s.booking;
    }
    if (s.maxParticipants === undefined) s.maxParticipants = 4;
    if (s.trainer    === undefined) s.trainer    = '';
    if (s.location   === undefined) s.location   = '';
    if (s.eventType  === undefined) s.eventType  = 'trening indywidualny';
    // Uzupełnij trainerPhone dla starych slotów
    if (!s.trainerPhone && s.trainer && TRAINER_PHONES[s.trainer]) {
      s.trainerPhone = TRAINER_PHONES[s.trainer];
    }
    return s;
  });
}

async function loadData() {
  const drive = await getDriveClient();
  if (drive) {
    try {
      const fileId = await getDriveFileId(drive);
      if (fileId) {
        const res = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'json' }
        );
        const data = res.data || { slots: [], bookings: [] };
        if (!data.slots)    data.slots    = [];
        if (!data.bookings) data.bookings = [];
        data.slots = migrateSlots(data.slots);
        return data;
      }
      // Plik jeszcze nie istnieje – zwróć puste dane
      return { slots: [], bookings: [] };
    } catch (e) {
      console.error('Drive loadData błąc:', e.message);
      // W razie błędu Drive, spróbuj lokalnego pliku
    }
  }
  // Fallback: lokalny plik JSON (tryb developerski / brak Drive)
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ slots: [], bookings: [] }, null, 2));
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.slots = migrateSlots(data.slots);
  return data;
}

async function saveData(data) {
  const drive = await getDriveClient();
  if (drive) {
    try {
      const { Readable } = require('stream');
      const content = JSON.stringify(data);
      const fileId  = await getDriveFileId(drive);

      if (fileId) {
        // Zaktualizuj istniejący plik
        await drive.files.update({
          fileId,
          media: { mimeType: 'application/json', body: Readable.from([content]) },
        });
      } else {
        // Stwórz nowy plik (w folderze użytkownika jeśli DRIVE_FOLDER_ID ustawiony)
        const requestBody = { name: GDRIVE_FILENAME, mimeType: 'application/json' };
        if (process.env.DRIVE_FOLDER_ID) {
          requestBody.parents = [process.env.DRIVE_FOLDER_ID];
        }
        const res = await drive.files.create({
          requestBody,
          media: { mimeType: 'application/json', body: Readable.from([content]) },
          fields: 'id',
        });
        _driveFileId = res.data.id;
        console.log(`[OK] Google Drive - stworzono plik danych (id: ${_driveFileId})`);
      }
      return;
    } catch (e) {
      console.error('Drive saveData błąc:', e.message);
      // Fallback do pliku lokalnego
    }
  }
  // Fallback: lokalny plik JSON
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
// Auto-fix corrupted slots on startup
(async () => {
  try {
    const d = await loadData();
    let ch = false;
    for (const s of (d.slots || [])) {
      const t = (s.trainer || '').toLowerCase();
      if (t.includes('pawliczak') && (s.start || '').startsWith('2026-04-03') && !(s.end || '').startsWith('2026-04-03')) {
        console.log('[fix] Correcting slot', s.id);
        s.end = '2026-04-03T17:00:00.000Z';
        ch = true;
      }
    }
    if (ch) await saveData(d);
  } catch (e) { console.error('[fix] error:', e.message); }
})();


// ─── Mapowanie trenerów na numery telefonów ────────────────────────────────────
const TRAINER_PHONES = {
  'Tomasz Pawliczak': '+48607457102',
  'Radosław Salwa':   '+48732962999',
};

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
  let phone = to.replace(/\s+/g, '');
  if (phone.startsWith('0')) phone = '+48' + phone.slice(1);
  else if (!phone.startsWith('+')) phone = '+48' + phone;

  const msgParams = { body, to: phone };
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    msgParams.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  } else {
    msgParams.from = process.env.TWILIO_PHONE_NUMBER;
  }
  await twilioClient.messages.create(msgParams);
}

// ─── Google Calendar ─────────────────────────────────────────────────────────
let calendarClient = null;

async function getCalendarClient() {
  if (calendarClient) return calendarClient;

  let auth;

  // Wariant 1: klucz jako zmienna środowiskowa (Render / produkcja)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
    } catch (e) {
      console.error('Błąd parsowania GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
      return null;
    }
  } else {
    // Wariant 2: plik service-account.json (lokalne środowisko)
    const keyFile = path.join(__dirname, 'service-account.json');
    if (!fs.existsSync(keyFile)) return null;
    auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  }

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
  const evtLabel = slot.eventType
    ? slot.eventType.charAt(0).toUpperCase() + slot.eventType.slice(1)
    : 'Trening';
  const event = {
    summary: `${evtLabel} - ${booking.playerName}`,
    description: [
      `Zawodnik: ${booking.playerName}`,
      `Telefon: ${booking.phone}`,
      slot.eventType ? `Typ: ${evtLabel}`           : '',
      slot.trainer   ? `Trener: ${slot.trainer}`    : '',
      slot.location  ? `Miejsce: ${slot.location}`  : '',
      booking.notes  ? `Uwagi: ${booking.notes}`    : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: slot.start, timeZone: 'Europe/Warsaw' },
    end:   { dateTime: slot.end,   timeZone: 'Europe/Warsaw' },
    colorId: '2',
  };
  try {
    const res = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: event,
    });
    return res.data.id;
  } catch (err) {
    console.error('Google Calendar błąd0', err.message);
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

// Pobierz wszystkie sloty (publiczne)
app.get('/api/slots', async (req, res) => {
  const data = await loadData();
  const now = new Date();
  const slots = data.slots
    .filter(s => new Date(s.end) >= new Date(now - 60 * 60 * 1000))
    .map(s => {
      const bookingsCount  = s.bookings ? s.bookings.length : 0;
      const maxParticipants = s.maxParticipants || 4;
      const isFull          = bookingsCount >= maxParticipants;
      const spotsLeft       = maxParticipants - bookingsCount;

      let title, color;
      if (isFull) {
        title = `Zajety (${maxParticipants}/${maxParticipants})`;
        color = '#e74c3c';
      } else if (bookingsCount > 0) {
        title = `Wolnych: ${spotsLeft}/${maxParticipants}`;
        color = '#e67e22';
      } else {
        title = `Wolny (${maxParticipants} miejsc)`;
        color = '#27ae60';
      }
      if (s.trainer) title += ` - ${s.trainer}`;

      return {
        id: s.id,
        title,
        start: s.start,
        end: s.end,
        booked: isFull,
        spotsLeft,
        bookingsCount,
        maxParticipants,
        eventType: s.eventType || 'trening indywidualny',
        trainer:   s.trainer   || '',
        location:  s.location  || '',
        color,
        textColor: '#ffffff',
      };
    });
  res.json(slots);
});

// Dodaj slot (admin)
app.post('/api/slots', requireAdmin, async (req, res) => {
  const { start, end, repeat, repeatWeeks, eventType, trainer, location, maxParticipants } = req.body;
  if (!start || !end) return res.status(400).json({ error: 'Brakuje start lub end' });

  const data = await loadData();
  const created = [];
  const max = parseInt(maxParticipants) || 4;
  const trainerPhone = (trainer && TRAINER_PHONES[trainer]) ? TRAINER_PHONES[trainer] : null;

  const addSlot = (s, e) => {
    const slot = {
      id: uuidv4(),
      start: s,
      end: e,
      eventType:    eventType    || 'trening indywidualny',
      trainer:      trainer      || '',
      trainerPhone: trainerPhone || null,
      location:     location     || '',
      maxParticipants: max,
      bookings: [],
      booked: false,
      gcalEventId: null,
    };
    data.slots.push(slot);
    created.push(slot);
  };

  addSlot(start, end);

  if (repeat && repeatWeeks > 1) {
    const startDate = new Date(start);
    const endDate   = new Date(end);
    for (let i = 1; i < repeatWeeks; i++) {
      const ns = new Date(startDate); ns.setDate(ns.getDate() + 7 * i);
      const ne = new Date(endDate);   ne.setDate(ne.getDate() + 7 * i);
      addSlot(ns.toISOString(), ne.toISOString());
    }
  }

  await saveData(data);
  res.json({ success: true, slots: created });
});

// Usuń slot (admin)
app.delete('/api/slots/:id', requireAdmin, async (req, res) => {
  const data = await loadData();
  const slot = data.slots.find(s => s.id === req.params.id);
  if (!slot) return res.status(404).json({ error: 'Slot nie istnieje' });

  if (slot.gcalEventId) await deleteFromGoogleCalendar(slot.gcalEventId);
  // Usuń powiązane rezerwacje
  const slotBookingIds = (slot.bookings || []).map(b => b.id);
  data.slots    = data.slots.filter(s => s.id !== req.params.id);
  data.bookings = data.bookings.filter(b => !slotBookingIds.includes(b.id));
  await saveData(data);
  res.json({ success: true });
});

// Edycja slotu (admin)
app.patch('/api/slots/:id', requireAdmin, async (req, res) => {
  const { start, end, eventType, trainer, location, maxParticipants } = req.body;
  const data = await loadData();
  const slot = data.slots.find(s => s.id === req.params.id);
  if (!slot) return res.status(404).json({ error: 'Slot nie istnieje' });

  if (start) slot.start = start;
  if (end)   slot.end   = end;
  if (eventType    !== undefined) slot.eventType    = eventType;
  if (trainer      !== undefined) {
    slot.trainer      = trainer;
    slot.trainerPhone = TRAINER_PHONES[trainer] || null;
  }
  if (location     !== undefined) slot.location     = location;
  if (maxParticipants !== undefined) slot.maxParticipants = parseInt(maxParticipants) || 4;

  await saveData(data);
  res.json({ success: true, slot });
});

// Masowe dodawanie slotów (admin)
app.post('/api/slots/bulk', requireAdmin, async (req, res) => {
  const { weeks = 4, schedule, startFrom, eventType, trainer, location, maxParticipants } = req.body;
  if (!schedule || !Array.isArray(schedule)) return res.status(400).json({ error: 'Brakuje schedule' });

  const data = await loadData();
  const created = [];
  const baseDate = startFrom ? new Date(startFrom) : new Date();
  const max = parseInt(maxParticipants) || 4;
  const trainerPhone = (trainer && TRAINER_PHONES[trainer]) ? TRAINER_PHONES[trainer] : null;

  const monday = new Date(baseDate);
  const dow = monday.getDay();
  const diff = dow === 0 ? 1 : (1 - dow);
  monday.setDate(monday.getDate() + diff);
  monday.setHours(0, 0, 0, 0);

  for (let w = 0; w < weeks; w++) {
    for (const s of schedule) {
      const start = new Date(monday);
      start.setDate(start.getDate() + w * 7 + (s.day - 1));
      start.setHours(s.hour, s.minute || 0, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + (s.durationMin || 60));
      const slot = {
        id: uuidv4(),
        start: start.toISOString(),
        end:   end.toISOString(),
        eventType:    eventType    || 'trening indywidualny',
        trainer:      trainer      || '',
        trainerPhone: trainerPhone || null,
        location:     location     || '',
        maxParticipants: max,
        bookings: [],
        booked: false,
        gcalEventId: null,
      };
      data.slots.push(slot);
      created.push(slot);
    }
  }
  await saveData(data);
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

  try {
  const data = await loadData();
  const slot = data.slots.find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Termin nie istnieje' });

  if (!slot.bookings) slot.bookings = [];
  const maxParticipants = slot.maxParticipants || 4;

  if (slot.bookings.length >= maxParticipants) {
    return res.status(409).json({ error: 'Termin jest już w pełni zajęty' });
  }

  const booking = {
    id: uuidv4(),
    slotId,
    playerName,
    phone,
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };

  slot.bookings.push(booking);
  slot.booked = slot.bookings.length >= maxParticipants;
  data.bookings.push(booking);

  const gcalId = await addToGoogleCalendar(slot, booking);
  if (gcalId) slot.gcalEventId = gcalId;

  await saveData(data);

  const dateStr      = formatDate(slot.start);
  const eventLabel   = slot.eventType ? slot.eventType.charAt(0).toUpperCase() + slot.eventType.slice(1) : 'Trening';
  const trainerInfo  = slot.trainer  ? ` Trener: ${slot.trainer}.`   : '';
  const locationInfo = slot.location ? ` Miejsce: ${slot.location}.` : '';
  const spotsLeft    = maxParticipants - slot.bookings.length;

  // SMS do zawodnika
  try {
    await sendSMS(
      phone,
      `Czesc ${playerName}! ${eventLabel} zarezerwowany na ${dateStr}.${trainerInfo}${locationInfo} Do zobaczenia! - CSPilkarza`
    );
  } catch (e) {
    console.error('SMS do zawodnika – błąd:', e.message);
  }

  // SMS do trenera – wysyłamy do konkretnego trenera przypisanego do slotu
  const trainerSmsNum = slot.trainerPhone
    || (slot.trainer && TRAINER_PHONES[slot.trainer])
    || null;

  if (trainerSmsNum) {
    try {
      await sendSMS(
        trainerSmsNum,
        `Nowa rezerwacja (${eventLabel}): ${playerName} (${phone}) - ${dateStr}.${locationInfo} Wolnych miejsc: ${spotsLeft}/${maxParticipants}`
      );
    } catch (e) {
      console.error(`SMS do trenera (${trainerSmsNum}) – błąd:`, e.message);
    }
  } else if (process.env.TRAINER_PHONE) {
    // Fallback: wyślij do wszystkich (stare sloty bez przypisanego trenera)
    const nums = process.env.TRAINER_PHONE.split(',').map(n => n.trim()).filter(Boolean);
    for (const n of nums) {
      try {
        await sendSMS(n, `Nowa rezerwacja (${eventLabel}): ${playerName} (${phone}) - ${dateStr}.${locationInfo} Wolnych miejsc: ${spotsLeft}/${maxParticipants}`);
      } catch (e) {
        console.error(`SMS do trenera (${n}) – błąd:`, e.message);
      }
    }
  }

  res.json({
    success: true,
    booking,
    spotsLeft,
    message: `Rezerwacja potwierdzona! SMS wysłany na ${phone}. Wolnych miejsc: ${spotsLeft}/${maxParticipants}.`,
  });
  } catch (e) {
    console.error('[book] nieoczekiwany błąd:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Błąd rezerwacji: ' + e.message });
  }
});

// Anuluj rezerwację (admin)
app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
  const data = await loadData();
  const booking = data.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Rezerwacja nie istnieje' });

  const slot = data.slots.find(s => s.id === booking.slotId);
  if (slot) {
    if (!slot.bookings) slot.bookings = [];
    slot.bookings = slot.bookings.filter(b => b.id !== req.params.id);
    slot.booked   = slot.bookings.length >= (slot.maxParticipants || 4);
    if (slot.bookings.length === 0 && slot.gcalEventId) {
      await deleteFromGoogleCalendar(slot.gcalEventId);
      slot.gcalEventId = null;
    }
  }
  data.bookings = data.bookings.filter(b => b.id !== req.params.id);
  await saveData(data);

  // SMS o anulowaniu
  if (booking.phone) {
    try {
      await sendSMS(
        booking.phone,
        `Trening anulowany przez trenera. Skontaktuj sie w celu rezerwacji nowego terminu. - CSPilkarza`
      );
    } catch (e) { /* ignoruj */ }
  }

  res.json({ success: true });
});

// Lista rezerwacji (admin)
app.get('/api/bookings', requireAdmin, async (req, res) => {
  const data = await loadData();
  const bookings = data.bookings.map(b => {
    const slot = data.slots.find(s => s.id === b.slotId);
    return { ...b, slot: slot || null };
  });
  res.json(bookings);
});

// ─── Start serwera ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ─── Plan publiczny (bez auth) ────────────────────────────────────────────────
app.get('/api/plan', async (req, res) => {
  const data = await loadData();
  const plan = (data.slots || [])
    .filter(s => { const t = (s.trainer||'').toLowerCase(); return t.includes('salwa') || t.includes('pawliczak'); })
    .map(s => {
      const bc = (data.bookings||[]).filter(b => b.slotId === s.id).length;
      return { id: s.id, playerName: s.trainer, start: s.start, end: s.end, eventType: s.eventType, trainer: s.trainer, location: s.location, spotsLeft: (s.maxParticipants||4)-bc, maxParticipants: s.maxParticipants||4, bookingsCount: bc };
    })
    .filter(s => s.start);
  res.json(plan);
});

app.listen(PORT, () => {
  console.log(`\nKalendarz rezerwacji dziala na http://localhost:${PORT}`);
  console.log(`Haslo admina: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  if (!twilioClient) console.log('Twilio nie skonfigurowane - SMS dzialaja w trybie testowym (konsola)');
  if (!fs.existsSync(path.join(__dirname, 'service-account.json')))
    console.log('Google Calendar nie skonfigurowane - brak service-account.json');
});
