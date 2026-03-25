# Firebase Setup (V1)

## 1) Create Firebase Project

1. Go to Firebase Console and create a new project for `player-development-tracker`.
2. Enable Firestore Database.
3. Enable Firebase Authentication (provider choice is not Email/Password-dependent for this custom-token flow).
4. Register a Web App and copy the config values.

## 2) Configure Environment

1. Copy `.env.example` to `.env`.
2. Fill all `VITE_FIREBASE_*` values from your Firebase Web App config.
3. Set `VITE_FUNCTIONS_BASE_URL` to your deployed functions host (example: `https://us-central1-your-project-id.cloudfunctions.net`).

Important for local development:

- Create `.env` in project root (this repo currently has `.env.example` only).
- Restart Vite dev server after updating `.env` values.

## 3) Install Dependencies

Run:

```bash
npm install
```

## 4) Rules

Deploy Firestore rules only after validating account lifecycle paths:

```bash
firebase deploy --only firestore:rules

## 5) Functions (Custom Token Auth)

This project uses internal account IDs and Cloud Functions auth endpoints:

- `registerAccount`
- `verifyAccount`
- `loginAccount`
- `purgeExpiredUnverifiedAccounts` (scheduled)

Install function deps:

```bash
cd functions
npm install
```

Deploy functions:

```bash
cd ..
firebase deploy --only functions
```

Function runtime env variables required for email verification flow:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
- `APP_BASE_URL` (frontend URL where users open verification link)

## 6) Deploy Hosting + Rules

```bash
npm run build
firebase deploy --only hosting,firestore:rules
```
```

## 7) Runtime Notes

- Firebase initializer is in `src/lib/firebase.js`.
- It enforces required env keys at startup.
- No OAuth providers are assumed in this setup.
- Custom-token login requires backend endpoint wiring from frontend before live sign-in.
