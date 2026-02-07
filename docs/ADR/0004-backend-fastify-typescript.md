# ADR 0004: Backend Framework - Fastify + TypeScript

## Context
We need a lean, high-performance API to manage the marketplace lifecycle, payments safety, and service coordination. The API will be deployed as a stateless HTTP container on Cloud Run.

## Decision
We will use **Node.js** with **TypeScript** and the **Fastify** framework for the `apps/api` service.

## Rationale
- **Performance**: Fastify is one of the fastest web frameworks for Node.js.
- **TypeScript Support**: Fastify has excellent built-in support for TypeScript and schema-based validation (Ajv).
- **Testing**: The `fastify.inject()` pattern allows for robust integration testing without needing to bind to a network port.
- **Ecosystem**: Strong plugin ecosystem for security, logging, and validation.

## Consequences
- Routing will be schema-first to align with [API_CONTRACTS.md](file:///home/rick/OzzServe/docs/policies/API_CONTRACTS.md).
- Validation will be strictly enforced at the boundary.
- Tests will follow the `buildServer()` pattern to ensure portability and ease of execution.
