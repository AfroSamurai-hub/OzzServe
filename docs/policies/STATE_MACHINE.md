# State Machine: Booking Lifecycle (LOCKED)

This document defines the immutable lifecycle states and transitions for bookings.

## States
- `PENDING`: Initial state after user selects a slot.
- `AWAITING_PAYMENT`: Payment session created, waiting for provider.
- `PAID`: Payment confirmed, service not yet rendered.
- `IN_PROGRESS`: Service currently active.
- `CLOSED`: Service completed, funds eligible for payout.
- `CANCELLED`: Terminal state, refund processed if applicable.

## Transitions Table

| From | To | Trigger | Who | Side Effects |
| :--- | :--- | :--- | :--- | :--- |
| `NULL` | `PENDING` | `create_booking` | User | Notification: Created |
| `PENDING` | `AWAITING_PAYMENT` | `initiate_checkout` | User | Stripe Session Create |
| `AWAITING_PAYMENT` | `PAID` | `webhook_success` | System | Notification: Confirmed |
| `AWAITING_PAYMENT` | `CANCELLED` | `timeout_15m` | System | Release Slot |
| `PAID` | `IN_PROGRESS` | `start_service` | Provider | Notification: Started |
| `IN_PROGRESS` | `CLOSED` | `complete_service` | Provider | Payout Queue Entry |
| `PAID` | `CANCELLED` | `refund_request` | Admin | Refund Trigger |

## Rules & Constraints
- **Timeouts**: `PENDING` and `AWAITING_PAYMENT` expire after 15 minutes of inactivity.
- **Cancellation**: Users can cancel up to `PAID` state. Post-`PAID` requires Admin intervention.
- **Side Effects**: All transitions MUST trigger a ledger entry (see PAYMENTS.md).
