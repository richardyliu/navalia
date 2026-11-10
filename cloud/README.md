# Persome Cloud (Phase 0 + Chat + Cards + Letters + Meetings + Moments)

Opt-in cloud service for Navalia. **Lens works fully without it**; every cloud
feature is off by default and the user turns it on explicitly. Implemented: device-key
authentication and sessions (Phase 0), the Chat proxy (`POST /v1/chat/completions`, C4), friend-card relay (C8)
weekly-letter email subscriptions with an SMTP outbox (C9), and meeting transcription (audio chunk upload →
Soniox / mock speech-to-text → transcript, C13), the shared-moments relay (two-party signed, C18) and the
`workflow_extract` chat task (C15). Architecture, threat model and roadmap:
[`../docs/design/S1-FULL-ARCH.md`](../docs/design/S1-FULL-ARCH.md).

- Node 24 (`node:http`, `node:sqlite`, `node:crypto`). **One runtime dependency: `nodemailer` 10.2.1** (exact pin,
  zero transitive deps, `package-lock.json`). Why: hand-rolling SMTP (STARTTLS, AUTH, dot-stuffing) and MIME
  (RFC 2047 UTF-8 headers, multipart/alternative, folding, header-injection safety) is error-prone; nodemailer is
  the standard. Run `npm ci` in `cloud/` before `npm start` / `npm test`.
- Sources are TypeScript run directly via Node's type stripping (erasable syntax only; no build step).

## Run

```sh
cd cloud
npm ci
CLOUD_PUBLIC_ORIGIN=http://localhost:8787 npm start
# dev mail: CLOUD_MAIL_MODE=outbox CLOUD_MAIL_FROM=letters@localhost.test CLOUD_MAIL_OUTBOX_DIR=./data/outbox
curl -s localhost:8787/health
```

Docker:

```sh
docker build -t persome-cloud ./cloud
docker run --rm -p 8787:8787 -v persome-cloud-data:/data \
  -e CLOUD_PUBLIC_ORIGIN=https://cloud.example.com -e CLOUD_TRUST_PROXY=1 persome-cloud
```

