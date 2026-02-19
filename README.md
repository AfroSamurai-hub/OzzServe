# OzzServe: Reliable Service Marketplace

OzzServe is a high-reliability service marketplace tailored for the South African market. This repository contains the backend API and associated logic for managing the service lifecycle, payments, and security.

## 🚀 Overview
- **Core Technology**: Node.js, Fastify, TypeScript, PostgreSQL.
- **Key Features**: Deterministic state machine, OTP verification, Stripe/PayFast integration, and idempotent webhook handling.
- **Location**: The main business logic and API implementation reside in `apps/api`.

## 📂 Repository Structure
- `apps/api`: The primary backend service.
  - `src/logic`: Core domain logic (State Machine, Bookings, Payments).
  - `src/app.ts`: Server configuration and routing.
  - `test/`: Comprehensive integration and unit tests.
- `docs/`: Product policies, architecture decisions (ADRs), and developer runbooks.
- `tests/`: Global test stubs and shared verification scripts.

## 🛡️ Security & Auditing
- Authentication is handled via Firebase.
- Webhook signatures are strictly verified.
- All financial transactions follow an audit-ledger pattern with idempotency guards.

## 🔧 Getting Started
Please refer to the `docs/runbooks/LOCAL_DEV.md` for local setup instructions or `docs/policies/SCOPE_MVP.md` for project scope details.
