# Dual-Cloud Prototyping Framework — Specification

October 8, 2026 · @Jonathan

Revision 2 · October 9, 2026 · review fixes incorporated

Reconstructed from the conversation on October 18, 2026. This restores the revised requirements; it is not a claim of byte-for-byte recovery of the lost workspace files. Historical probe observations are distinguished from currently available artifacts and unrun acceptance checks.

## Purpose and status

This specification defines a TypeScript framework for AI-written prototype applications that share application code across local development, Cloudflare Workers, and AWS Lambda. It records architectural decisions, public contracts, constraints, and acceptance criteria needed for implementation without routine design clarification. It defines the required result rather than task estimates.

This revision incorporates the accepted review fixes: transaction-bound atomic factories, safe populated-data migrations, portable framework timestamps, native local queues, exact API/serialization limits, complete auth bindings, type-aware static checks, and explicit deployment/validation prerequisites. Packaging and first-version behavior are decided below. Ordinary implementation details can be resolved within those contracts; architecture or contract changes require an explicit recorded decision.

**Validation status is separate from design status.** Published dependencies and selected mechanisms were checked against authoritative sources, and specific local SQL/command-construction probes were run during the October 9 review. The framework was not implemented or deployed by that review. The validation-status appendix distinguishes those historical observations from mandatory cloud and real-provider checks that remain unrun. An acceptance requirement is not a claim that the behavior already works.

**Who carries the knowledge.** The owner does not write TypeScript and should not need to remember platform incompatibilities. Every incompatibility must be absorbed by the framework, expressed as a documented rule, or caught by an executable check. Nothing depends on the owner retaining it from a chat.

Four deliverables are required: an installable framework package, a compliance suite on all three targets, an AI skill with a template app, and a demo application using every capability.

## Motivation and fixed architecture

The goal is a common environment for low-volume AI-written prototypes: one app can run locally and deploy to either cloud without platform imports in shared application code. Both clouds are mandatory. Source portability does not mean shared storage, automatic replication, data migration between clouds, or cloud failover.

The framework composes widely used TypeScript/Web API components and owns the seams between application code and runtime. This reduces the custom surface an app-writing agent must learn. Progressive disclosure keeps ordinary feature work focused on the relevant contracts and examples. “Thin” is a design preference, not a line-count requirement: correct auth, migration, idempotency, and error behavior must not be cut to meet an estimated wrapper size.

TypeScript is selected because this design's shared code, Web APIs, Hono integration, and toolchain fit both Workers and Lambda. This choice does not depend on a claim that no other language or framework could ever support both. Alternative-product adoption statistics and activity claims are not implementation prerequisites and are not carried forward as validated facts.

The framework is a Hono app with middleware exposing `c.var.{sql, kv, files, secrets, user, queue}`, target-specific adapters, and SST provisioning. Local uses Cloudflare adapters under workerd with a local-only auth/configuration layer; it does not add an in-memory queue or a third storage adapter set.

| Capability | Cloudflare | AWS | Local |
| --- | --- | --- | --- |
| HTTP | Hono on Workers | Hono on Lambda | Hono under Wrangler/workerd |
| SQL | D1 / SQLite through Drizzle | Aurora Serverless v2 / Postgres through RDS Data API | Local D1; PGlite for Postgres-dialect tests |
| KV | Portable SQL table | Portable SQL table | Portable SQL table |
| Files | R2 through S3 API | S3 | Local R2 S3 endpoint |
| Async webhooks | Cloudflare Queues and DLQ | Standard SQS and DLQ | Native local Cloudflare Queue emulation |
| Auth | Server OIDC code flow and signed session | Same protocol | Local-only mock login |
| Secrets | Worker secret bindings | AWS Secrets Manager | Ignored `.dev.vars` |
| Static web | Worker static assets with API | SST StaticSite and Router with API | Vite proxying the local API |
| Provisioning | Pinned SST v4/Pulumi | Pinned SST v4/Pulumi | None |

| Settled decision | Rationale |
| --- | --- |
| TypeScript client/server; Hono HTTP | Shared Web API code and familiar stock components. |
| Under 100 events/hour, peak 10/minute | Prototype scale; SQL-backed KV and simple queue handlers are sufficient. |
| SST v4 with exact pins | One TypeScript infrastructure template covers both providers; raw provider resources are used only where needed and tested. |
| Portable SQLite/Postgres schema and query subset | Cloudflare uses D1 directly; AWS uses stock Postgres through Data API without VPC Lambdas or NAT. |
| Aurora Serverless v2, minimum 0 ACU | Idle compute can pause; resume errors and bounded retry are explicit rather than assumed away. |
| Local workerd plus PGlite | Worker constraints are exercised locally; a separate SQL run detects Postgres-dialect failures. Neither replaces cloud validation. |
| One origin for the web client and API | First-party cookies and straightforward same-origin API requests; presigned object transfers still require bucket CORS. |
| S3 protocol for files | Shared signing/client behavior across R2 and S3 with explicit endpoint, credential, and pagination differences. |
| Native queues, no polling/job-status API | Async is limited to inbound webhook processing, retry/DLQ behavior, and idempotent SQL effects. |
| Anonymous/authenticated/admin; canonical issuer/sub identity | Avoids email-based privilege matching and ambiguous provider identities. |
| One framework package and one workspace repository | Subpath exports isolate runtime/platform/tooling dependencies without requiring registry publication to validate installation. |

**Scope exclusions:** Azure/GCP, other backend languages, MySQL, arbitrary/dialect-specific SQL, high volume, queue ordering/polling/job-status APIs, roles beyond these three, and production-grade session revocation. Prototype correctness still includes input validation, CSRF, issuer/audience checks, safe migrations, secret handling, and replay-aware delivery.

## 1. Delivery shape and prerequisites

Use one npm-workspace repository containing:

```text
packages/framework/        one installable package, with subpath exports
apps/template/             minimal application, ready to copy
apps/demo/                 shared-notes board
apps/reference/            compliance application, isolated test features
tests/compliance/          shared HTTP/browser test driver
skill/                     SKILL.md, references, examples, templates, scaffolder
scripts/                   dev, build, migration, deploy, teardown orchestration
validation/                evidence manifest and reports
```

Use package name `@lago-morph/prototype-framework`, initial version `0.1.0`, ESM, declaration files, and semantic versioning. Verify installation from an `npm pack` tarball into a clean fixture; public registry publication is not required and must not be assumed possible. The framework has `core`, `cloudflare`, `aws`, `local`, `sst`, and `lint` exports. Infrastructure and development exports must not contaminate runtime bundles.

**Framework subpath exports:**

