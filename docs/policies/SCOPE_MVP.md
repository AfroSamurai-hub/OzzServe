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
