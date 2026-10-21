# SmartReturn BRD coverage

Scope: contract and requirement descriptions supplied in the task, including the
Appendix E.3 response subset. The full BRD and Salesforce implementation were not
available. Mock support is tested locally; end-to-end Salesforce outcomes remain
unverified. Error conventions and fourth-attempt SUCCESS for RETRY_503_3 are documented
in README.md, not asserted as additional BRD requirements.

| Requirement | Mock support / automated evidence | Must verify in Salesforce |
| --- | --- | --- |
| INT-03 | POST /v1/refunds; Bearer authentication; key/payload/currency/amount validation; SUCCESS/PENDING, 422, 500/503 and delayed responses. Fast contract and all-scenario tests. | Request mapping, Named Credential, actual endpoint, response parsing and persistence. |
| INT-04 | Authenticated fixed-destination final SUCCESS/FAILED callbacks; refund/merchant correlation; ISO timestamp and CARD_CLOSED; exact duplicate payload. Callback tests verify auth, delays, errors and blocked redirects. | Existing callback handler accepts token, correlates correct Refund record, validates final status and ignores duplicate final deliveries. |
| BR-12 | HTTP_500, HTTP_503, both retry sequences, TIMEOUT and SUCCESS_THEN_TIMEOUT. Per-attempt counters and traces. Fast tests plus a separate real 10-second client timeout against the entry point. | SmartReturn timeout is 10000 ms; retryable classification, retry schedule/limits and stable idempotency key across actual retries. |
| BR-13 | Atomic key/merchant deduplication, payload conflicts, stable refund IDs and immutable accepted response. Concurrent SUCCESS/PENDING tests and lost-response replay prove one accepted refund. | Salesforce persists one refund outcome and creates no duplicate downstream work, even with duplicate callbacks/retries. |
| BR-14 | Protected read-only trace includes attempts, response codes, timestamps, durations, hashed key, acceptance/replay flags and callback outcomes. Auth/privacy/logging tests. | Salesforce records each attempt and correlates outcomes with its Refund record and support logs. |
| BR-15 | PENDING_SUCCESS with callback delay supports observing Salesforce persistence before final delivery. Delivery timing and accepted replay tested. | Confirm the record/status is committed before business notification; verify notification timing/content and persistence failures. The mock does not inspect Salesforce transactions. |
| UAT-06 | RETRY_503_3 returns three consecutive 503s; acceptedCount remains zero through those three attempts. Fourth call would succeed. Sequence tests. | Trigger exactly the permitted attempts, then verify expected failure handling, retry exhaustion and operational follow-up. |
| UAT-07 | SUCCESS or PENDING_SUCCESS supplies a successful refund outcome. Fast scenario and callback tests. | Verify the intended success notification is sent once after persistence to the right recipient with correct content. |
| UAT-10 | A fresh test ID has no attempts; querying traces does not generate refund attempts. Isolation/tracing tests. | Disable PayHub sending, run the flow, wait through its scheduling window, verify zero mock attempts and Salesforce logs. Confirm health and destination so an empty trace is meaningful. |
| OI-06 | SUCCESS_THEN_TIMEOUT accepts one refund before a >=11-second delay. Real 10-second client abort followed by same-key retry returns SUCCESS with acceptedCount=1. | Salesforce recovers from the lost response, reuses its original key, persists the result and avoids duplicate accounting/notification actions. |

## Execution checklist

1. Configure HTTPS Named Credential and valid Salesforce callback token as described
   in README.md. Verify health before running a scenario.
2. Use a fresh X-Mock-Test-Id for each independent UAT case; reuse its key, namespace
   and payload for retries. The test ID is exclusively a mock namespace, not PayHub API.
3. Capture protected traces alongside Salesforce records/logs. Callback HTTP 2xx means
   transport acceptance; it does not prove Salesforce's final business effects.
4. Observe Salesforce outcomes in the last column. No mock test establishes those
   outcomes. No Salesforce org was contacted by this project's automated tests.
5. If the process sleeps/restarts, discard the run's expectations and restart the
   test with a fresh namespace. All state and callback schedules are RAM-only.

Commands: `npm test` runs the fast native node:test suite; `npm run test:integration`
runs the separate real-time timeout smoke test. Tests use only local HTTP receivers,
synthetic credentials and ephemeral ports. Repository-local skills are in
`.agents/skills/payhub-contract` and `.agents/skills/payhub-testing`.
