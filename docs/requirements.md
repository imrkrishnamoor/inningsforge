# Player Development Tracker

## Overview
Web app to track player development during a 16-day cricket summer camp.

Features:
- Player registration
- Attendance tracking
- Performance metrics
- Coach feedback
- Progress charts
- Final report for parents

Goal: measure improvement in skills over 16 days.

Example:
Catch success: 4/10 → 7/10 (+75%)

Users:
- Coach
- Parent
- Admin

## Auth And Account Policy (V1)

- No OAuth providers (no Google sign-in, no social sign-in).
- Signup is inline through app forms for student, parent, coach, and admin-created users.
- Every account is created with an internal system-generated account ID.
- Email is mandatory for communication and notifications.
- Email is not the unique identity key for the account model.
- Account can become active only after first-time email verification.
- Unverified accounts must be auto-purged after 7 days from creation.

### Account Lifecycle

1. User submits signup form.
2. System creates account in `pending_verification` state.
3. Verification email/token is issued.
4. User verifies within 7 days -> account state moves to `active`.
5. If not verified in 7 days -> account and dependent onboarding artifacts are purged.

### Minimum Account Fields

- account_id (internal unique ID)
- role (`student` | `parent` | `coach` | `admin`)
- profile fields (name, optional age/player role as applicable)
- email (required, communication channel)
- email_verified (boolean)
- verification_status (`pending_verification` | `active` | `purged`)
- created_at
- verification_deadline_at