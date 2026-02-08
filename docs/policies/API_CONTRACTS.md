# API Contracts: /v1 (LOCKED)

All API communication must adhere to these immutable contract definitions.

## Base URL
`https://api.ozzserve.com/v1`

## Endpoints

### 1. `POST /bookings`
Create a new booking.
**Request Body:**
```json
{
  "service_id": "uuid",
  "slot_id": "uuid",
  "user_id": "uuid"
}
```
**Response (201):**
```json
{
  "id": "uuid",
  "status": "PENDING",
  "expires_at": "iso-date"
}
```

### 2. `POST /bookings/:id/pay`
Initialize payment intention.
**Response (200):**
```json
{
  "payment_intent_id": "uuid",
  "status": "CREATED",
  "amount": 10000,
  "currency": "ZAR"
}
```

### 3. `POST /webhooks/:provider`
Receive payment events with idempotency ledger.
**Security**: Must verify provider signature.
**Idempotency**: Checked via event ID in JSON body.

### 3. `GET /bookings/:id`
Fetch booking status.
**Response (200):**
```json
{
  "id": "uuid",
  "status": "STATE",
  "ledger": [...]
}
```

### 4. `POST /webhooks/stripe`
Receive payment events.
**Signature Requirement**: Must verify Stripe signature.

## Versioning Policy
- Any breaking change requires a new major version (e.g., `/v2`).
- Deprecated fields should be marked as such for 3 months before removal.