| Subpath | Contents |
| --- | --- |
| `core` | Capability interfaces, Hono service/user types, `PortableDb`, schema/column helpers, supported query expressions, `atomic`, `newId`, auth middleware/routes, idempotency and verified-webhook registration |
| `cloudflare` | Binding-backed middleware/services, D1 adapter, R2 S3 adapter, Worker secrets, Cloudflare queue shim; reused locally |
| `aws` | Lambda middleware/services, Aurora Data API adapter, S3 adapter, Secrets Manager accessor, SQS shim |
| `local` | Local-only mock auth, Wrangler local R2 configuration, PGlite SQL harness |
| `sst` | Resource/configuration helpers for either target; never imported into runtime app modules |
| `lint` | Type-aware ESLint rules, schema/migration checker, fixtures and diagnostics |

The template pins the exact framework version. Checked-in examples and scaffolds consume the same exports as real applications; internal adapter APIs are not an application escape hatch.

The template and skill use the existing checkout in each isolated task. They do not create another worktree unless the user explicitly requests one. Existing user work and configuration are preserved.

The initial exact dependency baseline is SST `4.17.2`, Wrangler `4.149.0`, Drizzle ORM `0.45.4`, drizzle-kit `0.31.11`, Hono `4.13.13`, aws4fetch `1.0.20`, jose `6.2.12`, and PGlite `0.5.8`. These versions were confirmed published during the review; their combined compatibility is an acceptance gate, not an assumption. Record exact Node, TypeScript, ESLint, test/browser tools, AWS SDKs, and Pulumi provider versions in a toolchain manifest and lockfile. Use SST's pinned provider generation (`@pulumi/cloudflare` 6.15.0 and `@pulumi/aws` 7.20.0) for raw resources, rather than mixing incompatible latest providers. If a pinned version cannot satisfy a required feature, diagnose and record a justified replacement and rerun the affected acceptance gates; do not silently alter the architecture or suppress verification. Dependency upgrades occur in the framework repository with the full compliance matrix; application agents never change the pins.

Local startup needs no cloud account: generate development-only signing secrets in ignored local configuration if absent, preserve existing files, and use mock login. Never generate or invent cloud credentials.

Before provisioning, check names/presence and usability of existing cloud authentication without exposing values. Enumerate missing prerequisites precisely. Cloud tests require authorized AWS credentials/region and Cloudflare account/deployer credentials, including authority to create the required restricted R2 credential. Google requires a real OAuth web client with registered callback URLs and its client secret. Secrets must be supplied securely outside committed files.

Use AWS `us-east-1` as the default region. Preflight a specific available Aurora Postgres version supporting both Data API and Serverless v2 auto-pause; use `17.3` only if the account/region reports it supported, otherwise select the highest available supported 17.x minor and record the resolved version. If no supported version exists, report a blocker rather than guessing. Cloudflare resources must be in the configured account. Use stage-specific resources and stable configured public origins. Generated cloud URLs are acceptable; custom domains are optional. Google callback registrations must match those origins exactly.

Cloud provisioning incurs charges. Use only account/stage permissions authorized for the implementation task; inspect credentials and perform local work before requesting any missing authority. When deployment is not authorized or credentials are unavailable, finish all independent work, report the exact blocked gates, and do not claim the requested cloud validation is complete.

## 2. Runtime and architectural boundary

Use one Hono application and target-specific entry points. Shared HTTP handlers obtain `sql`, `kv`, `files`, `secrets`, `user`, and `queue` through typed `c.var`. Queue shims construct service context outside Hono and pass it explicitly to normalized handlers. They do not fabricate a Hono context.

Each target adapter exports a plain `createServices(env): Services` factory with its target-specific configuration/binding type. `Services` contains `sql`, `kv`, `files`, `secrets`, and `queue`; HTTP middleware adds request-scoped `user` separately. Cloudflare exports `{ fetch: app.fetch, queue: queueHandler }`; AWS HTTP uses `handle(app)` from `hono/aws-lambda` and a separate SQS consumer export. Local reuses the Cloudflare entry structure with its local-only auth layer. The core package exports the factory/service/Hono-variable contracts, and applications never construct target adapters inside business handlers.

Targets are fixed at build time. Local uses the Cloudflare adapters under workerd with a separately selected local auth/configuration layer. Never detect “local” from a request hostname or mutable production environment flag. Construct cheap binding-backed adapters per Worker request, or memoize only configuration-safe objects; initialize reusable AWS clients per cold start. Do not cache request identity across requests.

Only framework adapters, generated entry points, infrastructure files, and tooling may import platform SDKs, read bindings, or access environment configuration. Shared app modules use Web APIs and framework services only. HTTP `user` is null for anonymous users; queue contexts have no authenticated browser user.

Build and inspect both target bundles. Workers bundles must contain no AWS SDK, SST/Pulumi, PGlite, filesystem, or unsupported Node runtime dependencies. The schema target constant is framework-internal and supplied by each build/migration configuration; build SQLite and Postgres schema artifacts in separate processes to avoid module-cache contamination.

## 3. Portable SQL

Use Drizzle D1 locally/on Cloudflare, and `drizzle-orm/aws-data-api/pg` for Aurora. PGlite is the Postgres SQL test harness, not proof of Data API behavior.

Provide `defineTable(name, columns, options?)` and portable column factories. Public table types are Postgres-compatible; runtime construction uses the build dialect. A cast is an internal pinned implementation detail, not a guarantee that every Drizzle method is portable. Narrow database and nested query-builder APIs and enforce an explicit import/query allowlist.

Portable columns are NOT NULL unless `.nullable()` is specified:

| Factory | Postgres | SQLite | Validation |
| --- | --- | --- | --- |
| `id()` | text primary key | text primary key | framework UUID v4; immutable |
| `text()` | text COLLATE "C" | text with binary comparison | well-formed Unicode, no NUL or unpaired surrogates |
| `integer()` | integer | integer | signed 32-bit integral value |
| `number()` | double precision | real | finite JS number; normalize negative zero |
| `timestamp()` | bigint, number mode | integer | nonnegative JS safe integer, epoch milliseconds |
| `boolean()` | boolean | integer, boolean mode | actual boolean only |
| `json<T>()` | json | text, JSON mode | recursively JSON-compatible; no undefined, cycles, bigint, nonfinite numbers, or class instances |
| `ref(() => table.id)` | text FK | text FK | lazy reference to an id column; NO ACTION on update/delete |

