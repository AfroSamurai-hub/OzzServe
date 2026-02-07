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
- **Health Check**: `GET http://localhost:3000/v1/health`

## Structure Notes
- `/src/app.ts`: Contains the `buildServer()` function used for testing and production.
- `/src/logic/`: Contains domain-specific logic (state machine, idempotency).
- `/test/`: Integration and unit tests using Vitest.
