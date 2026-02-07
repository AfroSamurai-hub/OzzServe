# Runbook: Testing

This document outlines the testing strategy and procedures for OzzServe.

## Test Strategy

### Unit Tests
- **Scope**: Discrete logic.
- **Tools**: Vitest/Jest (TBD).
- **Execution**: `npm test`

### Integration Tests
- **Scope**: API & Webhook flows.
- **Tools**: Supertest/Axios.
- **Execution**: `npm run test:integration`

### E2E Tests
- **Scope**: User journeys.
- **Tools**: Playwright/Cypress.
- **Execution**: `npm run test:e2e`

## Smoke Checklist
- [ ] Booking creation returns 201.
- [ ] Illegal state transition (e.g., PENDING -> CLOSED) returns 400.
- [ ] Webhook for same transaction ID ignored if already processed.
- [ ] Webhook handler must be idempotent; duplicate event = no second side-effect.
- [ ] Payment session successfully generated.
- [ ] Checkout URL returned to user.

## CI/CD integration
(Coming soon)