Support `.nullable()`, `.unique()`, and `.default(staticValue)` on non-id columns, plus explicitly declared single/composite indexes and unique constraints through table options. Validate defaults with the same portable rules. No SQL defaults, generated columns, auto-increment, composite primary keys, custom collations, CASCADE/SET NULL/RESTRICT actions, or schema-qualified names in v0.1. Reserve `__framework_` table names and migration histories. Restrict identifiers to ASCII lowercase snake_case and validate lengths against both engines.

Validate writes/defaults at the framework boundary and use supported database constraints where appropriate. Treat driver-read values according to these same documented types. Preserve SQL NULL distinctly from JSON null according to the column contract; exclude top-level JSON null as a stored JSON-column value so it cannot be confused with SQL NULL. Runtime input validation is required; TypeScript cannot validate request data.

Allowed queries: select/insert/update/delete, inner/left joins, select-only CTEs and subqueries, comparisons/boolean predicates, limit/offset, upsert against declared unique constraints, and RETURNING. Allow `count`, `countDistinct`, and min/max for text, integer, number, and timestamp. Count results are numbers within JS's safe range; min/max use the column type and return null for empty input. Sum/avg, window functions, full-text search, JSON querying, data-modifying CTEs, dialect-specific operators/methods, relational `db.query`, and raw SQL are excluded in v0.1. Re-export the supported Drizzle expressions through `core` so app code has one allowlist.

Floating-point comparisons in compliance use `abs(actual - expected) <= max(1e-12, 1e-12 * abs(expected))`; both inputs must be finite. Identity, text, integer, timestamp, and boolean contracts use exact comparison. Reject unsafe integer/count conversion rather than silently rounding. Document backend statement/row/result limits in the SQL reference and map exceeded limits to stable errors; the portable column types do not imply unlimited storage or result size.

Framework `asc(col)` means ASC NULLS FIRST; `desc(col)` means DESC NULLS LAST. Include a unique tie-breaker in paginated queries. Compare unordered results as multisets, preserving duplicate counts, unless order is part of the API. `containsText(col, needle)` is literal substring matching with **ASCII-only case folding**; other Unicode characters remain case-sensitive. `%`, `_`, and backslash are literal characters. An empty needle matches every non-NULL string; NULL never matches. Ensure Postgres comparison/folding uses the intended C semantics. Tests must prove this on both dialects and on real Data API.

Writes without RETURNING expose no driver-specific result. RETURNING exposes normalized rows.

### Atomic writes

Use `atomic(db, writeSteps)` where each step is a **synchronous, side-effect-free builder factory** receiving a write-only portable database handle. Each factory returns one supported write builder created from that supplied handle. Async factories and eagerly executed promises are rejected; a valid Drizzle query builder's thenable interface is not itself grounds for rejection. Factories may not execute queries, read SQL, inspect intermediate results, capture a write built on a different handle, or perform network effects.

```ts
await atomic(c.var.sql, [
  writeDb => writeDb.insert(notes).values(note),
  writeDb => writeDb.insert(attachments).values(attachment),
]);
```

The service handle is explicit so there is no ambient request state. Use this exact calling convention in implementation, types, tests, and examples.

On D1, build the statements once and submit one atomic batch. On Data API, begin a transaction, invoke the factories against its write handle, await writes sequentially, and commit; roll back on error. Never await queries captured from the ordinary handle inside a transaction callback. Return per-step normalized RETURNING rows (void for non-returning steps), and require empty input to be a no-op. Compute IDs and other nondeterministic input before constructing the factories. Prove rollback by deliberately failing a later write, and capture transaction IDs in adapter tests.

## 4. Migration contract

Generate paired immutable migration histories with drizzle-kit, one per dialect. Ship reserved framework-table histories separately; apply framework migrations before app migrations. Record checksums and explicit ordering. Generated SQL must not be hand-edited in apps. Deterministic framework transformations are permitted and must record original/transformed hashes. Never regenerate already applied history from the latest schema.

SST provisions databases but is not assumed to apply their migrations. A Worker's `migrations` option concerns Durable Objects, not D1 schema migrations. Deployment explicitly invokes the framework's database migration runners and waits for their recorded success.

The checker rejects DDL outside the portable column/constraint policy and compares logical schemas after applying both histories; comparing only current table/column names is insufficient. Include nullability, defaults, indexes, uniqueness, and foreign-key targets/actions.

For SQLite rebuilds, allow only migration patterns proven safe with the supported NO ACTION foreign keys. Execute deferral, rebuild, restoration, and ledger insert in one atomic unit. Validate original and final row values/counts and foreign-key integrity. Reject unsupported patterns before applying anything. Deferral does not disable CASCADE effects.

Provide a real remote D1 migration runner. **Do not use the pinned drizzle-kit's sequential D1 HTTP migration path for rebuilds**: per-statement REST calls lose deferral scope. Test the supported D1 batch/REST execution mechanism in an actual stage, including a populated parent/child rebuild, deliberate failure, rollback, ledger integrity, rerun without changes, and concurrent-run exclusion. Avoid claiming a local binding test proves the remote runner. If no supported atomic remote mechanism is available, leave this mandatory gate blocked and explain why; do not substitute a destructive drop/recreate.

AWS migrations use a Data API transaction and appropriate privileges. Serialize deploy/migration operations per app/target/stage. Expose bounded schema readiness so newly deployed HTTP/queue handlers cannot process work against an incompatible schema. Required checks include initial deployment, compatible incremental migration with existing data, failed migration, and repeat deploy. Destructive app migration procedures and zero-downtime production upgrades are out of scope.

## 5. Capability contracts

Use typed errors with stable codes. HTTP errors use `{ error: { code, message, requestId } }`; never expose secret values or provider stack traces. The codes/statuses are `INVALID_INPUT`/400, `UNAUTHENTICATED`/401, `FORBIDDEN`/403, `NOT_FOUND`/404, `CONFLICT`/409, `PAYLOAD_TOO_LARGE`/413, `MISSING_CONFIGURATION`/500, `SERVICE_UNAVAILABLE`/503, and `INTERNAL_ERROR`/500. Validate JSON request schemas before business logic. Use a 1,000,000-byte non-file HTTP body cap and a stricter queue cap below. Stable codes are part of the public contract; human-readable messages are not used for control flow.

### KV

Framework table `__framework_kv`: `key` is text primary key, `value` is JSON-serialized text NOT NULL, and `expires_at` is a nullable **portable timestamp**. On Postgres expiry storage is bigint, not INTEGER. SQL/framework schema declarations use the portable helpers and the same range checks as app tables.

```text
get(key) → JsonValue | null
put(key, value, { ttlSeconds? }) → void
delete(key) → void
list(prefix, { limit?, cursor? }) → { items: [{ key, value, expiresAt }], nextCursor }
```

