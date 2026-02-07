# Payments Policy (LOCKED)

This document defines the immutable financial logic and invariants for OzzServe.

## 5 Non-Negotiable Invariants
1. **No Negative Balances**: The system shall never allow a payout that exceeds the available booked funds.
2. **Payout-after-CLOSED**: Funds are only eligible for payout once the state machine reaches `CLOSED`.
3. **Idempotent Webhooks**: Every payment webhook must be idempotent based on the provider's Transaction ID.
4. **Audit Trail**: Every state transition affecting funds MUST have a corresponding ledger entry.
5. **Refund Boundary**: Refunds are only permitted for bookings in `PAID` state. `IN_PROGRESS` and `CLOSED` require dispute resolution (Manual).

## Ledger Tables (Conceptual)
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | UUID | Primary Key |
| `booking_id` | UUID | FK to Booking |
| `amount` | Decimal | Amount in ZAR |
| `type` | Enum | `CREDIT`, `DEBIT` |
| `status` | Enum | `PENDING`, `SETTLED`, `FAILED` |
| `created_at` | Timestamp | Auto |

## Webhook Idempotency Rule
All incoming webhooks from payment providers (Stripe/PayFast) MUST be checked against a `processed_webhooks` table containing the unique provider event ID before any state or ledger changes are applied. Duplicate events must be ignored without triggering secondary side-effects.

## Refund Rules
- **Full Refund**: Permitted if booking is `CANCELLED` by Provider or User (pre-payout).
- **No Refund**: After state moves to `IN_PROGRESS` unless authorized by Admin.
