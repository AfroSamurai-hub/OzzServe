---
description: Sets up the initial testing structure, including the tests folder, documentation, and stubs.
---

### Plan
1. Create the `tests/` directory at the root.
2. Create `docs/runbooks/TESTING.md` with instructions on how to run tests.
3. Add stub files for core testing areas: state machine transitions and webhook idempotency.

### Execution
- Create directory `tests/`.
- Create `docs/runbooks/TESTING.md`.
- Create `tests/stubs/test_state_machine.py` (or .js).
- Create `tests/stubs/test_webhooks.py` (or .js).

### Verification Checklist
- [ ] `tests/` directory exists.
- [ ] `docs/runbooks/TESTING.md` provides clear runner instructions.
- [ ] Stubs for state transitions and webhook idempotency are present and correctly located.