Keys are nonempty well-formed text, at most 1,024 UTF-8 bytes. Prefix is literal and case-sensitive. Limit defaults to 100, range 1–1,000. List order is the portable binary text order; cursor is opaque and bound to the prefix. Missing/expired keys return null; delete is idempotent. TTL, if present, is a positive integer; reject overflow in calculated safe-integer expiry. Expired rows are absent from both get and list. Cleanup can be lazy and must not change observable TTL behavior. Callers validate retrieved values against their schema.

KV accepts JSON null as a value; `get` then returns null just as it does for absence. Applications needing to distinguish these states store a non-null envelope or inspect list entries. `expiresAt` is epoch milliseconds or null, and `nextCursor` is a string or null. Pagination is not a snapshot while writes occur; unchanged data must enumerate without omission/duplication.

### Files

Use aws4fetch/SigV4 against R2's S3 endpoint and S3; local uses Wrangler's experimental R2 S3 endpoint. Stock signing does not eliminate endpoint construction, XML list parsing, pagination, or error mapping.

```text
get(key) → { body: ReadableStream<Uint8Array>, contentType, size, etag } | null
put(key, bytes: Uint8Array, { contentType? }) → void
delete(key) → void
list(prefix, { limit?, cursor? }) → { items: [{ key, size, etag }], nextCursor }
presign(key, { method: "GET" | "PUT", expiresSeconds?, contentType? })
  → { url, headers, expiresAt }
```

Keys are opaque nonempty strings, at most 1,024 UTF-8 bytes, URL-encoded correctly; never turn them into filesystem paths. Content type defaults to `application/octet-stream`; put is an overwrite; missing get returns null; delete is idempotent. Direct put is limited to 4,000,000 bytes. Large browser transfers use presigned URLs; app API routes must not proxy unbounded file content through Lambda. List defaults to 100, maximum 1,000, with a provider continuation cursor bound to the prefix; order by UTF-8 key ordering and preserve exact keys/metadata. Do not confuse a successful HTTP response containing an S3 XML error with success.

Presign lifetime defaults to 300 seconds, integer range 1–900; contentType is supported only for PUT and returned as a required signed header if specified. Cap effective lifetime by credential expiry when known and fail if no usable window remains; presigned URLs also expire if underlying credentials are revoked or expire. Use current Lambda role credentials, including session token, and recreate/update the signer when credentials change. Set S3/R2/local service/region explicitly where endpoint inference would be ambiguous.

Buckets are private. Create a least-privilege stage-scoped R2 credential through supported Pulumi resources; token ID and SHA-256(token value) are its S3 credentials. Deployer privileges are a prerequisite. Store credential material only through secret mechanisms/Pulumi secret outputs. CORS allows the exact configured site origin, GET/PUT/HEAD, required upload headers, and any response headers needed by the browser. Test from a real browser on each cloud, including a rejected unrelated origin. Do not infer cloud CORS from permissive local behavior.

### Secrets

`get(name): Promise<string>` resolves only declared secret names, with a stable error for absent/empty values. Use Worker secret bindings, AWS Secrets Manager ARN mappings, and ignored `.dev.vars` locally. Cache AWS reads for at most 60 seconds; do not persistently negative-cache missing values. Worker secret updates take effect through Worker configuration/deployment, rather than polling Secrets Manager. Resolve admin membership per request using current accessor behavior; do not freeze `isAdmin` into a seven-day session.

Separate nonsecret configuration (origins, provider issuers/client IDs, resource endpoints) from secret values (client secrets, HMAC/session keys, admin list, R2 secret). Explicitly map provisioning outputs to runtime bindings and IAM actions; merely saying “SST linking” is not sufficient to prove Secrets Manager wiring.

### Queue

Local uses native Cloudflare Queues under Wrangler; there is no in-memory adapter. AWS uses standard SQS with partial batch responses enabled. Define one primary webhook queue and DLQ per app/stage, with registry dispatch by handler name if multiple handlers are needed.

`send(body: JsonValue, { delaySeconds?, handlerName? }): Promise<void>` confirms durable acceptance, not consumer completion. Serialize a versioned JSON envelope; maximum **127,000 UTF-8 bytes including framework envelope**. Reject unsupported JSON before sending. Delay is an integer from 0 to 900, default 0. Larger application payloads are stored in files and referenced by key with explicit cleanup responsibility.

The envelope is `{ version: 1, handlerName, body }`. `send` accepts optional `handlerName`, defaulting to the registered `default` handler; reject unknown names before enqueue. Handler names match `[a-z][a-z0-9_-]{0,62}`. The same registry is used by both cloud entries and the local entry. Malformed/unsupported envelopes fail processing and follow the configured retry/DLQ policy.

Handlers receive `{ id, body, attempts }` plus a typed service context; id is the opaque transport message ID and must not be used as a business idempotency key. Attempts are one-based delivery counts. Return acknowledges; throw retries. Cloudflare acknowledges/retries each message individually; AWS returns failed message IDs in a partial-batch response. Process messages independently and handle unexpected batch-level errors without acknowledging unknown outcomes. Delivery is unordered and at least once.

The default retry fixture uses batch size 1, three total configured attempts, Cloudflare `max_retries: 2`, and SQS DLQ `maxReceiveCount: 3`; a separate partial-batch fixture uses at least two messages. Configure a ten-second AWS consumer timeout, a ten-second cooperative processing budget per Cloudflare message, and 60-second SQS visibility timeout; Cloudflare retry delay is one second. Cloudflare's budget is framework behavior, not a claimed platform hard timeout. Timeouts must not acknowledge an unknown outcome, and noncancellable effects are protected by idempotency. Treat visibility as necessary infrastructure configuration despite omitting its management from app APIs. Do not promise identical scheduling or exactly three invocations under every cloud failure. Local concurrency fidelity is explicitly limited.

### Idempotency and webhook delivery

All registered queue handlers must pass through a branded `idempotent(keyFn, handler)` wrapper. `keyFn(msg)` returns `{ namespace, key }`, each nonempty well-formed text at most 256 UTF-8 bytes. Its handler receives `(msg, readContext)` and returns an array of atomic write factories. The read context contains read-only SQL, read-only KV/files access, and the secrets accessor; it has no queue send or file/KV mutation methods. Provide `defineQueueHandler(name, wrappedHandler)` with no unwrapped public overload. The trusted queue shim supplies the complete service handle to the wrapper internally.

