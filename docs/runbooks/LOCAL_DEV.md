# Local Development: OzzServe API

Follow these instructions to set up and run the OzzServe API service locally.

## Prerequisites
- Node.js (v20+)
- npm

## Setup

1. **Navigate to the API directory**:
   ```bash
   cd apps/api
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

## Running the Service

- **Development mode (with hot-reload)**:
  ```bash
  npm run dev
  ```
- **Production build**:
  ```bash
  npm run build
  npm start
  ```

## Running Tests

- **Run all tests**:
  ```bash
  npm test
  ```

## API Discovery
## API Discovery
- **Health Check**: `GET http://localhost:3000/v1/health`

## Authentication (Dev-Only)
The API uses header-based authentication for local development. Pass the following headers to authorized requests:
- `x-user-id`: [any-uuid-or-string]
- `x-role`: `user` | `provider` | `admin`

**Example (Create Booking):**
```bash
curl -X POST http://localhost:3000/v1/bookings \
  -H "Content-Type: application/json" \
  -H "x-user-id: my-user-id" \
  -H "x-role: user" \
  -d '{
    "service_id": "550e8400-e29b-41d4-a716-446655440001",
    "slot_id": "550e8400-e29b-41d4-a716-446655440002",
    "user_id": "my-user-id"
  }'
```

## Structure Notes
- `/src/app.ts`: Contains the `buildServer()` function used for testing and production.
- `/src/logic/`: Contains domain-specific logic (state machine, idempotency).
- `/test/`: Integration and unit tests using Vitest.