The image runs as the unprivileged `node` user, stores the DB at `/data/cloud.db` (volume),
and must sit behind a TLS-terminating reverse proxy in production.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port (`0` = ephemeral) |
| `CLOUD_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `CLOUD_DB_PATH` | `./data/cloud.db` (`/data/cloud.db` in Docker) | SQLite file (created 0600, dir 0700) |
| `CLOUD_PUBLIC_ORIGIN` | `http://localhost:$PORT` | Auth **audience**: exact public origin clients connect to. Bare origin, no path. Set it in every non-local deployment |
| `CLOUD_TOKEN_TTL_S` | `2592000` (30 d) | Bearer token lifetime |
| `CLOUD_BODY_LIMIT_BYTES` | `65536` | Max request body → `413` |
| `CLOUD_RATE_WINDOW_S` | `60` | Fixed rate-limit window |
| `CLOUD_RATE_IP_MAX` | `120` | Requests per IP per window → `429` |
| `CLOUD_RATE_ACCOUNT_MAX` | `300` | Requests per account (key fingerprint) per window → `429` |
| `CLOUD_TRUST_PROXY` | off | `1` = client IP is the right-most `X-Forwarded-For` entry. Enable only behind your own proxy |
| `CLOUD_LLM_MODE` | unset | `openai` \| `mock` \| unset. Unset = chat disabled (`503 llm_unavailable`). `mock` = deterministic, no network (tests / E2E) |
| `CLOUD_LLM_BASE_URL` | – | openai mode, required. OpenAI-compatible base, e.g. `https://api.openai.com/v1` (server POSTs `${base}/chat/completions`) |
| `CLOUD_LLM_API_KEY` | empty | openai mode. Sent only as the upstream `Authorization: Bearer`; never logged or returned. Empty = no header (local servers) |
| `CLOUD_LLM_MODEL` | – (`mock` in mock mode) | openai mode, required. Clients cannot choose the model |
| `CLOUD_LLM_TIMEOUT_MS` | `60000` | Idle timeout: max wait for upstream headers and between upstream chunks |
| `CLOUD_LLM_MAX_TOKENS` | `1500` | `max_tokens` sent upstream |
| `CLOUD_CHAT_DAILY_TOKENS` | `200000` | Per-account daily budget (prompt + completion, UTC day) → `429 quota_exceeded` |
| `CLOUD_MAIL_MODE` | unset | `smtp` \| `outbox` \| unset. Unset = letters still accepted, deliveries stay `queued` with `error_code: "mail_disabled"` (expire to `failed`/`expired` after 7 d); subscribe returns 202 but sends/stores nothing |
| `CLOUD_MAIL_FROM` | – | smtp/outbox, required. Bare address (`letters@example.com`); the display name is the publisher's card `display_name` (fallback `Persome 周信`) |
| `CLOUD_MAIL_OUTBOX_DIR` | – | outbox mode, required. Writes one `.eml` per mail (dir 0700, files 0600). Dev only: files contain recipient addresses |
| `CLOUD_SMTP_HOST` / `CLOUD_SMTP_PORT` | – / `587` (`465` if secure) | smtp mode relay |
| `CLOUD_SMTP_SECURE` | off | `1` = implicit TLS. Off = STARTTLS **required** (except to a loopback host) |
| `CLOUD_SMTP_USER` / `CLOUD_SMTP_PASS` | empty | AUTH credentials, set both or neither. Never logged |
| `CLOUD_EMAIL_PEPPER` | generated, stored in DB | ≥ 32 chars. HMAC key for suppression hashes and unsubscribe tokens. **Set it in production** (otherwise a DB leak alone allows brute-forcing hashed addresses). Rotating it invalidates every unsubscribe link already sent and every suppression |
| `CLOUD_CARD_FETCH_MAX` | `60` | `GET /v1/cards/:fp` + `GET /v1/letters/by/:fp` per account per rate window → `429` |
| `CLOUD_SUBSCRIBE_IP_PER_HOUR` | `10` | `POST /v1/subscribe` + `/v1/resubscribe` per client IP per hour |
| `CLOUD_SUBSCRIBE_PUBLISHER_PER_HOUR` | `50` | `POST /v1/subscribe` per publisher per hour |
| `CLOUD_STT_MODE` | unset | `soniox` \| `mock` \| unset. Unset = meetings disabled (`503 stt_unavailable`). `mock` = deterministic, no audio decoding, no network |
| `CLOUD_SONIOX_API_KEY` | – | soniox mode, required. Sent only as `Authorization: Bearer` to Soniox; never logged, never in errors or responses |
| `CLOUD_SONIOX_BASE_URL` | `https://api.soniox.com` | soniox mode. Server calls `${base}/v1/files`, `${base}/v1/transcriptions…` |
| `CLOUD_SONIOX_MODEL` | `stt-async-v6` | soniox mode. Async model name (per Soniox docs, 2026-11-05) |
| `CLOUD_STT_POLL_MS` / `CLOUD_STT_TIMEOUT_MS` | `1000` / `180000` | soniox mode: status poll interval; max wall time per chunk (then transient `stt_timeout`) |
| `CLOUD_STT_CONCURRENCY` | `2` | Chunks transcribed in parallel |
| `CLOUD_STT_DAILY_SECONDS` | `7200` | Per-account daily audio budget (UTC day), counted when a chunk is accepted → `429 quota_exceeded` |
| `CLOUD_AUDIO_DIR` | `./data/audio` (`/data/audio` in Docker) | Uploaded chunks (dir 0700, files 0600, random hex names) |
| `CLOUD_MEETING_CHUNK_RATE_MAX` | `30` | Chunk PUTs per account per rate window → `429 rate_limited` |

## API (Phase 0)

Errors are always `{"error":{"code":"<snake_case>","message":"<safe text>"}}`.

| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| GET | `/health` | – | `200 {ok, version}` | |
| POST | `/v1/auth/challenge` | – | `200 {challenge_id, nonce, audience, expires_at}` (TTL 300 s) | `400 invalid_public_key` |
| POST | `/v1/auth/verify` | – | `200 {token, token_type:"Bearer", expires_at, account_id}` | `401 challenge_invalid`, `403 signature_invalid` |
| GET | `/v1/auth/session` | Bearer | `200 {account_id, fingerprint, expires_at}` | `401 unauthorized` |
| POST | `/v1/auth/logout` | Bearer | `204` (token revoked) | `401 unauthorized` |
| DELETE | `/v1/account` | Bearer | `204` (account + all rows deleted) | `401 unauthorized` |
| POST | `/v1/chat/completions` | Bearer | `200 text/event-stream` (see below) | `400 invalid_request`, `413` (> 256 KiB), `429 rate_limited` / `quota_exceeded`, `502 upstream_error` / `upstream_timeout`, `503 llm_unavailable` |
| GET | `/v1/usage` | Bearer | `200 {day, prompt_tokens, completion_tokens, limit}` (UTC day) | `401 unauthorized` |
| POST / GET | `/v1/moments` | Bearer | see **Shared moments (C18)** | |
| POST / DELETE | `/v1/moments/:id/accept`, `/:id/decline`, `/v1/moments/:id` | Bearer | see **Shared moments (C18)** | |
| PUT | `/v1/cards` | Bearer | `200 {fingerprint, version, published_at, unchanged}` | `400 card_invalid` / `invalid_request`, `403 card_not_owner`, `413` (card text > 64 KiB) |
| GET | `/v1/cards/:fingerprint` | Bearer | `200 {card, version, published_at}` (card text verbatim) | `400 invalid_request` (not `^[0-9a-f]{64}$`), `404 not_found`, `429` |
| DELETE | `/v1/cards` | Bearer | `204` (all versions) | |
| POST | `/v1/letters` | Bearer | `202 {letter_id, issue_id, recipients}` | `400 letter_invalid`, `403 letter_not_owner`, `409 duplicate_issue`, `413` (envelope > 512 KiB / body > 1 MiB), `429 rate_limited` (> 10 letters / 24 h) |
| GET | `/v1/letters` | Bearer | `200 [{letter_id, issue_id, week, title, created_at, counts:{queued,sent,failed,suppressed}}]` (newest first) | |
| GET | `/v1/letters/:letter_id/deliveries` | Bearer (owner) | `200 [{subscriber_id, email_masked, status, attempts, updated_at, error_code}]` | `404 not_found` (also for other owners) |
| GET | `/v1/letters/by/:fingerprint` | Bearer | `200 [{letter, published_at}]` latest ≤ 12 whose body is still retained | `400`, `429` |
| GET | `/v1/subscribers` | Bearer | `200 [{subscriber_id, email_masked, status, created_at, confirmed_at}]` | |
| DELETE | `/v1/subscribers/:id` | Bearer (owner) | `204` (row + address deleted, suppressed for this publisher) | `404 not_found` |
| POST | `/v1/subscribe` | – | JSON `{publisher, email}` → `202 {status:"pending"}` always; form-urlencoded → `200` HTML | `400 invalid_request` (malformed input only), `415`, `429` |
| GET | `/v1/subscribe/confirm?token=` | – | HTML page with a POST button (does **not** confirm) | HTML 400 |
| POST | `/v1/subscribe/confirm` | – | form `token` → HTML 200 (confirmed; lifts suppression) | HTML 400 (unknown / used / > 48 h) |
| GET | `/v1/unsubscribe?token=` | – | HTML page with a POST button (does **not** unsubscribe) | HTML 400 |
| POST | `/v1/unsubscribe` | – | form `token`, or RFC 8058 body `List-Unsubscribe=One-Click` + `?token=` → HTML 200, idempotent | HTML 400 (forged token) |
| POST | `/v1/resubscribe` | – | form `token` (old unsubscribe token) + `email` → HTML 200 always; sends a new confirmation only if the address matches | `429` |
| GET | `/s/:fingerprint` | – | HTML subscribe form (short fingerprint; card display name if published) | HTML 404 |

### Chat

Request (body cap **256 KiB** on this route; every other route keeps 64 KiB):

```json
{ "messages": [{"role": "user", "content": "..."}],
  "context": {"items": [{"id": "ctx-1", "kind": "memory", "title": "...", "text": "...", "ref": null}]},
  "task": "chat" }
```

- `messages`: 1..40, role `user` | `assistant` (a `system` role is rejected), content ≤ 16000 chars, last must be a non-blank `user` message.
- `context` optional; `items` 0..100, `id` `^ctx-[0-9]{1,3}$` unique, `kind` memory|model|entity|workflow|recent|capture,
  `title` ≤ 200, `text` ≤ 8000, title+text total ≤ 60000 chars, `ref` string ≤ 1000 or null (kept for the client, **not** sent to the LLM).