Marker identity comprises handler name, provider namespace, and event key encoded as a JSON tuple. Canonicalize the accepted JSON payload by recursively sorting object keys by Unicode code-point order, preserving array order, and using JSON encoding of primitive values; hash the canonical UTF-8 representation with SHA-256. Framework table `__framework_processed_events` has `key` text primary key, `payload_hash` text NOT NULL, and `processed_at` portable timestamp NOT NULL; Postgres time storage is bigint. Do not automatically expire markers in v0.1.

Skip a matching committed marker. Same key with a different payload is a conflict, not a successful duplicate. Commit the marker and business writes in one atomic unit. After an atomic error, re-read the committed marker: acknowledge only when an exact matching marker is present; otherwise rethrow the original failure. Never interpret an arbitrary uniqueness violation as already processed.

Guarantee exactly one committed SQL effect for a key. External network effects can replay. The default read/write-plan handler context must not expose external mutation services. If explicitly supported through a separate documented extension, require the destination's own idempotency key and tests; do not imply distributed exactly-once delivery. Read-derived updates are not serialized reads: avoid using this API as an interactive transaction or a read-modify-write counter.

Provide a generic demo HMAC verifier, not unspecified real-provider implementations. Protocol: `X-Webhook-Timestamp` is unsigned decimal epoch seconds without leading zeros (except `0`), `X-Webhook-Signature` is `sha256=` followed by 64 lowercase hex digits; sign timestamp ASCII + `.` + exact raw body bytes with HMAC-SHA-256. Reject malformed/combined duplicate header values and timestamps more than 300 seconds from server time. Require a valid JSON object containing an `eventId` of 1–256 UTF-8 bytes and validated payload fields. Verify with Web Crypto before parsing; do not use a homemade timing-sensitive string comparison. Read bytes once. A timestamp is not a nonce: repeated valid deliveries inside the window are handled by the event-key guard.

Flow: body-size check → exact signature verification → JSON/schema validation → durable enqueue → HTTP 200. Invalid signature is 401; invalid input is 400; oversized input is 413; failed enqueue is retriable 503 and **never 200**. Retries during the replay window are allowed and deduplicated by event key. Real-provider formats are future documented extensions.

## 6. Authentication

Support anonymous, authenticated, admin. `User` is `{ issuer, sub, email?, isAdmin }`; authorization/ownership always use verified canonical issuer and sub. The core package exports `requireAuth()` and `requireAdmin()` Hono middleware. Protected routes return 401 for missing/invalid authentication and 403 for insufficient authority. Signed webhook routes use their verifier as the authentication policy and do not require browser session/CSRF credentials; a session cookie must not replace or bypass webhook verification.

Google is the first real provider. Additional providers use a stated supported OIDC profile: HTTPS discovery, authorization-code query callback, PKCE S256, token endpoint `client_secret_post` or `client_secret_basic` as explicitly configured, and RS256 ID tokens with usable JWKS. Provider configuration includes a unique provider ID, canonical issuer, client ID, client-secret binding name, token endpoint authentication method, and scopes; Google defaults to `client_secret_post` and `openid email profile`. Request scopes include `openid`. Unsupported profiles fail preflight. Do not promise all standards-compliant providers are interchangeable.

`GET /api/auth/login?provider=...` selects only configured providers. Generate random state, PKCE verifier, and nonce; put provider, exact redirect URI, verifier, state, nonce, sanitized same-origin return path, issued-at, and expiry into the HMAC-signed **HttpOnly transaction cookie** `__Host-prototype_oidc`, valid for ten minutes. Cloud cookie is Secure, SameSite=Lax, Path=/, with no Domain. Only one login attempt is active per browser: a new login replaces the transaction cookie, and an older callback must fail its state binding. Do not put secrets/verifiers into URL state. The cloud callback is exactly `<configured public origin>/api/auth/callback`, never derived from an untrusted Host/forwarded header.

Callback requires the expected browser transaction, exact state, selected provider, and redirect URI. Use the configured discovery endpoints; bind discovery issuer to provider configuration. Exchange with the stored verifier and configured client authentication. Validate ID-token signature, allowed algorithm, issuer, client audience, expiration, issued-at/skew policy, nonce, and `azp` when required by multiple audiences. Do not fetch arbitrary URLs selected from untrusted token headers or claims. Clear transaction state on completion/failure; never create a session before validation.

Accept Google's two documented token issuer spellings only after signature/claim verification, then canonicalize identity to `https://accounts.google.com`. Other issuers use the exact configured canonical issuer. Admin-list secret is a JSON array of two-element `[issuer, sub]` tuples, canonicalized and validated; email never grants authorization.

Session cookie: `__Host-prototype_session`, HMAC-SHA-256 signed with a random minimum 32-byte key, Secure/HttpOnly/SameSite=Lax/Path=/, no Domain, expiry/Max-Age 7 days. Payload contains format version, key ID, canonical issuer, sub, optional email, issued-at, and expiry; no provider tokens or precomputed admin privilege. Reject malformed, oversized, tampered, future-issued, and expired sessions. Allow at most 60 seconds clock skew for provider tokens, not an extension of session lifetime. Support a current and optional previous signing key to allow controlled rotation. Old keys are no longer accepted once removed.

`GET /api/auth/session` returns `{ user, csrfToken }`, with null values when anonymous, and `Cache-Control: no-store`. For cookie authentication the CSRF token is HMAC-SHA-256 over UTF-8 `csrf:v1:` followed by the exact validated session-cookie value, using its signing key. It is supplied in `X-CSRF-Token` and compared with cryptographic verification. Bearer-only authentication returns the authenticated user with null `csrfToken`. `POST /api/auth/logout` clears the cookie with matching attributes. Stateless logout does not revoke a copied valid cookie; document this limit. Cookie-authenticated mutating API requests require the exact configured Origin and a valid CSRF token. Bearer-authenticated requests do not require cookie CSRF. Auth callback GET is governed by its transaction checks. Reject state-changing GET application routes. Local uses non-Secure `prototype_session_local` and `prototype_oidc_local` cookies in loopback-only configuration; production never downgrades its cookies. Local dev URLs use hostname `localhost` consistently.

Configured ID tokens may authenticate scripts via Bearer after the same applicable signature/issuer/audience/lifetime checks. They are ID tokens for the app client, not arbitrary OAuth access tokens. If an Authorization header is present, it takes precedence; invalid/unsupported credentials return 401 and do not fall back to a session cookie. Nonce applies to login transaction ID tokens, not standalone script authentication.

Local mock auth is compiled only into the local entry. Support explicit mock anonymous/user/admin identities for tests without any cloud account. Default demo local login uses issuer `urn:prototype:local`, sub `demo-user`, with admin disabled; the local development setting may enable admin for this identity. The compliance harness uses separate identities. Both cloud builds must lack mock routes and switches.

