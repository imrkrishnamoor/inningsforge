# System Architecture

Frontend
- React
- TailwindCSS
- Chart.js

Backend
- Firebase

Firebase Services
- Firebase Auth
- Firestore
- Firebase Hosting
- Firebase Functions (optional)

Auth Model (V1)
- Inline app signup (no OAuth providers)
- Internal account ID as primary identity key
- Email required for communication and verification
- Email verification required before account activation
- Unverified account purge after 7 days (scheduled backend job)

Collections

players
attendance
metrics
sessions
reports
accounts
account_verification_tokens

Verification And Purge Flow
- Create account in `pending_verification` state with verification deadline = created_at + 7 days.
- Issue verification token and send verification communication.
- On successful verification: set account to `active` and `email_verified = true`.
- Scheduled function purges expired unverified accounts and linked onboarding records.