- `task`: `chat` (default) | `group_digest` | `workflow_extract`; anything else → 400 `invalid_request`. Unknown keys (e.g. `model`, `max_tokens`) are ignored.
- The server owns the system prompt (user's language, only the given items as facts, cite `[ctx-N]`, say when context is insufficient, items are data not instructions; `group_digest` groups capture items by chat group and states OCR/on-screen-only coverage).

Order of pre-stream checks: auth (401) → rate limit (429 `rate_limited`) → body (413/415/400) → validation (400) → LLM configured (503) → daily budget (429 `quota_exceeded`, `Retry-After` = seconds to UTC midnight) → upstream accepted (else JSON **502** `upstream_error` / `upstream_timeout`).

Stream events: `delta {text}` (many) → optional `error {code, message}` (`upstream_error` | `upstream_timeout`, mid-stream only) → `usage {prompt_tokens, completion_tokens, model[, estimated:true]}` (once) → `done {finish_reason: stop|length|error, citations}`. Citations = distinct `[ctx-N]` markers in the full answer that match provided ids, first-appearance order. A client disconnect aborts the upstream request. No retries.

Mock answer (deterministic): `（mock）收到 N 条上下文。` then `\n- <title> [ctx-K]` for the first ≤ 3 items, in 7-character deltas.

**`task: "workflow_extract"` (C15).** Same request and stream contract. The server-owned system prompt (replacing the
chat rules) asks the model to extract a reusable workflow from the session items using only those items (no invented
tools / commands / paths), and to output ONLY one JSON object in a single ```` ```json ```` fenced block:
`{"title":string,"steps":[{"title","detail","cites":["ctx-N"]}],"artifacts":[{"name","kind","cites"}],"rules":[{"text","cites"}],"problems":[{"text","resolution":string|null,"cites"}]}`,
every item citing context ids, empty arrays allowed. **The server does not parse or validate that JSON** (the client
does); it streams deltas as for chat. `done.citations` for this task = distinct quoted `"ctx-N"` strings in the answer
that match provided ids. Mock: a ```` ```json ```` block with `title` `（mock）工作流：<first title>`, one step per
first ≤ 3 items (`title` = item title, `detail` = item text on one line ≤ 200 chars, `cites` = [that id]), empty
`artifacts` / `rules` / `problems`, in 7-character deltas. Quota / `chat_usage` accounting is unchanged.

### Cards (C8)

`PUT /v1/cards` body `{"card": "<.navaliacard file text>"}` (route body cap 256 KiB; the card text itself ≤ 64 KiB UTF-8).
The server verifies exactly like Lens `verifyCardText` (`src/signed.ts` re-implements the zod schema and RFC 8785
canonicalization; signature = Ed25519 over canonical JSON of `card`, no prefix), then requires the signer fingerprint
to equal the account. Identical text to the latest version → `unchanged: true`, no new version. ≤ 20 versions kept;
version numbers are monotonic per account, also across `DELETE /v1/cards`. Text is stored and served verbatim;
**clients must re-verify offline**. `verifyCardText` / `verifyLetterText` are pure exports for cross-package tests.

### Letters + subscriptions (C9)

Envelope (`POST /v1/letters` body `{"letter": "<envelope JSON text>"}`):
`{version:1, kind:"persome-letter", issue_id:<lowercase uuid>, week:"YYYY-Www", title (1..200, no control chars), markdown (1..100000), created_at (ISO with offset), signer:{public_key, fingerprint}, signature}`;
signature = Ed25519 over `"persome-letter-v1\n" + canonical JSON(envelope minus signature)`. One delivery row per
*confirmed* subscriber. The outbox worker (`src/outbox.ts`, DB-backed) sends with ≤ 4 in flight, ≤ 3 attempts,
backoff 1 min then 5 min; SMTP 5xx and header-unsafe mails fail at once (`smtp_rejected` / `header_unsafe`),
4xx → `smtp_temporary`, connection errors → `smtp_unavailable`. Other `error_code`s: `mail_disabled`, `unsubscribed`,
`removed`, `expired`.

Mail: `multipart/alternative` (the markdown as plain text + escaped paragraph-only HTML), `Subject` = title,
`From` = `"<card display name>" <CLOUD_MAIL_FROM>`, no Reply-To, `List-Unsubscribe: <origin/v1/unsubscribe?token=…>`
+ `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. **No tracking**: no images, no rewritten links, no open/click
counting; the unsubscribe link is the only per-recipient URL. Footer: "你在 <origin> 订阅了…" + unsubscribe link.

Subscribers: double opt-in (confirmation token 48 h, sha256 stored; raw token kept only until handed to the
transport). ≤ 3 confirmation mails per address per 24 h (across publishers); per-IP and per-publisher limits;
≤ 10 000 subscribers per publisher. Unsubscribe deletes the subscriber row (raw address) and stores only
`HMAC-SHA256(pepper, lowercased address)` in `suppressions`. A suppressed address gets no letters and no
confirmation mail from `/v1/subscribe`; it can come back only through `/v1/resubscribe` (old unsubscribe link +
the same address → new confirmation mail), and confirming lifts the suppression. Unsubscribe tokens are
`<subscriber_id>.<HMAC>` (derived, not stored).

HTML pages: no JS, no external resources, CSP `default-src 'none'; style-src 'sha256-…'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, every value escaped, Chinese copy.

Retention (GC every 10 min): queued deliveries → `failed/expired` after 7 d; letter body (`envelope`) deleted 30 d
after the last delivery became terminal (metadata kept; it then disappears from `/v1/letters/by`); terminal delivery
rows deleted after 90 d; never-confirmed subscribers deleted when the token expires; per-address send counters after 24 h.
`DELETE /v1/account` cascades cards, letters, deliveries, subscribers (raw addresses), suppressions, confirmation queue.

### Shared moments (C18)

A moment is something two Lens identities both confirm happened together. Nothing is inferred by the server (or by
Lens) from either person's memory: a moment exists only when one participant proposes it (signed) and the other
accepts it (signed). The server is a relay: it verifies on write, stores the signed texts verbatim, and serves them
verbatim; **clients must re-verify** (`verifyMomentText(text)` / `verifyAcceptanceText(text, momentText)` in
`src/signed.ts` are pure exports for cross-package tests).

Moment (JSON text, signed by the proposer; strict keys):
`{"version":1,"kind":"persome-moment","moment_id":"<lowercase uuid>","title":"1..200, non-blank single line","note":"0..4000","occurred_on":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"} (start ≤ end, real dates),"place":"0..200"|null,"participants":["<fp>","<fp>"] (exactly 2, distinct, sorted ascending; proposer ∈ participants),"visibility":"private"|"letters","proposer":{"public_key":"<b64url 32B>","fingerprint":"<hex64 = sha256(key)>"},"created_at":"ISO datetime","signature":"<b64url 64B>"}`.
Signature = Ed25519 over UTF-8 `persome-moment-v1\n` + RFC 8785 canonical JSON of the moment without `signature`.

Acceptance (signed by the other participant):
`{"version":1,"kind":"persome-moment-accept","moment_id","moment_sha256":"<hex sha256 of the canonical JSON of the full signed moment incl. signature>","accepter":{"public_key","fingerprint"},"accepted_at":"ISO","signature"}`,
signature over `persome-moment-accept-v1\n` + canonical(acceptance without `signature`). `visibility:"letters"` (both
may mention it in weekly letters) is covered by both signatures (the acceptance binds the moment's sha256).

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST /v1/moments` | `{"moment":"<text>"}` | `201 {"moment_id","status":"pending"}` | `400 moment_invalid` (parse / schema / fingerprint / signature), `403 moment_not_owner` (signer ≠ account, or proposer ∉ participants), `409 duplicate_moment`, `429 rate_limited` (≥ 50 pending as proposer, or 20 proposals per UTC day — deletes do not refund) |
| `GET /v1/moments` | – | `200 [{moment_id,status:"pending"\|"accepted"\|"declined",moment,acceptance\|null,updated_at}]` where the account is a participant, ≤ 500, newest `updated_at` first | |
| `POST /v1/moments/:id/accept` | `{"acceptance":"<text>"}` | `200 {"status":"accepted"}` | `404 not_found`, `403 moment_not_owner` (the proposer), `403 not_participant` (third party), `409 moment_not_pending`, `400 acceptance_invalid` (does not verify / wrong moment_id / wrong moment_sha256 / not signed by the other participant) |
| `POST /v1/moments/:id/decline` | – | `200 {"status":"declined"}` | as accept (no 400) |
| `DELETE /v1/moments/:id` | – | `204`, deleted for **both** (either person can withdraw consent) | `404 not_found` (also for non-participants: no existence leak) |

Body cap 64 KiB. The other participant needs no account to be proposed to (they see it after their first login).
`DELETE /v1/account` deletes moments where the account is the proposer (FK cascade) **and** where it is the other
participant (trigger), plus the daily counter. Declined moments stay until either side deletes them. Request logs
carry only the route template (no ids, titles, notes, places). Known leak: `accept` / `decline` by a third party
returns `403 not_participant` (fixed contract), which reveals that the id exists; ids are random UUIDs.

### Meetings (C13)

All routes need `Authorization: Bearer`. Every meeting belongs to one account; another account's id → `404`.

| Route | Body | Success |
|---|---|---|
| `POST /v1/meetings` | `{"title": "1..200 chars, single line", "consent": {"version": 1, "participants_informed": true}, "language_hints"?: ["zh","en"] (≤ 4, ^[a-z]{2}$)}` | `201 {"meeting_id","status":"recording","max_chunks":240,"chunk_max_bytes":4194304,"chunk_max_ms":35000}` |
| `PUT /v1/meetings/:id/chunks/:seq` | raw audio; `Content-Type` `audio/webm` \| `audio/ogg` \| `audio/wav` (params allowed); `X-Chunk-Duration-Ms` 1..35000; `X-Chunk-Sha256` hex | `202 {"seq","status":"queued"}`; same seq + same sha → `200 {"seq","status":<current>}` |
| `POST /v1/meetings/:id/finish` | `{"chunks": n}` | `202 {"status":"transcribing"}` (a retry with the same n after finish → `202 {"status":<current>}`) |
| `GET /v1/meetings` | – | `[{meeting_id,title,status,created_at,duration_ms}]`, newest first |
| `GET /v1/meetings/:id` | – | `{meeting_id,title,status,created_at,duration_ms,chunks:[{seq,status,duration_ms}],error_code}` |
| `GET /v1/meetings/:id/transcript` | – | `{"meeting_id","language","segments":[{"start_ms","end_ms","speaker","text"}],"text"}` |
| `DELETE /v1/meetings/:id` | – | `204` (audio files, chunks, transcript, row); then `404` |

Errors: `400 consent_required`, `400 invalid_request` (title / hints / seq 0..239 / headers / empty body / n),
`400 checksum_mismatch`, `413 payload_too_large` (> 4 MiB; bodies up to 8 MiB are read and discarded first so the
client sees the 413), `415 unsupported_media_type`, `409 chunk_conflict` (same seq, different sha),
`409 meeting_closed` (new chunk or different n after finish), `409 chunks_missing` (+ `"missing":[seq…]` inside
`error`), `409 chunks_mismatch` (seqs ≥ n were uploaded), `409 not_ready` (transcript before `ready`),
`429 quota_exceeded` (+ `Retry-After` to UTC midnight; create when today's budget is used up, chunk when its duration
would exceed it), `429 rate_limited`, `503 stt_unavailable`.

Status: meeting `recording → transcribing → ready | failed`; chunk `queued → transcribing → done | failed`.
Chunks are transcribed as they arrive (not only after finish). Worker (`src/meetings.ts` `SttWorker`, DB-backed like
the mail outbox): ≤ `CLOUD_STT_CONCURRENCY` in flight, ≤ 2 attempts, retry after 30 s, permanent errors fail at once.
When the meeting is finished and every chunk is terminal it is assembled: any failed chunk → meeting `failed` with
that chunk's `error_code` (`stt_failed`, `stt_auth`, `stt_quota`, `stt_rejected`, `stt_unavailable`, `stt_timeout`,
`stt_bad_response`, `audio_expired`, `audio_missing`); else `ready`. Segment times are absolute within the meeting
(chunk offset = sum of the previous chunks' declared durations). `language` = most frequent detected language or
`null`. Overall `text` = segment texts joined with `\n`.

Mock: one segment per chunk, `（mock 转写）第 ${seq+1} 段，${round(ms/1000)} 秒`, speaker `S1`, language `null`.

Soniox (async REST API, docs read 2026-11-05 — see `src/stt.ts` header): per chunk `POST /v1/files` (multipart
field `file`, filename `chunk.<ext>`, never the title) → `POST /v1/transcriptions` `{model, file_id, language_hints?,
enable_speaker_diarization:true, enable_language_identification:true}` → poll `GET /v1/transcriptions/{id}` until
`completed` / `error` → `GET /v1/transcriptions/{id}/transcript` (tokens → segments: new segment on speaker change or
> 2 s gap; Soniox speaker `"1"` → `"S1"`) → `DELETE /v1/transcriptions/{id}` + `DELETE /v1/files/{id}` (always, best
effort). 401/403 → `stt_auth`, 402 → `stt_quota`, other 4xx → `stt_rejected`, status `error` → `stt_failed` (all
permanent); 429/5xx/network → `stt_unavailable`, timeout → `stt_timeout` (retried once). **Verified only against an
in-test fake server modelled on the docs; not run against real Soniox (needs a key).** Speaker labels are per chunk:
`S1` in chunk 3 is not necessarily `S1` in chunk 4.

Retention: a chunk's audio file is deleted as soon as it is transcribed or fails terminally; the GC (every 10 min)
deletes any audio older than 24 h (pending chunks become `failed`/`audio_expired`) and any file in `CLOUD_AUDIO_DIR`
with a 32-hex name the DB does not reference. Per-chunk results are dropped when the transcript is assembled. The whole
meeting (title + transcript) is deleted 7 d after it became `ready`/`failed`, or 7 d after creation if it never got
there; it then 404s (there is no `expired` status). `stt_usage` (per account per day, ms) survives meeting deletion
(deleting does not refund budget) and is pruned after 2 days. `DELETE /v1/account` deletes the audio files and
cascades meetings, chunks and usage.

Common: `404 not_found` (unknown method+path), `413 payload_too_large`, `415 unsupported_media_type`,
`400 invalid_json` / `invalid_request`, `429 rate_limited` (+ `Retry-After` seconds), `500 internal_error`.

Signed message for verify (UTF-8, `\n` separators, no trailing newline):

```
persome-cloud-auth-v1\n<audience>\n<challenge_id>\n<nonce>\n<fingerprint>
```

`fingerprint` = lowercase hex SHA-256 of the raw 32-byte Ed25519 public key = `account_id`.

## Test

```sh
cd cloud && npm ci && npm test   # node --test, temp SQLite per test, port 0, fake SMTP / fake Soniox on 127.0.0.1, no other network
npm run typecheck           # optional; uses the root project's TypeScript
```

The root project's vitest (`tests/**/*.test.ts`) and tsconfigs (`src/**`) do not include `cloud/`,
and electron-builder only packages `out/**`, so nothing here ships inside the Lens app.

## Security notes

- Private keys never leave the device; the server only sees public keys and signatures.
- Tokens: 32 random bytes, base64url. Only `sha256(token)` is stored. Logout deletes the row.
- Challenges are single-use: consumed atomically on **any** verify attempt; 300 s TTL; bound to
  audience + key fingerprint, so a signature cannot be replayed against another server or key.
- Request log = exactly `{req_id, method, route, status, ms}`; route is the template, never the raw
  path or query. No headers, bodies, tokens, keys, IPs or account ids are logged.
- No CORS headers: browsers cannot call the API cross-origin with credentials. Clients are the Lens
  main process, not web pages.
- Chat: messages, context and answers exist only in request memory. `chat_usage` stores counters only
  (day, ts, tokens, model, status, latency). Token budget is checked before each request, so concurrent or
  long requests can overshoot it by at most one request's worth per in-flight call.
- `DELETE /v1/account` cascades through every per-account table (`ON DELETE CASCADE` is mandatory
  for new tables, see `src/migrations.ts`).
- Rate limiting is in-memory and per process; a multi-instance deployment needs a shared limiter.
- `node:sqlite` is still flagged experimental in Node 24 (the Docker CMD silences the warning).
- C18: moment titles / notes / places are never logged or copied out of the signed text (tested).
- C9: email addresses, letter text and tokens are never logged (tested by capturing the log sink and stdout/stderr).
  Route templates (`/v1/cards/:fingerprint`) are logged, never raw paths. The operator can read subscriber
  addresses and letter bodies in the DB (not E2EE).
- C13: audio, titles, transcript text and the Soniox key are never logged (tested by capturing the log sink and
  stdout/stderr). Audio and transcripts are readable by the operator while stored (not E2EE) and are sent to Soniox
  (third party) in soniox mode; the server requests deletion at Soniox after every chunk. Daily audio budget and the
  chunk-PUT rate limit bound the STT cost per account.
- Real SMTP delivery has only been tested against an in-test fake SMTP server; inbox placement (SPF/DKIM/DMARC
  of `CLOUD_MAIL_FROM`'s domain) is a deployment task. nodemailer does not DKIM-sign here.