The compliance reference app may include its own always-approving OIDC provider in explicitly marked ephemeral test stages. It must implement discovery, JWKS, authorization codes, token exchange, PKCE/client checks, nonce/audience, and one-use expiring codes. Its signing keys and routes are isolated from the demo/template; normal cloud artifacts must not contain it. A fake-provider flow does not substitute for a real Google acceptance test.

## 7. Hosting and deployment

Cloudflare: Worker serves both Hono API and Vite build via pinned SST Worker assets support, `runWorkerFirst: ["/api", "/api/*"]`, SPA fallback only outside API routes. Unknown API routes return JSON 404, never index.html. Verify both deployed API and client origin. Inspect supported raw-provider transforms only if the pinned assets integration needs them; a fallback is not “verified” until exercised.

AWS: `sst.aws.Router` routes `/api` and `/api/*` to the HTTP Lambda Function URL, other paths to `sst.aws.StaticSite`. Keep Lambdas outside the VPC. Aurora uses a private VPC with NAT and bastion disabled, Data API enabled, min 0/max 4 ACU, and a five-minute supported pause interval. Explicitly disable API caching and set `Cache-Control: no-store` on auth/personal responses; test cookies/query strings/Authorization forwarding and multiple Set-Cookie handling. Use configured public origin for redirects.

For this prototype use Router's documented unprotected Function URL mode and keep all app authorization/HMAC checks in Hono. The Function URL remains reachable directly and must enforce the same authentication/authorization as requests through the Router. Do not use a spoofable forwarded Host header as an origin-access security boundary. Construct auth redirects only from configured public origin. Do not introduce OAC edge-signing/body-limit behavior as an untested default. A private origin is a later optional deployment profile with its own tests.

Handle Aurora's explicit `DatabaseResumingException` with bounded exponential backoff/jitter. Use a maximum 45-second database-readiness budget for deployment/HTTP and a maximum five-second resume retry budget inside the ten-second queue consumer, after which it throws for redelivery. Set HTTP Lambda timeout to 60 seconds and Router API `readTimeout` to `60 seconds`. Do not assume cold resume is always under 15 seconds. Retry ambiguous business-write failures only through an appropriate idempotency contract.

Local: Vite proxies `/api` to Wrangler, including the public origin needed by local auth. `npm run dev` starts both, applies pending local migrations, validates local configuration, and cleans up both owned processes when stopped. Application service bindings remain local and make no cloud service calls. `npm run build` produces both cloud bundles and web artifacts. `npm run deploy -- --target cloudflare|aws --stage NAME` runs preflight, infrastructure deployment, ordered migrations, and functional readiness, preserving failure exit status. `npm run remove` targets only the stage/resources created by this workflow.

Use stage-namespaced SQL/buckets/queues/secrets and test runs; do not assume deployment to the other cloud migrates data. “Same app” means source portability, not cross-cloud replication/failover. Declare known retained costs, teardown behavior, and credentials/OAuth setup in the README. Do not claim deployed cloud readiness without a real deployed check.

## 8. Checks and AI skill

`npm run check` performs strict TypeScript checking, type-aware framework lint, deterministic migration checking, application tests on local D1 and PGlite, both-target builds, example/template checks, and skill size/link checks. It has nonzero test counts and no network/account dependency for its normal local mode.

App rules ban platform/env/raw SQL/dialect/interactive transaction/relational APIs, require framework IDs and explicit order helpers, and require branded verified-webhook and idempotent-handler registration. Resolve aliases, re-exports, receivers, and dynamic imports; do not rely on identifier spelling. Allow insert-builder `.values()` and service `.get()`. App TypeScript cannot use `any`, unsafe assertions, suppression comments, or disabled rules to bypass portability. Generated entries/infrastructure/tooling have explicit narrow exemptions. Framework code remains linted/tested under a separate policy rather than universally exempt from correctness checks.

Do not promise that static analysis proves arbitrary control flow or email-based authorization. Use narrow typed registration/authorization APIs plus negative fixtures, functional tests, and review. Diagnostics specify the offending construct and the exact capability reference to read. Every rule has failing fixtures and realistic passing fixtures, including demo code.

Skill structure: L0 description; L1 router/hard rules; L2 references; L3 complete working examples; L4 scaffolder-applied templates. UTF-8 budgets: L1 max 8,000 bytes, each L2 max 12,000 bytes, each L3 max 20,000 bytes; keep below these maxima where possible. L1 links to L2, L2 to task-specific L3, L3 supplies L4 scaffold commands. Capability diagnostics may directly identify L2. Share cross-capability example composition through the router instead of forcing duplication. All examples compile and run in CI. Extract tested examples from the demo or exercise identical source.

App-development skill rules require platform-blind app code, pinned versions, verify/enqueue webhooks, canonical issuer/sub identity, and `npm run check` before completion. Limit reading to relevant references. An app agent writes a reproducible `FRAMEWORK-ISSUE.md` rather than bypassing framework contracts when it finds a framework defect. **These app-agent stop rules do not constrain the agent implementing this framework**; it must inspect and fix its own framework source to complete the implementation task.

The skill contains `SKILL.md`, `reference/`, `examples/`, `templates/`, and `scripts/scaffold`. Capability references cover HTTP, SQL, KV, files, queue/webhooks, auth, secrets, static site, local development, deploy, and testing. Its router maps adding an endpoint, storing data, handling a webhook, adding an admin page, testing, and deploying to the relevant reference. Each reference opens with “read this when” and ends with a clear stopping condition. The scaffolder refuses to overwrite user files without explicit overwrite authorization and generates code exercised by CI.

| Check | Contract |
| --- | --- |
| `no-platform-imports` | Platform modules, Drizzle dialects/drivers, and database clients are forbidden in shared application modules; framework exports are used instead. |
| `no-env-access` | Server application modules do not read `process.env`, bindings, or `import.meta.env`; service access and declared framework configuration replace them. |
| `no-raw-sql` | Low-level database execution and raw SQL are forbidden. Insert-builder `.values()` and KV/files/secrets `.get()` are allowed based on resolved receiver types. |
| `no-dialect-features` | Unsupported operators and nested builder methods are rejected, including through CTE builders and aliases. |
| `require-explicit-order` | Ordering uses framework `asc`/`desc`; paginated examples include a unique tie-breaker. |
| `no-transactions` | Application `.transaction()`/`.batch()` calls are forbidden; atomic writes use `atomic(db, writeSteps)`. |
| `no-relational-queries` | `db.query.*` is forbidden; supported joins/subqueries are used instead. |
| `ids-from-framework` | IDs come from `newId()` and id columns are immutable; auto-increment is forbidden. |
| `idempotent-consumers` | Registered handlers require the branded idempotent wrapper. |
| `webhook-verify-first` | Framework webhook registration accepts only verified/validated events before durable enqueue. |
| `no-email-authorization` | Supported authorization APIs use canonical issuer/sub identity; syntactic lint is supplemented by functional ownership/admin tests. |
| Migration checker | Portable DDL policy, paired logical schema equivalence, safe atomic rebuild pattern, checksums, and populated-data preservation are mandatory. |

