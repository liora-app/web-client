# Liora API contract for the browser chat client at /chat/ (collected 2026-10-07, read-only)

Roots: S = C:\Users\s1ron\Desktop\ai-psychology\server, D = ...\devops, W = ...\web-client.
Every fact has a file:line in the original research; re-check a line before relying on it in code.
Installed: fastapi 0.142.2, starlette 1.7.0, uvicorn 0.54.0.

## Key gotchas
- No session endpoint: the CLIENT keeps the transcript and sends the whole history every turn.
- No timezone field on a turn (extra="forbid" -> 422 if sent).
- `Content-Type: application/json` required on every JSON POST/PATCH (FastAPI strict_content_type); text/plain -> 422.
- CSRF = Origin header only (default fetch mode 'cors', credentials same-origin). Native <form> POST / mode same-origin|no-cors -> `Origin: null` under Referrer-Policy no-referrer -> 403 csrf_failed.
- Crisis `helplines.notes` contains "7333" (S\app\safety\helplines.json:9). Never render/stringify the whole object; whitelist message, emergency, lines, abroad.
- Local cookie name `liora_session` (http), prod `__Host-liora_session` (https).
- Nothing serves /chat/ yet; W vite builds only index.html.

## 1. Routes under /api/v1
Global: routers S\app\main.py:167-175; openapi at /api/v1/openapi.json + /api/v1/docs in non-prod only (main.py:155-163). Bodies extra="forbid" (schemas.py:60-61). Auth: `Authorization: Bearer` wins, invalid bearer = 401 no cookie fallback; else session cookie (auth/deps.py:52-78). CSRF only for cookie-auth POST/PUT/PATCH/DELETE (deps.py:28,74-75). Consent gate require_consents checks required consents; no email allowlist (ADR-008, 2026-10-08). Order: malformed JSON 422 json_invalid first; then dependencies (auth, CSRF, consents) before schema 422. 413 middleware runs first (limits.py:16-55). Every response: X-Request-ID, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, Cache-Control no-store unless set. CORS only if CORS_ORIGINS set; prod is same-origin.

Meta (public):
- GET /healthz -> 200 {"status":"ok","db":"ok"} | 503 {"status":"degraded","db":"down"} (NOT the error envelope).
- GET /scenarios -> ScenarioOut[] {id,title,description,opening_message,needs_summaries}. ids "free"|"situation"|"day"|"revisit" in that order. free «Вільна розмова» / «Про що вам хочеться поговорити сьогодні?»; situation «Розбір ситуації» / «Опишіть ситуацію, яка вас зачепила: що сталося?»; day «Розбір дня» / «Як минув ваш день? Що з нього запамʼяталося найбільше?»; revisit «Повернення до теми» / «До цієї теми ви вже поверталися. Що змінилося відтоді?» needs_summaries=true. Whether to send opening_message back as first assistant message: not specified (schema allows; only the last must be user).
- GET /helplines -> raw helplines.json (same shape as crisis payload).

Auth (/auth):
- GET /auth/google/start?next=<path> — top-level navigation only. 302 to Google (openid email, PKCE S256, state, nonce, prompt=select_account), sets `liora_oauth`. Not configured -> currently 503 JSON {"error":{"code":"auth_unavailable",...}} (auth.py:86-87) — PLANNED server change: redirect to the web app with `auth_error=auth_unavailable`.
- GET /auth/google/callback (not in spec) -> always 302 to the web app.
- POST /auth/google/mobile {id_token} — mobile only.
- POST /auth/dev — only APP_ENV dev|test AND AUTH_DEV_LOGIN=true, and only hostname localhost|127.0.0.1|testserver. Body {email (lowercased, <=320, regex ^[^@\s\x00]+@[^@\s\x00]+\.[^@\s\x00]+$), client:"web"|"mobile" default web} -> 200 AuthTokenOut{token,expires_at,user:{id,email,created_at}}; web sets the cookie. No CSRF; consent gates still apply to protected actions.
- POST /auth/logout -> always 204 idempotent; clears cookie if sent; live cookie + bad Origin -> 403 csrf_failed.

