# PayHub mock development

Use Node.js 24 LTS, JavaScript ESM, Express, native fetch, Map and node:test.
Keep one process and RAM-only state. Do not introduce persistence, queues, UI,
scenario setup APIs or Salesforce business logic. Credentials belong in environment
variables; never log credentials, request payloads or callback response bodies.

Preserve acceptance and idempotency atomically before asynchronous work. Scope all
state to X-Mock-Test-Id. Keep accepted response replay independent of later callbacks.
Callbacks may use only the configured URL, with redirects disabled.

For each feature: implement, run npm test, review git diff, then make a Conventional
Commit. Preserve unrelated changes. Never push or rewrite history without instruction.
Use ephemeral local HTTP servers in tests; do not call real Salesforce from tests.
Use .agents/skills/payhub-contract for contract changes and payhub-testing for tests.