`npm run check` is the definition of done for local application feature work. Framework releases additionally require the full cloud compliance matrix. Application deployment requires its target smoke check. A local application check is never reported as proof of cloud infrastructure behavior.

## 9. Demo: shared notes board

Use a small Vite/TypeScript SPA with board, editor, and admin page; no frontend framework is required. Notes have framework id, canonical author identity, plain-text title/body, draft/published state, and portable timestamps. Attachments reference notes and contain file key, original display name, content type, size, and status. Use explicit validation and safe text rendering.

Anonymous users list/read published notes and their approved attachments. Authenticated users create/edit their own drafts and preferences; uploads require a note owned by the caller. Admins publish/unpublish and delete any note, and set the site banner in KV. Deleting a note explicitly deletes attachment rows in an atomic unit with NO ACTION FKs; file cleanup is a separately replay-safe action with documented retry behavior. Do not promise SQL/files distributed atomicity.

Upload flow: authorized intent → generated object key under the note/owner namespace → short-lived PUT URL → upload → finalize endpoint verifies object existence/size/content type before creating a visible attachment. Authorization never derives from a caller-chosen object key. Approved downloads use short-lived GET URLs. The maximum accepted attachment is 10,000,000 bytes; enforce it before signing when size is declared and at finalization using actual object metadata, deleting/rejecting oversized objects. A presigned PUT alone is not assumed to enforce an upload-size cap. Allow `text/plain`, `image/png`, `image/jpeg`, and `application/pdf`; never render uploaded HTML as trusted content. MIME/content-type metadata is not proof of file safety, so render attachments as downloads rather than trusting their contents.

Webhook sample events create notes through the idempotent consumer; source namespace and event ID are explicit. The sender script implements exactly the timestamp/HMAC protocol above and demonstrates replay deduplication. Use a configured service author and create drafts by default for moderation. Demo uses SQL, KV, files, queue, secrets, all three auth levels, and one-origin web/API. Provide a smoke script on every target.

## 10. Acceptance and evidence

The highest-risk mandatory integration gates are transaction-bound atomic rollback; preserved-data local **and remote** D1 rebuild; real Data API query/result parity; Worker assets deployment; and browser presigned uploads with CORS. A failed gate must be diagnosed and resolved through a supported mechanism, not deferred into a claim of readiness.

The reference app and runner drive the same contract tests over local/Cloudflare/AWS HTTP and exercise SQL in-process against PGlite. Cloud tests use ephemeral authorized SST stages and always attempt teardown of resources created by the run. Preserve the original failing exit status if cleanup also fails, and record leftovers explicitly. Namespace records/objects/event keys by run ID. Give each asynchronous test a bounded timeout derived from retry/visibility configuration; default DLQ timeout is 600 seconds, not a short arbitrary HTTP timeout.

Required coverage includes:

- HTTP methods/routing/error schema; JSON 404 for unknown API; site/API origin; SPA deep links; no caching of auth/personal responses.
- Both initial and incremental migrations, checksums/ledgers, no-op rerun, concurrency exclusion, failure rollback, and populated parent/child row preservation.
- All allowed SQL grammar/column types, boundary values, defaults/nullability/constraints, joins/CTEs/upserts/RETURNING, empty aggregates, explicit null/text ordering, literal containsText edge cases, and atomic rollback through real Data API.
- KV exact prefix, pagination, overwrite, missing values, TTL edge cases and expiry in both get and list.
- Files binary round trip, metadata, overwrite/missing/delete, escaped keys, pagination across multiple pages, presigned GET/PUT, tampered/expired URL rejection, required headers, actual-browser allowed/rejected CORS origins.
- Secrets available/missing/malformed behavior, correct IAM/bindings, admin-list refresh/update behavior.
- Full fake-provider browser login, cookie attributes/clearing, PKCE/state/nonce/provider binding, wrong issuer/audience/azp/algorithm, expiry/tampering, bearer precedence, CSRF rejection, admin/ownership checks, and absence of mock/test auth in normal cloud artifacts.
- Real Google browser login/callback/logout with an authorized real client. If unavailable, mark this check blocked; never count the fake-provider test as its pass.
- Exact-body HMAC, malformed/stale/future signature inputs, invalid JSON, size limits, failed durable enqueue, and no enqueue on verification failure.
- Queue delivery, configured retry/DLQ observation via a dedicated test observer, partial batch success, delay bounds, UTF-8 oversize rejection, unsupported JSON rejection, and service context outside Hono.
- Sequential and concurrent idempotency duplicates, first-failure retry, event-key namespaces, mismatched payload conflict, and a non-marker uniqueness error that must not be acknowledged.
- Real Aurora auto-pause/resume, bounded retry and timeout behavior; consumer failure/redelivery during resume as applicable.
- Passing and failing lint/type fixtures, both target bundles, clean packed-package installation, scaffolded-app local check, and demo smoke on all three targets.

Store `validation/evidence.json` with run ID, commit/source hash, exact versions/configuration without secrets, timestamp, target, command, exit status, test counts, report/artifact paths, and status (`passed`, `failed`, `blocked`, `skipped`, `unrun`). Mark document/source-confirmed facts separately from executed behavior. A zero-test run, a listening port, and a deployed resource list do not establish capability correctness. Preserve checksums/TLS/signature verification throughout troubleshooting.

Finish with concise instructions and reports explaining what was delivered and which exact gates ran. Claim complete implementation only when all mandatory targets/checks pass with supporting artifacts. If a genuine external prerequisite blocks progress, finish independent work and name the prerequisite and affected gates. Do not suppress failures, weaken contracts, change assertions to accept broken behavior, or describe an untested fallback as working.

The user should not have to remember platform incompatibilities: absorb each into implementation, a clear documented rule, or an executable check. No important assumption may exist only in the implementer's memory or final chat message.

## Validation status and historical evidence

The following observations were obtained during the October 9 review and recorded in the conversation. They concern particular versions and mechanisms, not a completed framework. **The underlying downloaded sources, probe programs, raw outputs, and original artifact hashes were lost with the earlier workspace and have not been recovered.** This reconstruction preserves the recorded observations and source links; it does not manufacture replacement raw evidence. Reproduce the applicable checks and commit fresh evidence before treating them as release-validation passes.