Account/consent:
- GET /me -> MeOut{id,email,created_at,consents_ok:bool}.
- DELETE /me (auth+CSRF) -> 204, full erasure, cookie cleared, repeat = 204.
- GET /consents -> ConsentState{current_policy_version, required (all 3 kinds), granted:[{kind,policy_version,granted_at}], missing, llm_provider:{name,country}} (defaults "Ollama Cloud (Ollama Inc.)" / "US", config.py:54-55).
- POST /consents (auth+CSRF) {policy_version:str 1..32, kinds: ConsentKind[] 1..3} -> 200 ConsentState, idempotent; 409 policy_outdated details {policy_version}. Default POLICY_VERSION "2026-10-06".
- DELETE /consents/{kind} -> ConsentState. Withdrawing data_processing ERASES the journal. Unknown kind 422.
- Kinds: data_processing, llm_transfer, age_18. Chat+summarize need all 3; journal writes need data_processing+age_18; reads/deletes/export need only a session. Consent TEXT is not stored server-side; required content of the consent screen is in D\docs\adr\ADR-005-backend-stack.md:156-173.
- GET /export?format=json|md -> attachment liora-export-YYYYMMDD.json|md.

Chat (no DB writes):
- POST /chat/turn — auth+CSRF+3 consents. Body TurnRequest {scenario (required), messages:[{role:"user"|"assistant", content:str 1..4000}] 1..200 items, last must be user, revisit_summary_ids: uuid[] max 5 — required non-empty iff scenario=="revisit", forbidden otherwise}. Lengths are Python code points (JS .length is stricter). Server trims oldest history beyond 24000 chars for the LLM only.
  Observed order: 401 -> 403 csrf_failed -> 403 consent_required -> 422 -> keyword crisis (200 SSE crisis) -> 404 foreign revisit id -> 429 rate_limited -> 503 llm_busy -> 200 SSE.
- POST /chat/summarize — same gates; {scenario, messages} (no last-user rule) -> 200 SummaryDraftOut{title<=120, bullets 3..5 each <=500, tags<=5 each <=40}. Stores nothing. Errors: 409 crisis_stop details {helplines}, 429, 503 llm_busy Retry-After 5, 502 llm_failed ("The AI could not answer, try again" | "The AI returned an unusable summary, try again"). Save: map tags to {name, source:"ai"}; "don't save" = just don't POST.

Journal: writes auth+CSRF+data_processing+age_18; reads auth only.
- POST /summaries -> 201 SummaryOut. Body {scenario, title stripped 1..120 no NUL, bullets 1..5 each 1..500, tags <=10 of {name 1..40, source "ai"|"user" default user}}.
- GET /summaries?q&tag&cursor&limit(1..50, 20) -> {items, next_cursor}. GET/PATCH/DELETE /summaries/{id} (PATCH replaces whole lists; >=1 field). GET /tags -> [{id,name,count}]. GET /reviews/weekly?week_start&tz (only tz input; 422 invalid_timezone).
- SummaryOut {id, scenario, title, bullets[], tags:[{id,name,source}], created_at, edited_at|null}.

