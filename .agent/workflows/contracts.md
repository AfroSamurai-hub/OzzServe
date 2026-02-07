---
description: Regenerates or updates the core policy documents for the OzzServe MVP.
---

### Plan
1. Review existing policy documents in `docs/policies/`.
2. Ensure they align with the latest MVP scope and requirements.
3. Update or recreate the five core files: `SCOPE_MVP.md`, `STATE_MACHINE.md`, `PAYMENTS.md`, `API_CONTRACTS.md`, and `AI_SCOPE.md`.
4. Validate consistency between the documents.

### Execution
- Use `write_to_file` or `replace_file_content` to update the following:
  - `docs/policies/SCOPE_MVP.md`
  - `docs/policies/STATE_MACHINE.md`
  - `docs/policies/PAYMENTS.md`
  - `docs/policies/API_CONTRACTS.md`
  - `docs/policies/AI_SCOPE.md`

### Verification Checklist
- [ ] All 5 documents exist in `docs/policies/`.
- [ ] `SCOPE_MVP.md` contains the mandatory checklist and refusal/kill lists.
- [ ] `STATE_MACHINE.md` has a complete transition table and side-effects.
- [ ] `PAYMENTS.md` lists the 5 non-negotiable invariants.
- [ ] `API_CONTRACTS.md` defines /v1 endpoints and shapes.
- [ ] `AI_SCOPE.md` specifies forbidden AI decisions.
- [ ] No product code has been written during this process.
