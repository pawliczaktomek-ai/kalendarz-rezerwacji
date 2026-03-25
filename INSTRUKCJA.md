# ⚽ Kalendarz Rezerwacji Treningów – Instrukcja uruchomienia

## Co robi ta aplikacja?

- Zawodnicy wchodzą na stronę i **sami rezerwują wolne terminy** treningów
- Po rezerwacji automatycznie dostają **SMS z potwierdzeniem** (Twilio)
- Trener też dostaje SMS o każdej nowej rezerwacji
- Każda rezerwacja jest automatycznie dodawana do **Google Calendar**
- Trener zarządza terminami przez chroniony hasłem **panel admina**

---

## Wymagania

- **Node.js** w wersji 18 lub nowszej → https://nodejs.org/
- Konto **Twilio** (bezpłatny trial wystarczy na start) → https://twilio.com/
- Konto **Google** z dostępem do Google Calendar API (opcjonalnie)

---

## Szybki start

### 1. Zainstaluj zależności

```bash
cd kalendarz-rezerwacji
npm install
```

### 2. Skonfiguruj środowisko

```bash
# Skopiuj plik konfiguracyjny
cp .env.example .env

# Otwórz .env i uzupełnij swoje dane (Twilio, hasło admina, itd.)
```

### 3. Uruchom serwer

```bash
npm start
```

Otwórz przeglądarkę i wejdź na: **http://localhost:3000**

---

## Konfiguracja Twilio (SMS)

1. Załóż darmowe konto na https://www.twilio.com/try-twilio
2. W panelu Twilio skopiuj:
   - **Account SID** → `TWILIO_ACCOUNT_SID` w pliku `.env`
   - **Auth Token** → `TWILIO_AUTH_TOKEN` w pliku `.env`
3. Kup/aktywuj numer telefonu → `TWILIO_PHONE_NUMBER` w `.env`
4. **Konto trial**: SMS działają tylko do zweryfikowanych numerów. Aby wysyłać do dowolnych numerów, aktywuj konto pełne.

> **Bez Twilio** aplikacja działa normalnie, SMS-y są wypisywane w konsoli (tryb testowy).

---

## Konfiguracja Google Calendar

1. Wejdź na https://console.cloud.google.com/
2. Utwórz nowy projekt (np. "Kalendarz Treningów")
3. Włącz **Google Calendar API**: API & Services → Enable APIs → wyszukaj "Calendar"
4. Utwórz **Service Account**: IAM & Admin → Service Accounts → Create
5. Pobierz klucz JSON (Keys → Add Key → JSON) i zapisz jako **`service-account.json`** w folderze aplikacji
6. W Google Calendar na stronie kalendarza.google.com:
   - Otwórz Ustawienia kalendarza → zakładka "Udostępnianie i uprawnienia"
   - Dodaj e-mail Service Account (widoczny w pliku JSON jako `client_email`)
   - Uprawnienia: **"Wprowadzanie zmian w wydarzeniach"**
7. Skopiuj ID kalendarza (widoczny w ustawieniach) do `GOOGLE_CALENDAR_ID` w `.env`

> **Bez service-account.json** aplikacja działa, ale nie synchronizuje z Google Calendar.

---

## Panel trenera

Wejdź na stronę i kliknij **"🔑 Panel trenera"** (prawy górny róg).

W panelu możesz:
- **📆 Terminy** – lista wszystkich slotów, usuwanie
- **➕ Dodaj termin** – dodaj pojedynczy slot (z opcją powtarzania co tydzień)
- **🗓️ Harmonogram** – wygeneruj dziesiątki terminów naraz na podstawie szablonu tygodniowego
- **📋 Rezerwacje** – lista wszystkich rezerwacji z możliwością anulowania (SMS do zawodnika)

---

## Udostępnienie zawodnikom

Aby zawodnicy mogli rezerwować z dowolnego miejsca (nie tylko lokalnie), możesz:

- **Ngrok** (szybki test): `npx ngrok http 3000` → publiczny link
- **Railway / Render** (hosting): darmowe hosty do Node.js
- **VPS** (np. DigitalOcean): pełna kontrola, własna domena

---

## Struktura plików

```
kalendarz-rezerwacji/
├── server.js          ← Backend (Express + Twilio + Google Calendar)
├── package.json       ← Zależności
├── .env               ← Konfiguracja (nie wgrywaj do internetu!)
├── .env.example       ← Szablon konfiguracji
├── service-account.json ← Klucz Google (po skonfigurowaniu)
├── data/
│   └── bookings.json  ← Baza danych (terminy i rezerwacje)
└── public/
    └── index.html     ← Aplikacja webowa dla zawodników i trenera
```