## 2. Turn streaming (SSE over POST; read response.body with fetch; EventSource cannot POST)
Headers: Content-Type `text/event-stream; charset=utf-8` (match startsWith), Cache-Control no-cache,no-store, X-Accel-Buffering no, X-Request-ID.
Frame: `event: <type>\ndata: <compact one-line JSON with same "type">\n\n`. Keep-alive comment `: ping\n\n` after 15 s idle (only after the response started). Before the stream opens the request can wait up to 20 s for the LLM slot then 503 — client timeouts must allow that.
Events: meta {type,request_id} (always first) · token {type,text} (deltas, concatenate) · done {type,finish_reason|null,usage|null} · crisis {type,source:"keyword"|"model",helplines} · error {type,code:"llm_failed"|"llm_busy"|"internal",retryable:bool (always true now)}.
Order: meta, 0+ token, exactly one of done|crisis|error. Keyword crisis = meta+crisis (no LLM). Model crisis can come AFTER some tokens; error can too -> client DROPS the partial text. Stream closing without a final event -> retry with the same messages. Crisis is sticky: every later turn in that session returns crisis again -> client locks the session. Client abort cancels upstream and frees the slot; nothing persisted.
helplines object: verified_at "2026-10-05", review_every_days 30, sources[], notes (contains 7333!), message (Ukrainian), emergency [{name,phone,hours,free}] (112, 103), lines [{name,phone,hours,free}] 5 entries, phones with spaces, free true|null, abroad {text,url}.

## 3. Errors: {"error":{"code","message","details"?}}
Validation details [{field:"messages.0.content", message}] (no input echo; path drops body/query/path; empty -> "request").
Starlette mapping: 400 bad_request, 401 unauthenticated, 403 forbidden, 404 not_found, 405 method_not_allowed, 413 payload_too_large, else http_error.
Codes: 401 unauthenticated "Sign in required" · 403 csrf_failed · 403 not_invited "Google email must be verified" (mobile sign-in only) · 403 consent_required details {missing,policy_version} · 404 not_found · 409 policy_outdated {policy_version} · 409 crisis_stop {helplines} (summarize only) · 413 payload_too_large (4,000,000 bytes) · 422 validation_error · 422 invalid_timezone · 429 rate_limited + Retry-After (>=1 s) · 502 llm_failed (summarize) · 503 llm_busy + Retry-After: 5 · 503 auth_unavailable · 500 internal.
Caddy: 413 JSON for chunked >4MB; Caddy's own 502/504 have an EMPTY body — never assume JSON.

## 4. CSRF
`origin` header required, not "null", must equal an allowed origin = scheme://host[:port] of PUBLIC_BASE_URL plus CORS_ORIGINS entries (CORS_ORIGINS replaces the dev defaults :8081 and :5173). GETs, bearer requests and POST /auth/dev exempt. No Referer check. Browser fetch: same-origin, default mode, Content-Type JSON; optional `referrerPolicy: 'same-origin'`. Page origin must equal PUBLIC_BASE_URL origin exactly (localhost vs 127.0.0.1 differ). Playwright `page.request` sends no Origin -> pass headers {Origin:'http://localhost:8088'} when seeding with the cookie.

