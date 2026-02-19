# State Machine: Booking Lifecycle (LOCKED)

This document defines the immutable lifecycle states and transitions for bookings.

## States
- `PENDING_PAYMENT`: Initial state, waiting for authorization.
- `PAID_SEARCHING`: Funds authorized, booking visible to providers.
- `ACCEPTED`: Provider has claimed the booking.
- `EN_ROUTE`: Provider is traveling to the customer (Cancel fee applies).
- `ARRIVED`: Provider at customer location.
- `IN_PROGRESS`: Service active (OTP verified).
- `COMPLETE_PENDING`: Provider marked done, 30-min window for user review.
- `CLOSED`: Terminal success, funds captured, payout eligible.
- `CANCELLED`: Terminal failure, refund/void processed.
- `EXPIRED`: Terminal failure, authorization released.
- `NEEDS_REVIEW`: Manual intervention required (Customer reported issue).

## Transitions Table

| From | To | Trigger | Who | Side Effects |
| :--- | :--- | :--- | :--- | :--- |
| `NULL` | `PENDING_PAYMENT`| `create_booking` | User | Notification: Auth Required |
| `PENDING_PAYMENT`| `PAID_SEARCHING` | `webhook_auth_ok` | System | Broadcaster: New Job |
| `PAID_SEARCHING` | `ACCEPTED` | `claim_booking` | Provider | Notification: Provider Found |
| `ACCEPTED` | `EN_ROUTE` | `start_travel` | Provider | Start GPS Tracking |
| `EN_ROUTE` | `ARRIVED` | `mark_arrived` | Provider | Notification: Arrived |
| `ARRIVED` | `IN_PROGRESS` | `verify_otp` | Provider | Stop GPS Tracking |
| `IN_PROGRESS` | `COMPLETE_PENDING`| `mark_complete` | Provider | Capture Funds, Notification: Review Window |
| `COMPLETE_PENDING`| `CLOSED` | `timeout_30m` | System | Payout Eligible |
| `COMPLETE_PENDING`| `NEEDS_REVIEW` | `report_issue` | User | Alert Admin |
| `PAID_SEARCHING` | `EXPIRED` | `ttl_timeout` | System | Void Authorization |
| `EN_ROUTE` | `CANCELLED` | `cancel_booking` | User | Charge R10 Fee, Void Balance |

## Rules & Constraints
- **OTP**: Transitions to `IN_PROGRESS` MUST have a valid OTP verification.
- **Cancellation**: R10 fee logic is hard-coded for `EN_ROUTE` or later.
- **Tracking**: Tracking endpoints MUST refuse updates if state is not `ACCEPTED/EN_ROUTE/ARRIVED`.
- **Side Effects**: All transitions MUST trigger a ledger entry.
