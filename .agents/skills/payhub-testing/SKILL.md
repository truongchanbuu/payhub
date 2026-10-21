---
name: payhub-testing
description: Test header-driven PayHub scenarios, tracing, callbacks and Salesforce integration with this repository.
---
Run npm test with native node:test and ephemeral HTTP listeners. Keep tests fast by
injecting short timeout defaults; test the public server's real 10-second timeout too
when changing its semantics. Use a local authenticated callback receiver, never real
Salesforce credentials. Inspect the scenario table in README.md for all supported values.

Select behavior with X-Mock-Scenario, isolate with X-Mock-Test-Id, and adjust timing
with X-Mock-Delay-Ms and X-Mock-Callback-Delay-Ms. Retries omit scenario headers.
GET /__mock/attempts?testId=... requires X-Admin-Key. Inspect counts and acceptedCount,
not private payloads. Use a new test ID after restart or before a separate test run.
Salesforce must verify retries, persistence-before-notification, notifications and
integration-disabled behavior; a passing mock test cannot establish those outcomes.
