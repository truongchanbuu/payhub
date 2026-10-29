# SmartReturn PayHub mock

One Node.js 24 LTS / Express process, native Map, fetch and node:test. Select behavior
on each refund request with headers. No scenario setup API or restart is needed.
Without mock headers, a valid request returns SUCCESS. State, accepted refunds,
retry counters, pending callbacks and traces disappear on process restart.

## Run locally

```sh
npm ci
cp .env.example .env
# Edit .env with distinct random PAYHUB_TOKEN and ADMIN_KEY values.
# Set PAYHUB_CLIENT_ID and PAYHUB_CLIENT_SECRET for the OAuth2 token endpoint.
npm test
npm run test:integration # Separate real 10-second timeout check (~10 seconds).
npm start
```

The server binds to `0.0.0.0` on `PORT` (default `3000`). Health:
`http://localhost:3000/healthz` returns `{"status":"ok"}`. Node loads `.env` through
`npm start`; existing environment variables take precedence. Use shell-exported
credentials for the cURL examples (editing `.env` does not export shell variables).
Node 24 is an [LTS release](https://nodejs.org/en/about/previous-releases).

| Variable | Purpose |
| --- | --- |
| `PORT` | Hosting-assigned listener port, default 3000 |
| `PAYHUB_TOKEN` | Required Bearer secret for refund requests |
| `PAYHUB_CLIENT_ID` | OAuth2 client ID used by Salesforce |
| `PAYHUB_CLIENT_SECRET` | OAuth2 client secret used by Salesforce |
| `ADMIN_KEY` | Required distinct secret for read-only tracing |
| `SALESFORCE_CALLBACK_URL` | Full existing Salesforce INT-04 HTTPS endpoint |
| `SALESFORCE_CLIENT_ID` | OAuth client ID for the Salesforce callback integration user |
| `SALESFORCE_CLIENT_SECRET` | OAuth client secret for the Salesforce callback integration user |

Callback URL/client credentials are optional together; incomplete configuration fails startup. PENDING
scenarios return pre-acceptance 503 `CALLBACK_NOT_CONFIGURED` when both are absent.
Plain HTTP callbacks are allowed only to localhost/loopback for local testing.
No incoming header or payload can override the callback destination. Redirects are
never followed. Tokens, callback response bodies and private payloads are not logged.

## Token endpoint

`POST /v1/token` simulates the OAuth2
[client credentials grant](https://www.rfc-editor.org/rfc/rfc6749#section-4.4).
Configure `PAYHUB_CLIENT_ID` and `PAYHUB_CLIENT_SECRET` in the server environment,
then send `application/x-www-form-urlencoded` with `grant_type=client_credentials`.
Authenticate with HTTP Basic (form-encode each credential before Base64 encoding),
or send `client_id` and `client_secret` in the form body. Use only one method per request.
For example, with the client credentials exported in your shell:

```sh
curl http://localhost:3000/v1/token \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$PAYHUB_CLIENT_ID" \
  --data-urlencode "client_secret=$PAYHUB_CLIENT_SECRET"
```

Returns HTTP 200 with `{"access_token":"<PAYHUB_TOKEN>","token_type":"Bearer"}`.
Use `access_token` in the refund request's `Authorization: Bearer <access_token>`
header. This mock returns the configured static token: it does not expire or rotate,
so `expires_in` and `refresh_token` are omitted. Request another token with the same
client credentials when needed. Scopes are unsupported; omit `scope`.

Errors use OAuth2's `{"error":"..."}` format: invalid credentials return
`invalid_client` (401 with `WWW-Authenticate` for header authentication, otherwise
400), missing/duplicate parameters or mixed authentication return 400
`invalid_request`, unsupported grants return 400 `unsupported_grant_type`, and
nonempty scope returns 400 `invalid_scope`. All token responses disable caching.
Both client environment variables may be omitted to keep existing static Bearer
usage; the token endpoint then returns 503 `temporarily_unavailable`. Configuring
only one client variable fails startup. Use HTTPS for the hosted token endpoint.

## INT-03 contract

```sh
export PAYHUB_URL=http://localhost:3000
# Export PAYHUB_TOKEN and ADMIN_KEY securely in your shell before these commands.
curl -i "$PAYHUB_URL/v1/refunds" \
  -H "Authorization: Bearer $PAYHUB_TOKEN" \
  -H 'Idempotency-Key: RR-2610-00015' \
  -H 'X-Mock-Test-Id: test-001' \
  -H 'X-Mock-Scenario: SUCCESS' \
  -H 'Content-Type: application/json' \
  --data '{"merchantRef":"RR-2610-00015","orderNumber":"00012345","amount":1992000,"currency":"VND","reason":"CUSTOMER_RETURN"}'
```

The body must contain exactly those five fields. `merchantRef`, `orderNumber` and
`reason` are nonempty strings up to 200 characters without surrounding whitespace.
`amount` is a positive safe integer in whole VND; only `VND` is supported.
The key is a nonempty string up to 200 characters. Keys and merchantRef need not
match. Request JSON is limited to 16 KiB. Field order does not affect idempotency.

| Result | HTTP and body |
| --- | --- |
| Accepted | 200 `{"refundId":"PH-RF-<uuid>","status":"SUCCESS"}` or `PENDING` |
| Invalid amount / scenario rejection | 422 `{"errorCode":"INVALID_AMOUNT"}` |
| Invalid currency | 422 `{"errorCode":"INVALID_CURRENCY"}` |
| Missing/wrong Bearer token | 401 `{"errorCode":"UNAUTHORIZED"}` |
| Invalid key, payload, JSON, scenario or delay | 400 with an `errorCode` |
| Unsupported content type / excessive JSON size | 415 / 413 |
| Conflicting key payload / accepted merchant payload | 409 `IDEMPOTENCY_CONFLICT` / `MERCHANT_REF_CONFLICT` |
| Conflicting scenario before acceptance | 409 `SCENARIO_CONFLICT` |
| Simulated server failures | 500 `INTERNAL_ERROR` / 503 `SERVICE_UNAVAILABLE` |

Refund IDs are generated once on acceptance and remain stable within the running
process. This implements the Appendix E.3 subset supplied in the task; the complete
BRD was not provided. Validation details and 409 errors are explicit mock conventions.

## Header controls

### Global demo scenario

An operator can set the default scenario for all new requests that do not provide an
`X-Mock-Scenario` header. This is useful for Salesforce, whose production callout does
not send mock headers:

```sh
curl -X PUT "$PAYHUB_URL/__mock/scenario" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"scenario":"TIMEOUT"}'

curl "$PAYHUB_URL/__mock/scenario" -H "X-Admin-Key: $ADMIN_KEY"
curl -X DELETE "$PAYHUB_URL/__mock/scenario" -H "X-Admin-Key: $ADMIN_KEY"
```

`PUT` accepts any exact scenario from the table below. `DELETE` resets the default to
`SUCCESS`. The setting is global to the running process, protected by `X-Admin-Key`,
and disappears on restart or deployment. An explicit request header takes precedence.
Changing the default never changes an existing key's scenario or an accepted refund.
Run UAT cases serially while a non-SUCCESS global scenario is active.

| Header | Meaning |
| --- | --- |
| `X-Mock-Scenario` | Exact uppercase scenario below; first valid request defaults to SUCCESS |
| `X-Mock-Test-Id` | Mock-only namespace, default `default`; nonempty, max 100 characters |
| `X-Mock-Delay-Ms` | Response delay, integer 0–120000; default 0 |
| `X-Mock-Callback-Delay-Ms` | Callback delay after the planned initial response, integer 0–120000; default 1000 |

Initial timing values are retained as defaults for retries; timing headers may
explicitly override the current unaccepted attempt. TIMEOUT scenarios always delay
at least 11000 ms, even when a smaller delay is requested. Use non-sensitive test IDs.

| Scenario | HTTP attempts / callback |
| --- | --- |
| `SUCCESS` | Immediate 200 SUCCESS |
| `PENDING_SUCCESS` | 200 PENDING, then SUCCESS callback |
| `PENDING_FAILED` | 200 PENDING, then FAILED callback with CARD_CLOSED |
| `INVALID_AMOUNT` | 422 on every attempt; no acceptance |
| `HTTP_500` | 500 on every attempt; no acceptance |
| `HTTP_503` | 503 on every attempt; no acceptance |
| `RETRY_503_3` | 503, 503, 503; a fourth attempt succeeds |
| `RETRY_503_2_SUCCESS` | 503, 503, then 200 SUCCESS |
| `TIMEOUT` | No acceptance; delay >=11 seconds, then 504 MOCK_TIMEOUT if still connected |
| `SUCCESS_THEN_TIMEOUT` | Accept SUCCESS immediately; delay first response >=11 seconds; retry replays immediately |
| `DUPLICATE_CALLBACK` | 200 PENDING, then two identical SUCCESS callbacks |

Each authenticated, valid, compatible HTTP attempt consumes one scenario step.
Retries omit `X-Mock-Scenario` to continue the stored scenario. Conflicts and invalid
requests are traced but do not advance that sequence. Pre-acceptance failures never
create an accepted refund. Use a fresh test ID to choose a new scenario for a used key.

Acceptance is synchronous before any response delay or callback work. Same key and
same payload replay the original body; a changed payload returns 409. Another key
for the same accepted merchantRef and same payload also replays that refund; a changed
payload returns 409. Accepted replay ignores all later scenario/timing controls,
including invalid ones, so a retry cannot change an accepted result. PENDING remains
the replayed response even after the provider's final status changes.

Concurrent duplicate requests create one refund and one callback schedule (two
intentional deliveries for DUPLICATE_CALLBACK). Counters, keys and merchants are
independent across test IDs. Run only one process/instance; RAM is not shared.

## Retry and lost-response examples

Repeat this command three times to get 503, 503, SUCCESS. Omit the scenario header
after the first call if desired. Keep the test ID, key and payload unchanged.

```sh
curl -i "$PAYHUB_URL/v1/refunds" \
  -H "Authorization: Bearer $PAYHUB_TOKEN" \
  -H 'Idempotency-Key: RR-retry' -H 'X-Mock-Test-Id: retry-001' \
  -H 'X-Mock-Scenario: RETRY_503_2_SUCCESS' -H 'Content-Type: application/json' \
  --data '{"merchantRef":"RR-retry","orderNumber":"00012345","amount":1992000,"currency":"VND","reason":"CUSTOMER_RETURN"}'
```

For OI-06, use `X-Mock-Scenario: SUCCESS_THEN_TIMEOUT`, a new test ID and `curl
--max-time 10`. The first call times out. Retry the same key/body/test ID without the
scenario header: it returns the stored SUCCESS. Trace `acceptedCount` must be `1`.
For TIMEOUT the same experiment leaves `acceptedCount` at `0`.

## INT-04 callbacks

Configure the actual existing endpoint, for example
`https://YOUR-DOMAIN.my.salesforce.com/services/apexrest/YOUR-INT04-PATH` (illustrative
path, not an endpoint supplied by this project). Configure an OAuth client credentials
flow for a Salesforce integration user with API access and permission to invoke that
endpoint. The mock obtains a fresh access token before each callback, then sends it as
`Authorization: Bearer <access_token>` with JSON:

```json
{"refundId":"PH-RF-<uuid>","merchantRef":"RR-2610-00015","status":"SUCCESS","processedAt":"2026-10-21T16:00:00.000Z"}
```

FAILED includes `"failureReason":"CARD_CLOSED"`. UTC `processedAt` is ISO 8601 and
represents the same timestamp type as the BRD's offset example. DUPLICATE_CALLBACK
reuses the exact serialized body and timestamp for both deliveries.

Select `PENDING_SUCCESS` and `X-Mock-Callback-Delay-Ms: 3000` to allow Salesforce time
to persist PENDING before delivery. Callback timers survive client disconnects while
the process runs. Results record HTTP status, timing and DELIVERED / HTTP_ERROR /
NETWORK_ERROR / TIMEOUT. Only 2xx counts as delivered. A callback has a 5-second timeout;
there are no automatic redeliveries except the selected duplicate scenario. Refresh
expired access tokens in hosting environment configuration; OAuth refresh is outside
this minimal server. Salesforce authentication setup is described in the official
[REST API Quick Start](https://developer.salesforce.com/docs/platform/api-rest/guide/quickstart.html).

## Tracing and UAT-10

```sh
curl --get "$PAYHUB_URL/__mock/attempts" \
  -H "X-Admin-Key: $ADMIN_KEY" --data-urlencode 'testId=test-001'
```

Returns `acceptedCount`, refund ID/status summaries, HTTP `attempts` and
`callbackAttempts`. Attempts have sequence number, timestamps, duration, responseCode,
hashed idempotency key, and acceptance/replay/known-scenario flags. In-flight requests
have null completion fields; disconnected requests retain `responseCode: null` and
`disconnected: true`, because no HTTP response reached the client. Callback payloads,
merchant references, order numbers, raw keys and secrets are excluded. Unknown test
IDs return empty arrays and zero accepted refunds. Tracing is read-only and uncached.

For a demo-friendly transaction timeline, query the protected endpoint by the
Salesforce return request number:

```sh
curl --get "$PAYHUB_URL/__mock/transactions" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  --data-urlencode 'testId=default' \
  --data-urlencode 'merchantRef=RR-2610-00015'
```

The JSON response correlates accepted payment details, HTTP attempts and callback
delivery attempts. It echoes the requested merchant reference for UAT display, but
never returns authorization values, raw idempotency keys, order data, amounts, callback
payloads or response bodies. Pre-acceptance 422/500/503/timeout attempts remain visible
with `payment: null`. Unknown references return 404 `TRANSACTION_NOT_FOUND`. This
endpoint requires the same `X-Admin-Key` as the lower-level trace and disables caching.

For UAT-10: wake and verify the server, use a new test ID in the Salesforce test harness,
confirm an empty trace, disable PayHub sending in Salesforce, execute the refund flow,
wait through the expected scheduling window, then confirm `attempts: []`. Check the
Salesforce logs too: an empty mock trace alone cannot prove that Salesforce was
configured correctly or that no request was sent to a different destination.

## Salesforce Named Credential

1. Create External Credential `PayHubMockAuth` with **Custom** authentication, a
   Named Principal, and secret authentication parameter `Token` equal to `PAYHUB_TOKEN`.
2. Add custom header `Authorization` with formula
   `{!'Bearer ' & $Credential.PayHubMockAuth.Token}`.
3. Create Named Credential `PayHubMock` with the deployed HTTPS base URL and link
   that external credential. Disable **Generate Authorization Header** and enable
   **Allow Formulas in HTTP Header**.
4. Grant the Salesforce callout user External Credential Principal Access through
   a permission set; enable User External Credentials access where required.
5. Point the existing SmartReturn integration at `callout:PayHubMock/v1/refunds`.
   Set its client timeout to **10000 ms**, send Idempotency-Key and the five payload
   fields, and propagate mock headers through the sandbox/UAT test harness.

These setup steps adapt Salesforce Help's
[Use API Keys in Custom Headers with Named Credentials](https://help.salesforce.com/s/articleView?id=sf.nc_custom_headers_and_api_keys.htm&language=en_US&type=5)
(Help article, body verified). The developer guide explains
[Named Credential principal permissions](https://developer.salesforce.com/docs/platform/named-credentials/guide/get-started.html).
Test-specific headers belong in the test harness; concurrent scenarios need distinct
test IDs. Keep ADMIN_KEY outside Salesforce business callouts. The callback uses a
separate Salesforce access token, not the PayHub Named Credential secret.

## CI/CD

[GitHub Actions](.github/workflows/ci.yml) runs on pull requests targeting `main`,
pushes to `main`, and manual workflow dispatch. The `Test and validate` check uses
Node.js 24, installs with `npm ci`, runs both test suites (including real 10-second
timeouts), and validates `render.yaml` against Render's current official schema.
Python is used only for schema validation in CI; the deployed server remains Node.js.
The validation step needs access to PyPI and Render's schema endpoint.

Render performs CD: `branch: main` and `autoDeployTrigger: checksPass` select deployment
of new `main` commits after CI checks pass. This is Render's native
[After CI Checks Pass integration](https://render.com/docs/deploys#integrating-with-ci).
No GitHub deployment secret, deploy hook or Render API key is required.
Pull requests run checks but do not deploy this service. GitHub Actions report test
results; Render reports build/deploy results and checks `/healthz`.

To activate:

1. Publish the committed code to `https://github.com/truongchanbuu/payhub` on `main`
   through your approved Git workflow. This task prepares local commits; it does not
   push them or claim a hosted Actions run succeeded.
2. Enable GitHub Actions for the repository. In the branch rules for `main`, require
   the `Test and validate` check before merging; this rule is configured on GitHub,
   not created by the workflow file.
3. Connect Render to your GitHub account, grant access to this repository, and create
   select a Free Blueprint from `render.yaml`. Start its first deployment after step 5.
   Connecting by a public repository URL alone
   does not enable Render's automatic deployment integration.
4. Set PAYHUB_TOKEN and ADMIN_KEY in Render, plus the Salesforce callback URL, client ID
   and client secret
   when needed. These runtime secrets do not belong in GitHub CI or source control.
5. Run CI for the initial `main` commit and confirm it passes before creating the
   first deployment. The Blueprint's initial provisioning and later manual deploys
   must be checked separately; the CI gate controls subsequent automatic code deploys.
6. For an existing Render service, sync the Blueprint or set **Auto-Deploy → After CI
   Checks Pass** and verify its linked branch is `main`. If using automatic Blueprint
   sync, disable **Auto Sync** when Blueprint changes must not independently trigger
   infrastructure updates; sync those changes after CI succeeds.

After deployment, verify the assigned HTTPS `/healthz` URL and a synthetic refund.
Render's deploy status is distinct from a successful CI check. Every deploy replaces
RAM state and pending callbacks, so start a fresh UAT run after deployments.

## Free HTTPS deployment

`render.yaml` prepares one Render Free Node web service, `npm ci --omit=dev`,
`npm start`, `PORT` binding and `/healthz`. No database or disk is provisioned.

1. Make this repository available to your Render account through your approved Git
   workflow. No remote push or live deployment was performed by this task.
2. Create a Blueprint from `render.yaml`, select Free, and provide the four environment
   values. Leave both Salesforce values empty if callbacks are unnecessary.
3. Verify the assigned HTTPS URL with `/healthz`, then a refund and protected trace.
   Use that verified base URL in Salesforce. Do not use an illustrative URL as live.
4. Before every UAT run, wake the service, wait for health 200, choose a fresh test ID,
   and reset Salesforce-side expectations. Ensure there was no restart during the run.

Render Free currently idles after 15 minutes without inbound traffic; waking takes
about a minute. Restarts, redeploys and sleep lose all this server's RAM state and
scheduled callbacks. Cold starts can exceed the Salesforce timeout and obscure a
scenario. Free usage limits can suspend service. See
[Render Free limitations](https://render.com/docs/free). TLS termination and the
assigned HTTPS address are provided by Render. Configuration follows the
[Blueprint YAML reference](https://render.com/docs/blueprint-spec).

No live deployment URL has been verified. Local health and real HTTP behavior were
verified by automated tests. This mock retains unbounded test traces in RAM until
restart; use synthetic data and restart between test sessions. It does not schedule
Salesforce retries, modify Salesforce statuses, create accounting tasks, publish
Platform Events, or send business notifications. See [BRD coverage](docs/brd-coverage.md).