| Observation | Recorded evidence and scope | Implementation status |
| --- | --- | --- |
| Listed dependency releases existed | npm registry metadata was checked during the review. | Combined toolchain/build compatibility must still pass. |
| SST Worker assets fields, Aurora Data API/0 ACU settings, NAT-disabled VPC, and SQS partial-response option exist | Pinned SST 4.17.2 source was inspected. | Deployed wiring and application behavior unrun. |
| R2 credential derivation and local S3 configuration are supported surfaces | Official Cloudflare documentation source, provider declarations, and Wrangler 4.149.0 config schema were inspected. | Token-creation privileges, signing, and cloud browser CORS unrun. |
| Local D1 table rebuild with NO ACTION preserved child rows in the recorded fixture | One atomic binding batch under Wrangler 4.149.0. | Other migration histories and remote execution must pass separately. |
| The blanket pragma rewrite is unsafe with CASCADE | The local D1 rebuild succeeded but deleted the referencing child; Node SQLite reproduced the loss. | CASCADE is excluded and the checker must reject it; the new migration runner still requires validation. |
| Ordinary-handle writes do not acquire a Data API transaction ID by being awaited in its callback | Drizzle 0.45.4 with a stub SDK client captured a missing transaction ID; a transaction-handle write carried it. No AWS requests were sent. | Factory-based execution and rollback must pass on real Data API. |
| Pinned drizzle-kit's remote D1 migration path is sequential | drizzle-kit 0.31.11 source executed each statement in a separate REST call. | That runner is excluded for rebuilds; the replacement atomic mechanism must be proven remotely. |
| SQLite and default Postgres text folding/range behavior differ | SQLite/PGlite probes showed accented-case folding differences and acceptance/rejection of 2147483648. C collation matched the recorded folding cases. | New helpers/value validation require full boundary and cloud tests. |
| Aurora resume may fail a request and require retry | Official AWS SDK service model documented `DatabaseResumingException`. | Real auto-pause/resume and timeout behavior unrun. |

### Recorded diagnostic outcomes

The conversation records these local results, not newly executed tests:

```text
Parent rebuild in one local D1 batch:
Foreign-key action       Rebuild succeeded     Child rows after rebuild
NO ACTION                yes                   1
CASCADE                  yes                   0
RESTRICT                 yes                   1

Data API command construction, using a stub SDK client:
Ordinary-handle query awaited inside transaction callback:
  ExecuteStatement transactionId = absent
Query constructed with the supplied transaction handle:
  ExecuteStatement transactionId = tx-probe

lower('ÉCOLE'):
  SQLite                   École
  default Postgres         école
  Postgres COLLATE "C"     École

integer value 2147483648:
  SQLite INTEGER           accepted
  Postgres integer         rejected
```

**Mandatory unrun gates:** real Data API operation/result parity and rollback; populated remote D1 rebuild and failure/ledger recovery; deployed Worker assets and AWS Router forwarding/caching; cloud IAM/secrets/R2 credential creation; real browser presign CORS/cookies; queue retry/DLQ/partial-batch behavior; real Aurora pause/resume; real Google browser sign-in/callback/logout; and the full demo/compliance matrix. All remain unrun until the implementation records actual results. Historical October 8 verification labels without checked-in reproductions do not count as passes.

**External prerequisites:** authorized AWS and Cloudflare accounts/stages, supported Aurora engine/region, required deployment/token permissions, secret values in secure configuration, and a real Google OAuth client with exact callback registrations. Missing values or authority are reported as concrete blockers after independent work is completed; they are never replaced by invented credentials or by marking a fake-provider check as real Google success.

**Sources:**

- [SST 4.17.2 Worker](https://github.com/sst/sst/blob/v4.17.2/platform/src/components/cloudflare/worker.ts), [Aurora](https://github.com/sst/sst/blob/v4.17.2/platform/src/components/aws/aurora.ts), [VPC](https://github.com/sst/sst/blob/v4.17.2/platform/src/components/aws/vpc.ts), [Queue](https://github.com/sst/sst/blob/v4.17.2/platform/src/components/aws/queue.ts), [Router](https://github.com/sst/sst/blob/v4.17.2/platform/src/components/aws/router.ts), and [provider pins](https://github.com/sst/sst/blob/v4.17.2/platform/package.json).
- Official Cloudflare documentation source for [D1 foreign keys](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/d1/sql-api/foreign-keys.mdx), [D1 batches](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/d1/worker-api/d1-database.mdx), [Queue limits](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/queues/platform/limits.mdx), [local Queues](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/queues/configuration/local-development.mdx), and [R2 authentication](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/r2/api/tokens.mdx).
- Official AWS SDK service models for [Data API](https://github.com/aws/aws-sdk-js-v3/blob/main/codegen/sdk-codegen/aws-models/rds-data.json) and [SQS](https://github.com/aws/aws-sdk-js-v3/blob/main/codegen/sdk-codegen/aws-models/sqs.json).
- Published [Drizzle ORM 0.45.4](https://www.npmjs.com/package/drizzle-orm/v/0.45.4), [drizzle-kit 0.31.11](https://www.npmjs.com/package/drizzle-kit/v/0.31.11), and [Wrangler 4.149.0](https://www.npmjs.com/package/wrangler/v/4.149.0); package contents were inspected and selected local probes executed during the original review.

Mutable documentation/source links are references, not replacements for versioned captured evidence. Publication, a new environment/task, or a framework release requires its own recorded validation. No framework implementation, cloud deployment, or new platform validation occurred during this document reconstruction.

## Known limits and path to production

The ongoing risks are the dual-dialect API/type layer, the experimental local R2 S3 endpoint, SST's internal Worker assets surface, pinned-provider changes, nonidentical queue scheduling, and Aurora cold resume. Pins, negative fixtures, and a real three-target test matrix contain these risks; they do not eliminate them without execution. Stateless sessions remain valid until expiry/key removal even after logout; AWS admin-list updates can be delayed by the declared secret cache, and Worker-secret updates require deployment/configuration propagation.

Production additions include backups/PITR, operational migration policies, database-backed roles and revocable sessions, audit history, structured observability/DLQ alerts, rate limiting, dependency scanning, and CI-managed ephemeral stages. Input validation, CSRF, token validation, controlled key rotation, and safe deployment gates are already part of v0.1 correctness. A production app may graduate to one target and a broader SQL surface through a separate explicit decision; dual-cloud development remains mandatory for this framework.
