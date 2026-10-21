---
name: payhub-contract
description: Implement or review this SmartReturn PayHub mock's refund contract and idempotency invariants.
---
Read README.md and docs/brd-coverage.md when present. The supplied task defines the
Appendix E.3 subset; do not invent additional BRD requirements.

Preserve 200 SUCCESS/PENDING bodies with refundId and status, 422 INVALID_AMOUNT,
and retryable pre-acceptance 500/503/timeouts. Accept atomically before delay or
callbacks. Replay the original accepted body, including PENDING after a final callback.
Scope keys and merchant references to the mock-only test ID. Conflicting payloads
return 409; a second key for the same accepted merchant cannot create another refund.
Never implement Salesforce retry scheduling, accounting, status flows or notifications.
