# MVP Scope: OzzServe (LOCKED)

This document defines the boundaries for the OzzServe MVP. No changes are permitted without major version increment.

## Core Features
1. **Service Listing**: Basic directory of available services.
2. **Booking Flow**: Deterministic state-managed booking process.
3. **Payment Integration**: Secure checkout and payout management via Stripe/PayFast.
4. **Basic Notification**: Transactional alerts (email/SMS).

## Refusal List (Future, NOT MVP)
- Multi-currency support (ZAR only for MVP).
- Real-time chat (Asynchronous only).
- Advanced analytics dashboard.
- Native mobile apps (Web-only for MVP).

## Kill List (Explicitly OUT of scope)
- Crypto payments.
- Third-party marketplace integrations.
- Whitelabeling features.

## What Must Be True Before We Write Any Feature Code
- [x] Policy docs are approved and locked.
- [x] State machine transitions are logically sound.
- [x] Payment invariants are non-negotiable and codified.
- [x] API contracts are fixed for /v1.
- [x] AI guardrails are strictly defined and assistive-only.
- [x] Database schema maps 1:1 to the state machine.

## MVP Contract v1 (Frozen)
This section supersedes any conflicting legacy documentation for v1 implementation.

### 🔄 Critical State Flow
`PENDING_PAYMENT` → `PAID_SEARCHING` → `ACCEPTED` → `EN_ROUTE` → `ARRIVED` → `IN_PROGRESS` → `COMPLETE_PENDING` → `CLOSED`

### 💰 Payment & Fees
- **Authorize at Request**: Funds are authorized/held when the user initiates a booking (`PENDING_PAYMENT`).
- **Capture at Completion**: Funds are captured when the provider marks the service as complete.
- **Cancellation**:
  - Free before `EN_ROUTE`.
  - **R10 Flat Fee** applies once state is `EN_ROUTE` or later.
- **Auto-Close**: `COMPLETE_PENDING` automatically transitions to `CLOSED` after **30 minutes** if no issue is reported by the customer.

### 🛡️ Controls & Safety
- **OTP Verification**: A unique OTP is required to transition from `ARRIVED` to `IN_PROGRESS`.
- **Tracking**: GPS tracking is active only during `ACCEPTED`, `EN_ROUTE`, and `ARRIVED` states.
- **Sad Paths**:
  - `CANCELLED`: User or provider cancels (fee logic applies).
  - `EXPIRED`: Unpaid bookings timeout.
  - `NEEDS_REVIEW`: Triggered if customer flags an issue during the 30-min window.

### 📱 Communication
- **WhatsApp**: Used for deep-link notifications only. No support for chat-based "system of record" entries.