## 5. Cookies and login redirect
Session cookie: `__Host-liora_session` (https) / `liora_session` (http); HttpOnly, SameSite=Lax, Path=/, Secure on https; Max-Age 400 days; real expiry server-side 30 days sliding (refreshed hourly); expired = 401 with cookie present.
OAuth flow cookie `liora_oauth`: HttpOnly, Lax, Path=/api/v1/auth/google, Max-Age 1200, flow 600 s.
next=: only a relative same-app path (<=512, starts with "/", not // or /\, no backslash/control/scheme/host), else "/". Redirect = WEB_APP_URL scheme+host + WEB_APP_URL.path + next. Prod WEB_APP_URL https://tryliora.duckdns.org -> next=/chat/ lands on /chat/.
Auth errors appended as `auth_error=<code>`: access_denied, state_mismatch, expired, not_invited (unverified email only), server_error. Missing/forged flow cookie -> next falls back to "/" (lands on /?auth_error=state_mismatch — the landing, not /chat/).

## 6. Access and limits
Google sign-in accepts any verified email, including in prod. AUTH_ALLOWED_EMAILS and the invitation checks are removed (ADR-008, 2026-10-08); a leftover environment variable is ignored. Existing sessions keep access subject to authentication, CSRF and consents. No AUTH_OPEN_SIGNUP flag. Rate limit 20 turns/min per user, in memory, shared by turn+summarize, not for keyword crises. No daily quota. LLM_MAX_CONCURRENCY=1 global semaphore held for the whole stream; wait up to 20 s then 503 llm_busy Retry-After 5. One uvicorn worker.

## 7. OpenAPI
S\scripts\export_openapi.py writes S\openapi.json (committed); `APP_ENV=test uv run python scripts/export_openapi.py [--check]`. 17 paths, ChatEvent union, ErrorResponse. Server docs/*.md: none; contract prose in S\README.md:8-16 and ADR-005 (session 38-50, API 52-56, auth 58-75, crisis 77-89, consent 91-100, client duties 150-173).

## 8. Local stack
D\compose.yaml + D\compose.local.yaml (server APP_ENV=dev, AUTH_DEV_LOGIN=true, WEB_APP_URL=http://localhost:8081 [planned -> :8088], LLM_PROVIDER=${LLM_PROVIDER:-fake}).
Run (from D\docs\runbooks\deploy.md:311-313, NOT the collapsed comment at compose.local.yaml:4):
  export POSTGRES_PASSWORD=x LIORA_APP_PASSWORD=x LIORA_MIGRATOR_PASSWORD=x SESSION_SECRET=local LOG_SALT=local PUBLIC_BASE_URL=http://localhost:8088 SITE_ADDRESS=:80 CADDY_HTTP_BIND=127.0.0.1:8088 CADDY_HTTPS_BIND=127.0.0.1:8443 SERVER_HOST_PORT=8002
  docker compose -f compose.yaml -f compose.local.yaml up -d --build --wait
Ports: Caddy 127.0.0.1:8088->80, :8443->443; API 127.0.0.1:8002; Postgres not published. Target http://localhost:8088 (others fail CSRF). Locally: cookie liora_session, Google unconfigured. 20 turns/min/user, 1 LLM slot -> distinct email per worker.
Test login: POST /api/v1/auth/dev {"email":"e2e-1@example.com"} (cookie, no Origin needed) -> GET /consents -> POST /consents {policy_version, kinds:[all 3]} with Origin.
Fake LLM: turn streams «Дякую, що поділилися. Що в цій ситуації зачепило вас найбільше?» word by word (no pings) then done{finish_reason:"stop", usage:{prompt_tokens:42, completion_tokens:n}}; summarize -> title «Розмова про день», 3 bullets, tags ["день","емоції"]. Not scriptable: error/llm_busy/model crisis/pings need client-side mocks. Keyword crisis for real with a synthetic phrase from S\tests\test_crisis.py:27-46 (e.g. «Я не хочу жити.").
Without Docker: compose.dev.yaml Postgres on 127.0.0.1:55433; `APP_ENV=dev uv run alembic upgrade head`; `APP_ENV=dev AUTH_DEV_LOGIN=true LLM_PROVIDER=fake uv run uvicorn app.main:create_app --factory --port 8787` (server\.env sets the REAL Ollama key — always export LLM_PROVIDER=fake).

## 9. Edge Caddy (D\caddy\Caddyfile)
Every response: HSTS max-age=31536000, nosniff, Referrer-Policy no-referrer, Server removed. No CSP anywhere yet. /api/*: request_body 4MB, reverse_proxy server:8000 flush_interval -1 (SSE unbuffered), no encode, no access log. Everything else -> web-client:8080 (plain file_server, no SPA fallback; no-cache except /assets/* immutable).
ADR conflict: ADR-006 (landing never calls the API, no cookies/forms), D\CLAUDE.md (web-client static, no API), W\CLAUDE.md (no forms/cookies) — superseded for /chat/ by the owner's decision 2026-10-07 (~/.claude/decisions/2026-10-07-liora-web-chat-in-web-client.md); ADR-007 must record it.
