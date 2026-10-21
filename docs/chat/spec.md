# Liora `/chat/`: специфікація для реалізації (фаза 2)

> Оновлення 2026-10-08 — ADR-008: доступ за запрошенням і `AUTH_ALLOWED_EMAILS` прибрані.
> Увійти може кожен із підтвердженою Google адресою. `not_invited` лишається тільки
> сумісним кодом непідтвердженої пошти на вході; тексти UI більше не згадують запрошення.
> Старі описи allowlist, G8, §3.4 та 403 `not_invited` на чаті/записах нижче — історичні;
> вони не визначають поточну політику доступу. Згоди, 18+, CSRF і ліміти залишаються.

> Дата: 2026-10-07. Для того, хто пише код у `web-client`, і для ревʼю власника.
>
> Це синтез трьох незалежних дизайнів:
> - **[C]** «Спокійний UX» — `phase2/design-calm-ux.md`;
> - **[P]** «Product polish» — `phase2/design-product-polish.md`;
> - **[E]** «Інженерія і ризик» — `phase2/design-engineering-risk.md`.
>
> Де дизайни розходяться, стоїть **Рішення:** — хто переміг і чому. Зведена таблиця — Додаток A,
> питання до власника — Додаток B, факти, перевірені в цій сесії, — Додаток C.
>
> Проєктую лише проти `phase2/api-contract.md` (далі — «контракт»). Правила:
> - `web-client/CLAUDE.md`;
> - ADR-005, розділ «Обовʼязки клієнта»;
> - ADR-006;
> - ADR-007 (Proposed, 2026-10-07).
>
> План: «Фаза 2» і «Фаза 4». Рішення власника: `2026-10-07-liora-web-chat-in-web-client.md` і
> `2026-10-07-liora-open-access.md`.

**Позначки**
- «…» — точний текст в інтерфейсі. Апостроф — `ʼ` (U+02BC), лапки — «ялинки», звертання на «ви».
- `{…}` — підстановка. **[A]** — значення з відповіді API.
- Моно-мітки в DOM пишемо звичайним регістром, а великі літери дає CSS (`text-transform: uppercase`) [E].
  Тоді скрінрідер не читає мітку по літерах.
- Фрагменти коду — ілюстрації, а не готовий код.

---

## 1. Цілі й не-цілі

### 1.1 Цілі фази 2 (MVP)

| # | Ціль | Критерій (§12) |
|---|---|---|
| G1 | **Вхід з лендінгу.** CTA «Розмова з AI →» у шапці (на телефоні — перший пункт меню) або клік по кулі веде на `/chat/`.<br>• Людина з живою сесією пише перше повідомлення за 3 дії: CTA → текст → «Надіслати».<br>• Перший візит — 7 дій, з них 3 — галочки згоди. | A1 |
| G2 | **Ніде немає сумніву, що на тому боці AI.**<br>• Мітка «AI» біля кожної репліки.<br>• «AI · не людина» під кулею.<br>• Постійний рядок під полем вводу.<br>У AI немає імені: «Liora» — це назва застосунку. | A2 |
| G3 | **Чесна згода без окремої сторінки політики.** Екран сам каже:<br>• що обробляється;<br>• ким: `{provider}` і `{country}` з `GET /consents`;<br>• що повного тексту розмови на сервері Liora немає.<br>Три окремі галочки. | A3 |
| G4 | **Чат зі стрімом SSE**, стійкий до кожної помилки контракту. Транскрипт живе лише в памʼяті вкладки. | A4–A6 |
| G5 | **Кризовий режим.**<br>• 112, 103 і howareu зашиті в сторінку.<br>• З payload беремо лише перевірені поля.<br>• «7333» не потрапляє в DOM ніколи.<br>• Розмову заблоковано. | A7 |
| G6 | **Кінець розмови.** AI пропонує 3–5 тез → людина переглядає й править → «Зберегти в щоденник» (`POST /summaries`) або «Видалити тези» (без запиту). Є режим «не зберігати». | A8 |
| G7 | **Меню акаунта:** експорт, відкликання згод, вихід, видалення акаунта з чесним переліком наслідків. | A9 |
| G8 | **Доступ за запрошенням до фази 3.** `not_invited` — окремий спокійний екран, а не помилка. | A10 |
| G9 | **Той самий візуал, що на лендінгу.**<br>• Куля стоїть у слоті майбутнього персонажа: low tier, DPR 1.<br>• Є «Пауза» і «Звук».<br>• WCAG 2.2 AA, строга CSP, без нових залежностей. | A11–A14 |
| G10 | **Логіку можна перенести в мобілку** (ADR-007). `src/chat/core` не торкається DOM, `window` і three.js. | A15 |

### 1.2 Не-цілі

| Що | Коли | Що робимо замість цього зараз |
|---|---|---|
| Відкритий вхід (`AUTH_OPEN_SIGNUP`), Google Auth у Production, Ollama Pro, денні ліміти ходів | Фаза 3 | Рядок «Поки що — за запрошенням» на екрані входу й екран `not-invited`. В API немає ознаки режиму доступу, тож рядок прибираємо правкою HTML разом із фазою 3. |
| Прибрати «Закрите тестування» з hero й глави 07 лендінгу | Фаза 3 | Лишаємо як є. Правимо лише FAQ і футер (§9.4). |
| 3D-персонаж і все для нього:<br>• GLTF;<br>• окремий рендерер з depth і MSAA;<br>• декодери Meshopt/KTX2;<br>• CSP з `'wasm-unsafe-eval'` і `worker-src blob:`;<br>• пози персонажа | Фаза 4, «пізніше» | Робимо зараз, разом із фазою 2, частину фази 4, позначену «зараз» (§9.2):<br>• слот сцени;<br>• API станів присутності (`data-presence`, `setPresence`);<br>• `src/gl/core/*`;<br>• поля `Tier`: `msaa`, `charLod`, `envSize`;<br>• пресети неба `html[data-sky]` і ключ `liora:sky`. |
| ~~Сторінка щоденника~~ | Зроблено | Тепер є: екран `journal` (§7.7) — огляд тижня, пошук, теми, правка (PATCH), видалення одного запису, копія, «Повернутися до цього». `invalid_timezone` обробляємо одним повтором (§4.3). Лендінг про це вже каже (фаза D1, §9.4 п. 7): FAQ, глава 03 і факти більше не обіцяють щоденник «згодом». |
| Сторінка політики конфіденційності | Не робимо: так вирішив власник | Усе потрібне — на екрані згоди (§3.5). |
| Trusted Types у CSP | Окремий PR після поправки ADR-007 | Grep-правило «без `innerHTML`» і тест (§10.5, питання B3). |
| Markdown у відповідях AI, клікабельні посилання в тексті AI | Не робимо | `white-space: pre-wrap`, лише `textContent` [E][P]. |
| `BroadcastChannel`, Service Worker, офлайн-режим | Не робимо | Інша вкладка дізнається про вихід з першого 401 [E]. |
| Голос і мікрофон, «поскаржитися на відповідь AI», Sign in with Apple, мобільний застосунок | Пізніше або в інших репо | — |
| «Пірнання» в кулю, крос-документний View Transition | Фаза 1c, на лендінгу | На `/chat/` звичайна навігація. Куля проявляється через `opacity` за 1.2 с, якщо рух дозволено [P]. |

### 1.3 Залежності поза `web-client`

> **Стан на 2026-10-07, після злиття (перекриває список нижче):**
> - server#5 злитий (`628a571`) і задеплоєний. На проді `GET /api/v1/helplines` віддає лише
>   `verified_at, message, emergency, lines, abroad`, без `notes` і без «7333». `google/start`
>   працює, бо Google налаштований.
> - devops#33 злитий (`fd0e27d`):
>   - ADR-007 Proposed: одна CSP на весь сайт, `no-store` лише на `/chat/`, `@stack` з
>     `E2E_STACK=1` і `--grep-invert "@gpu|@stack"` у `scripts/ci-e2e.sh`, переадресація
>     `/?auth_error=` → `/chat/?auth_error=`;
>   - `compose.local.yaml` уже на `:8088`.
>
>   `Permissions-Policy` в ADR-007 не згадано. Додати заголовок можна, ADR цьому не суперечить.
> - **Відповіді власника:**
>   - B1 = (a): поправити FAQ, сторінки щоденника в MVP немає;
>   - B2 = (a): назвати постачальника на лендінгу вже зараз;
>   - B3: Trusted Types — окремий PR пізніше, як за замовчуванням.
> - **Перша репліка `assistant` дозволена.** `TurnRequest` вимагає лише, щоб останнє повідомлення
>   було від `user` (`server/app/schemas.py:137`).
> - **Постачальник за замовчуванням:** `Ollama Cloud (Ollama Inc.)` / `US` (`server/app/config.py:54-55`,
>   `devops/compose.yaml:93-94`). Prod-`.env` може це перевизначити `[unverified]`, тож лендінг пише:
>   «Зараз це Ollama Cloud (Ollama Inc., США); назву й країну видно й на екрані згоди.»
> - **«Зашифроване сховище» у FAQ.** Runbook каже, що диск сервера gp3 зашифрований ключем `aws/ebs`
>   (`devops/docs/runbooks/deploy.md:25`). Рядок FAQ уточнити до «на зашифрованому диску сервера
>   Liora» і в PR позначити `[unverified: стан тому в AWS не перевірявся]`.
> - **CI web-client** (`.github/workflows/ci.yml`) запускається на кожен `pull_request` без фільтра
>   гілок, тож стековані PR теж отримують CI: PR з чатом можна відкрити від гілки PR зі сценою (seams), а
>   після її злиття — перенацілити на `main`. На `push` CI іде лише в `main` і лише коли змінилися
>   `.pre-commit-config.yaml` чи сам `ci.yml`.
>   `[verified: cat .github/workflows/ci.yml → «on: pull_request:» без «branches»; «push: branches: [main], paths: …»]`

Вони блокують реліз, але не цей PR.

1. **server, гілка `fix/4-crisis-helplines-auth-start` (коміт `4bedbe0`, ще не в `main`).** Що в ній:
   - один публічний whitelist для helplines: без `notes`, де стоїть «7333»;
   - редирект `google/start` з `auth_error=auth_unavailable`, коли вхід не налаштований.

   Реліз `/chat/` можливий лише після merge і деплою цієї гілки. Інакше при неналаштованому вході
   людина бачить сирий JSON 503 на білій сторінці: клієнт не може перехопити top-level перехід [P][C].

   Клієнт від прибирання `notes` не залежить (§6.3) — це друга лінія захисту.
2. **server (бажано, реліз не блокує).** Опис сценарію `situation` містить «(техніка з КПТ)»
   (`server/app/chat/prompts.py:46`). Клієнт цей опис не показує (§3.6), а правка на сервері прибирає
   ту саму проблему для мобілки.
3. **devops.**
   - `compose.local.yaml`: `WEB_APP_URL` → `http://localhost:8088`. Це потрібно для Google-входу на
     локальному стеку; dev-login працює й без цього.
   - Поправка ADR-007: `Permissions-Policy` і та сама CSP на `/`. У плані це є, а в ADR-007 поки
     лише `/chat/`.
   - `web-client/CLAUDE.md`: правило «Жодних форм … cookies» тепер стосується лише `/`.

---

## 2. Потік і машина станів

### 2.1 Потік

```
Лендінг /  ── «Розмова з AI →» (шапка; на телефоні — меню) ──┐
           └─ клік по кулі (a.hero__orb-link) ───────────────┴──► /chat/
/?auth_error=<код з білого списку> ── location.replace ──► /chat/?auth_error=<код>   (§9.4)

/chat/  booting: прочитати ?auth_error, прибрати його з адреси, потім GET /me
  ├─ мережа / 5xx / порожнє тіло / 15 с без відповіді ──────► fatal
  ├─ 401, auth_error = not_invited ─────────────────────────► not-invited (без сесії)
  ├─ 401, інший auth_error ──────────────────────────────────► signed-out + банер з поясненням
  ├─ 401 ────────────────────────────────────────────────────► signed-out
  └─ 200 ─► GET /consents ‖ GET /scenarios ‖ GET /summaries?limit=20
        │   (є auth_error → банер «Новий вхід не відбувся…» на наступному екрані, §3.3)
        ├─ missing ≠ [] ─► consent(first) ── POST /consents ──┐
        └─ missing = [] ──────────────────────────────────────┴──► chat (нова розмова; чекає й на /scenarios)

chat ── «Надіслати» ─► POST /chat/turn (SSE): meta → token… → done ─► chat
  ├─ crisis (keyword або model) ───────────────────────────────► crisis (розмову заблоковано)
  ├─ «Завершити розмову» ─► діалог
  │     ├─ «Підсумувати» ─► summarizing: POST /chat/summarize
  │     │     ├─ 200 ─► review
  │     │     │     ├─ «Зберегти в щоденник»: POST /summaries 201 ─► saved
  │     │     │     └─ «Видалити тези» (без запиту) ──────────────► ended
  │     │     └─ 409 crisis_stop ─────────────────────────────────► crisis
  │     └─ «Завершити без тез» ───────────────────────────────────► ended
  ├─ 401 ─► session-expired
  ├─ 403 not_invited ─► not-invited (з сесією)
  └─ 403 consent_required ─► consent(resume) ─► після згоди дія повторюється сама
saved / ended / crisis ─► «Почати нову розмову» ─► chat (нова розмова)

chat (нічого не летить) / saved / ended ─► «Відкрити щоденник» ─► journal (§7.7):
  GET /reviews/weekly?tz ‖ GET /tags ‖ GET /summaries?limit=20 — лише тут, ніколи на старті сторінки
  ├─ «До розмови» ─► chat як був (з chat) · «Нова розмова» ─► chat (з saved / ended)
  ├─ «Зберегти» ─► PATCH /summaries/{id} · «Видалити» ─► confirm(delete-summary) ─► DELETE /summaries/{id}
  ├─ «Повернутися до цього» ─► chat(revisit, [id]) (над розмовою — спершу confirm(revisit-restart))
  └─ 403 consent_required на PATCH ─► consent(resume, kind 'patch') ─► той самий PATCH ─► journal
```

**Одна адреса `/chat/`, без клієнтського роутера і без `pushState` на кроки** — тут усі три дизайни
згодні. «Назад» у браузері виходить зі сторінки, а `beforeunload` попереджає. Хеш-маршрути відкинуто:
транскрипт однаково не переживе перезавантаження, а зайві записи в історії створюють ілюзію, що
«Назад» поверне розмову [P].

### 2.2 Скільки кроків до першої відповіді AI

| Ситуація | Кроки |
|---|---|
| Перший візит | 1. CTA.<br>2. «Увійти через Google».<br>3. Вибір акаунта в Google.<br>4–6. Три галочки.<br>7. «Погоджуюся — почати».<br>8. Текст і «Надіслати».<br>Окремого екрана вибору сценарію немає: `free` обрано наперед (§3.6). |
| Повернення (сесія живе 30 днів) | CTA → текст → «Надіслати». На desktop курсор одразу стоїть у полі. |

### 2.3 Модель стану (`src/chat/core/state.ts`)

**Рішення:** явна машина `reduce(state, action) → [state, effects[]]` без DOM [E].
- Ефекти (fetch, таймери, `AbortController`, `beforeunload`) виконує `src/chat/ui/effects.ts`.
- Ядро тестується без браузера.
- [C] і [P] описують ті самі стани словами. Інваріанти, які перевіряє тест, дав лише [E].

```ts
// Ілюстрація. Типи DTO — з server/openapi.json (core/types.ts).
type ScenarioId = 'free' | 'situation' | 'day' | 'revisit'
type Msg = Readonly<{ role: 'user' | 'assistant'; content: string }>
type Session = Readonly<{
  scenario: ScenarioId
  revisitIds: readonly string[]   // 1..5 ⇔ scenario === 'revisit', інакше []
  messages: readonly Msg[]        // лише підтверджені репліки; [0] = opening_message, role 'assistant'
  noSave: boolean                 // режим «не зберігати» (§3.6)
}>
type Pending = Readonly<{ text: string; status: 'sending' | 'failed' | 'stopped'; error: UiError | null }>
// Що повторити після згоди. Для ходу — заморожене тіло, щоб повтор був ідентичним (I4).
type Resume =
  | { kind: 'turn'; request: readonly Msg[]; revisitIds: readonly string[] }
  | { kind: 'summarize' }
  | { kind: 'save'; draft: Draft }
  | { kind: 'patch'; journal: JournalState }   // PATCH запису щоденника: той самий body ще раз, і з saved/ended
type TurnPhase =
  | { p: 'idle' }
  | { p: 'waiting'; stage: 'headers' | 'meta'; startedAt: number; request: readonly Msg[]; trunc: 0 | 1; busy: 0 | 1 | 2 }
  | { p: 'streaming'; partial: string; request: readonly Msg[]; trunc: 0 | 1; busy: 0 | 1 | 2 }
  | { p: 'busy-wait'; until: number; request: readonly Msg[]; busy: 1 | 2 }        // відлік Retry-After
  | { p: 'cooldown'; until: number }                                                  // 429

type State =
  | { s: 'booting' }
  | { s: 'signed-out'; variant: 'fresh' | 'logged-out'; notice: AuthNotice | null }
  | { s: 'not-invited'; hasSession: boolean; stale: Session | null; pending: Pending | null; draft: Draft | null }
  | { s: 'consent'; mode: 'first' | 'update' | 'resume'; policyChanged: boolean; session: Session | null; pending: Pending | null; resume: Resume | null; error: UiError | null }
  | { s: 'chat'; session: Session; turn: TurnPhase; pending: Pending | null; notice: UiNotice | null }
  | { s: 'session-expired'; stale: Session; pending: Pending | null; draft: Draft | null }
  | { s: 'crisis'; helplines: SafeHelplines; stale: readonly Msg[] }
  | { s: 'summarizing'; session: Session; busy: 0 | 1 | 2; error: UiError | null }
  | { s: 'review'; session: Session; draft: Draft; saving: 'idle' | 'saving' | 'unknown'; error: UiError | null }
  | { s: 'saved'; summary: SummaryOut }
  | { s: 'ended' }
  | JournalState                                                  // щоденник, §7.7 (нижче)
  | { s: 'account-deleted'; variant: 'confirmed' | 'presumed' }   // presumed — 401 на повтор DELETE /me (§8.5)
  | { s: 'fatal'; error: UiError }
```

```ts
// Щоденник (§7.7). back — розмова, з якої його відкрили (null: з saved / ended).
type JournalState = {
  s: 'journal'
  back: { session: Session; pending: Pending | null; revertTo: ScenarioId; gone: boolean } | null
  tz: string | null                       // Intl-зона сторінки; 'Europe/Kyiv' після 422 invalid_timezone
  q: string; tag: string | null           // пошук і тема (AND); «Показати ще» тримає обидва
  list: Diary | null; loading: boolean; failed: boolean; cursor: string | null; req: number
  tags: Loadable<TagCountOut[]>
  week: { start: string | null; current: string | null; review: Loadable<WeeklyReviewOut>; req: number }
  edit: { form: EntryForm; saving: boolean; error: UiError | null; issues: DraftIssue[]; sent: PatchSent | null; req: number } | null
  deleting: string | null                 // id запису, чий DELETE летить
  notice: { kind: 'saved' | 'deleted' | 'gone' } | { kind: 'delete-failed'; error: UiError } | null
}
```

Кожен запит щоденника має номер `req` з `ctx.seq`: відповідь із чужим номером — застаріла й нічого не
міняє. Відповідь, що прийшла, коли щоденника вже нема на екрані, теж нічого не міняє. `leaveGuard` на
`journal` — лише коли під ним чекає розмова з повідомленням людини; незбережена правка запису не питає.
`canOpenJournal`: `chat` з `turn.p` = `idle` або `cooldown`, `saved`, `ended`.

**Неподане повідомлення поза `chat`.** Коли 401 чи 403 приходить на хід, текст людини ще не в `messages`,
а в `pending` (і в `resume.request`). Тому `consent`, `session-expired` і `not-invited` теж несуть `pending`:
- у транскрипті «лише для читання» воно стоїть останньою реплікою «Ви» з моно-міткою «Не надіслано»;
- у «Скопіювати текст розмови» воно йде останнім рядком: «Ви (не надіслано): …» (§3.8).

`summarizing` і `review` теж несуть `pending`: тези складаються лише з `messages`, а «Скасувати» чи «Повернутися
до розмови» повертає неподане повідомлення на місце (після 413 — разом із блоком замість композера). Звідти воно йде
і в `consent`, `session-expired` та `not-invited`. Заборонити підсумок, поки є `pending`, не можна: блок 413 сам
пропонує «Підсумувати».

**Поза `State.s`:**
- `ctx`, дані сторінки:
  - `me`;
  - `consents` (з них `{provider}` і `{country}` для рядка під полем вводу й меню);
  - `scenarios`;
  - `diary` — `{ items, nextCursor }` або `null`. Після `DELETE /consents/data_processing` і `DELETE /me`
    його скидаємо в `{ items: [], nextCursor: null }`: сервер щойно стер щоденник (§8.5, §8.6);
  - `afterCrisis: boolean` — лише на цей перегляд сторінки;
  - `authNotice` — банер «Новий вхід не відбувся…», якщо `?auth_error` прийшов, а `GET /me` дав 200 (§3.3).
- `overlay` — **стек** накладок глибиною до 2, а не одна:
  - нижній рівень: `null`, `account`, `help`, `revisit-pick` або `confirm(kind)` (на щоденнику — `confirm(delete-summary | revisit-restart)` з id запису в `summary`);
  - другий рівень дозволено лише так: `account` → `confirm(logout | delete-account | revoke)`. Обидва
    `<dialog>` відкрито через `showModal()`, і браузер тримає їх у top layer один над одним.
  - Кожен рівень памʼятає свого ініціатора (`opener`) в ефектах. Повернення фокуса — §3.1 «Діалоги».

**Рішення (банер замість екрана):** `auth_error` — це банер на екрані входу [C][P], а не окремий екран
`auth-error` [E]. Так на один стан менше, а кнопка «Увійти через Google» одразу під поясненням.

### 2.4 Переходи і виклики API

| Стан | Ефект на вході (API) | Подія → наступний стан |
|---|---|---|
| `booting` | Прочитати `auth_error` з `location.search` і пропустити через білий список (§3.3). Далі `history.replaceState(null, '', '/chat/')` і `GET /me`. | • `200` → `GET /consents` ‖ `GET /scenarios` ‖ `GET /summaries?limit=20`. Якщо був `auth_error` — `ctx.authNotice` (банер на наступному екрані, §3.3).<br>• Коли прийде `/consents`: `missing.length > 0` → `consent(first)` одразу. Інакше → `chat` з новою сесією, але **лише коли завершився й `/scenarios`** (успіхом чи помилкою): без нього немає першої репліки. `/summaries` доходить у фоні.<br>• Помилка `/consents` → `fatal`. Помилка `/scenarios` → фолбек «лише `free`» (§3.6). Помилка `/summaries` → рядок у `revisit` (§3.6).<br>• `401` і `not_invited` → `not-invited(hasSession=false)`.<br>• `401` і інший код → `signed-out(fresh, notice)`.<br>• `401` без коду → `signed-out(fresh)`.<br>• Мережа, 5xx, порожнє тіло або 15 с без відповіді → `fatal`. |
| `signed-out` | — | «Увійти через Google» — це навігація, стан не змінюється. «-> На головну». |
| `not-invited` | — | Вийти (§8.4), «Акаунт» (накладка), експорт (GET-навігація), «Скопіювати…». |
| `consent` | `first` після boot — дані вже є. `update` і `resume` — **завжди свіжий** `GET /consents`; галочки, версію й `missing` беремо лише з цієї відповіді, а не з `ctx` і не з `details` у 403 (для `POST /summaries` там лише два види) | • `resume` і свіжий `missing = []` (згоду вже дали в іншій вкладці) → POST не робимо, одразу повторюємо дію.<br>• `details.policy_version` з 403 ≠ версії в `ctx` → `policyChanged = true`: банер «Умови щойно оновилися…» поверх банера `resume`.<br>• «Погоджуюся», коли позначено всі пункти → `POST /consents {policy_version, kinds: missing}`. `kinds` ніколи не порожній (контракт: 1..3).<br>• `200`: якщо `mode='resume'` → назад у стан, з якого прийшли, і та сама дія з `resume` ще раз (для ходу — той самий `resume.request`); інакше → `chat`.<br>• `409 policy_outdated` → `GET /consents` → галочки зняті, `policyChanged = true`. `mode` і `resume` **не змінюються**: у режимі `resume` дія після згоди однаково повториться.<br>• `401` → `signed-out(fresh)`, або `session-expired`, якщо є сесія.<br>• Помилка свіжого `GET /consents` → рядок «Не вдалося завантажити умови. Спробуйте ще раз.» на цьому ж екрані, розмова на місці.<br>• Мережа, 5xx, 422 → рядок помилки на цьому ж екрані. |
| `chat`, `turn.p='idle'` | — | • Зміна сценарію, лише поки немає жодного повідомлення людини: без API. Вибір radio `revisit` накладку **не відкриває** — лише показує опис і «-> Обрати записи»; накладку `revisit-pick` (`GET /summaries`, «Показати ще» → `cursor`, пошук → `q`) відкриває ця кнопка (§3.6).<br>• «Надіслати», якщо `canSend` → `waiting`: `request = freeze([...messages, {role:'user', content}])`. `canSend = false`, поки `scenario === 'revisit'` і `revisitIds = []`.<br>• «Завершити розмову» → `confirm(end)`.<br>• «-> Надіслати ще раз» → `waiting` з **тим самим** `request`.<br>• «-> Змінити» → текст у поле вводу, `pending = null`. |
| `chat`, `waiting` / `streaming` / `busy-wait` | `POST /chat/turn` за §5 | • `meta` → `stage='meta'`; `token` → `streaming`, `partial += text`.<br>• `done` → `idle`, `messages = request + {assistant, partial}` (§5.8).<br>• `crisis` → `crisis`.<br>• Помилки — за §4.<br>• «Зупинити» → abort → `idle`, `pending.status='stopped'`. |
| `chat`, `cooldown` | таймер до `until` | Відлік дійшов до 0 → `idle` і анонс «Можна надіслати ще раз». |
| `summarizing` | `POST /chat/summarize {scenario, messages}`, таймаут 150 с | • `200` → `review`.<br>• `409 crisis_stop` → `crisis`.<br>• `503` → автоповтор ×2.<br>• `502`, 5xx, таймаут → `error` на екрані.<br>• «Скасувати» → abort → `chat`. |
| `review` | — | • «Зберегти» → `POST /summaries`: `201` → `saved`.<br>• «Видалити тези» → `confirm(discard)` → `ended`.<br>• «Скласти заново» → `confirm(regenerate)` → `summarizing`.<br>• «Повернутися до розмови» → `chat`, чернетку відкидаємо. |
| `saved` | стерти `Session`, зняти `beforeunload`, оновити `GET /summaries?limit=20` | «Почати нову розмову» → `chat` з новою сесією. «-> Відкрити щоденник» → `journal`. |
| `ended` | стерти `Session`, зняти `beforeunload` | «Почати нову розмову» → `chat` з новою сесією. «-> Відкрити щоденник» → `journal`. |
| `journal` | `GET /reviews/weekly[?tz]` ‖ `GET /tags` ‖ `GET /summaries?limit=20` (§7.7) | • «До розмови» → `chat` як був (`backToChat`); «Нова розмова» (з `saved`/`ended`) → `chat` з новою сесією.<br>• Пошук (300 мс, Enter одразу), тема, «Показати ще» → `GET /summaries?limit=20[&cursor][&q][&tag]`.<br>• «Попередній/Наступний тиждень» → `GET /reviews/weekly?week_start&tz`; далі поточного тижня не йде.<br>• «Зберегти» → `PATCH /summaries/{id}` (без змін — без запиту); 200 → запис на місці, знову `GET /tags` і тиждень; `ctx.diary` міняємо на місці, без GET.<br>• «Видалити» → `confirm(delete-summary)` → `DELETE /summaries/{id}`; 204 або 404 → запис зникає, ті самі оновлення.<br>• Поки PATCH чи DELETE летить, «До розмови» і «Повернутися до цього» чекають (`journalBusy`).<br>• «Повернутися до цього» → `chat(revisit, [id])`; над розмовою з повідомленням людини — спершу `confirm(revisit-restart)`.<br>• 401, `not_invited`, `consent_required` — як усюди; для PATCH `resume = { kind: 'patch' }`. |
| `crisis` | abort усіх запитів, зняти `beforeunload`, `setPresence('quiet')`, вимкнути звук | «-> Почати нову розмову» → `confirm(new-after-crisis)` → `chat` з новою сесією, `ctx.afterCrisis = true` (спершу `consent(first)`, якщо згоду відкликано, поки був `crisis`, §8.6). Інших виходів немає. |
| `session-expired` | — | «Увійти знову» → `confirm(relogin)` → зняти `beforeunload` → навігація на `google/start?next=/chat/`. |
| `fatal` | — | «Спробувати ще раз» → `booting`. |
| **будь-який** | — | • **Зміна `State.s` закриває всі накладки** (`dialog.close()`, стек `overlay` = порожній) без повернення фокуса ініціатору, далі фокус на `h1` нового екрана (§3.1 «Діалоги»).<br>• `401` на захищеному виклику → `session-expired` (якщо є сесія) або `signed-out`. На ході `pending` переходить у новий стан.<br>• `403 not_invited` → `not-invited(hasSession=true)`, з `pending`.<br>• `403 consent_required` → `consent(resume)`, з `pending` і `resume` (для ходу — `request` і `revisitIds`).<br>• Вихід → `POST /auth/logout` → `signed-out(logged-out)`.<br>• `DELETE /me` 204 → `account-deleted(confirmed)`; 401 на повторі після невідомого результату → `account-deleted(presumed)` (§8.5).<br>• `DELETE /consents/{kind}` 200 → `consent(first)`.<br>• `pageshow` з `persisted=true` → `GET /me`; на 401 стерти все → `signed-out(fresh)` [E].<br>• Кожне стирання `Session` (saved, ended, нова розмова після кризи, вихід, `account-deleted`, `pageshow` → 401) очищає й `[data-announcer]` (§5.7). |

### 2.5 Накладки

| Накладка | Коли | API |
|---|---|---|
| `account` | Кнопка «Акаунт» | Без запитів на відкриття. Дії — §8. |
| `help` | «Якщо важко» в шапці | `GET /helplines` — один раз за перегляд сторінки, лише через санітайзер (§6.3). У `crisis` беремо вже санітизований payload. |
| `revisit-pick` | Кнопка «-> Обрати записи» (сценарій `revisit`, щоденник не порожній) або 404 на ході | `GET /summaries?limit=20[&cursor][&q]` |
| `confirm(kind)` | `end`, `end-no-theses`, `discard`, `regenerate`, `leave`, `relogin`, `logout`, `new-after-crisis`, `delete-account`, `revoke(kind)`, `delete-summary(id)`, `revisit-restart(id)` | За дією |
| `breathe`, `ground`, `mood(when)`, `shelter` | Інструменти самодопомоги (§3.13): «+ Інструменти», чип «Як ви зараз?», «Якщо важко», екран входу, «А зараз?» (`mood(after)`) | **Жодних.** Не відкриваються в `crisis` і `booting` |

`confirm(logout)`, `confirm(delete-account)` і `confirm(revoke)` з меню відкриваються **другим рівнем над
`account`** (§2.3): меню не закривається, а після «Скасувати» фокус повертається на ту кнопку в меню, що
відкрила діалог. Ті самі діалоги, відкриті не з меню (наприклад, «Видалити акаунт» з «Не зараз» на згоді),
стоять на нижньому рівні.

Інструмент, відкритий з «Якщо важко», стає **над** ним, а дихання й заземлення з «В укритті» — над укриттям
(`help → shelter → breathe` — три рівні). Esc закриває лише верхній, і фокус іде на кнопку, що його
відкрила. Деінде інструмент замінює відкрите. Зміна екрана (криза насамперед) закриває весь стек (I6).

### 2.6 Інваріанти

Кожен інваріант покриває тест (§11).

- **I1. Транскрипт лише в памʼяті.** Він живе тільки в `State` і ніколи не потрапляє:
  - у `localStorage`, `sessionStorage`, IndexedDB, Cache API;
  - в URL чи `history.state`;
  - у `console`;
  - в атрибути `data-*`;
  - у `document.title`.
- **I2. Не більше одного LLM-запиту в польоті** (`turn` або `summarize`). Подвійний Enter чи клік дає
  один запит.
- **I3. Частковий текст AI потрапляє в `messages` лише на `done`.** На `crisis`, `error`, обрив чи
  «Зупинити» він зникає і з DOM, і зі стану.
- **I4. Повтор шле ідентичне тіло** (заморожений `request`) — і автоматичний, і ручний.
- **I5. З `crisis` немає шляху назад** у `chat`, `summarizing` чи `review` цієї розмови. Єдиний вихід —
  нова порожня розмова.
- **I6. Фокус.** Зміна екрана закриває всі накладки й переносить фокус на `h1` нового екрана
  (`tabindex="-1"`). Закриття діалогу повертає фокус на кнопку, що його відкрила; якщо її вже немає в
  DOM — на кнопку «Акаунт», а якщо й її немає — на `h1` поточного екрана. Фокус ніколи не падає на `body`.
- **I7. `beforeunload` зареєстрований тоді й лише тоді, коли** є що втратити: повідомлення людини (у
  `messages` чи `pending`) або незбережена чернетка тез. У `crisis`, `saved` і `ended` його немає.
  **Виняток — `tel:`:** клік по будь-якому `a[href^="tel:"]` знімає слухача на час переходу, щоб
  Chromium не показав «Покинути сайт?» перед екстреним дзвінком (§3.11).
- **I8. Текст моделі й рядки з API** потрапляють у DOM лише через `textContent` / `Text.appendData`.
- **I9. Форма запиту ходу.**
  - Останнє повідомлення в `turn` — від `user`.
  - `revisit_summary_ids` є тоді й лише тоді, коли `scenario === 'revisit'`.
  - Поле `timezone` не надсилається ніколи (`extra="forbid"` → 422).
- **I10. Подвійний клік — одне натискання там, де перше прибрало свою кнопку** (рядок, у якому вона стояла,
  рядок, який вона закрила) чи відкрило діалог: друге натискання того самого подвійного кліку (`detail` > 1,
  лічильник самого браузера, без таймера) влучає в те, що стало на її місце, — наступну «Прибрати», кнопки
  `confirm` на телефоні, — і не натискає нічого й не зсуває фокус, який поставило перше (`main.ts`, фаза C3, #101).
  Клавіатура цього не зачіпає: її натискання мають `detail` 0.

---

## 3. Екрани: точний текст і розкладка

### 3.1 Каркас сторінки (спільний для всіх екранів)

**Шари** — ті самі й у тому самому порядку, що на лендінгу (ADR-006):
1. CSS-небо `.stage`.
2. Канвас WebGL — **лише в слоті сцени**, `aria-hidden`.
3. Віньєтка.
4. Увесь текст.
5. Шапка.

Без WebGL у слоті стоїть статична CSS-куля `.orb` (вигляд `.hero__orb`, див. §9.2).

**Рішення (де живе канвас):** лише в слоті сцени [P], а не на весь екран. Причини:
- світло фізично не може опинитися під абзацом (ADR-006);
- пікселів утричі менше: ≈ 0.49 Мпкс замість 1.3 на 1440 × 900;
- у фазі 4 персонаж стане в той самий слот.

Як це зробити:
- мʼякий край — `mask-image: radial-gradient(closest-side, #000 72%, transparent 100%)` у CSS-файлі, і
  CSP це пропускає;
- боке в слоті вимкнене (`bokeh: 0`) [P].

**Краї неба** (фаза C3). Небо під липкими шарами не обривається швом: віньєтка `.chat-page .vignette` сходиться
до `--color-bg` трьома краями — угорі під шапкою й рядком сесії (`--edge-top`), унизу над композером
(`--edge-bottom`, лише на `html[data-screen='chat']`) і праворуч біля класичної смуги прокрутки (`--edge-right`,
лише з `html[data-gutter]`; `.stage::after` там теж 8rem і з тією самою кривою). Кожен край — плавна крива
(`color-mix` 84 / 50 / 16 % на 10rem, праворуч 8rem), а не рампа за 3rem, що читалася як смуга. Згасання
під рядком сесії (`--fade-top`) у розмові — 1.75rem, рівно відступ над надісланою реплікою: якір надсилання
(§3.7.6) ставить її під згасання, і в спокої жоден рядок тексту не стоїть у ньому наполовину (#93).

**`<title>`:** «Розмова з AI — Liora» на **всіх** екранах [C].

**Рішення:** [C], а не заголовок під кожен екран [E] («Якщо вам дуже важко · Liora»). Назву вкладки
видно на спільному екрані й у перемикачі вкладок, тож вона видала б кризу. Орієнтацію скрінрідеру й так
дає фокус на `h1`.

**`<head>` сторінки `chat/index.html`:**
- `<html lang="uk">`;
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`;
- `<meta name="robots" content="noindex">`;
- `<meta name="description" content="Розмова з AI, а не з людиною. Не терапія й не медична допомога.">`;
- `<meta name="theme-color">` — одразу після `charset`, **перед** `public/theme-init.js` (фаза C3): скрипт
  ставить йому `--color-bg` вибраної теми, а без вибору — системної (`rgb(246, 241, 234)` чи `rgb(18, 26, 27)`;
  без `light-dark()` у браузері — темний, як і CSS-фолбек) ще до першого кадру й до модуля сторінки. Далі
  колір веде `ui/theme.ts` (`refreshThemeColor()`) (#95). На `/` так само (фаза D1: лендінг більше не
  закріплений темним), лише темна тема там — ніч лендінгу. Темний колір скрипт бере з hex, який кожна сторінка
  дає своєму `theme-color` у HTML (`#121a1b` у чаті, `#040708` на `/`), у формі `rgb(r, g, b)`, як потім пише
  `ui/theme.ts`: смуга темного лендингу — ніч `rgb(4, 7, 8)` від першого кадру й без модуля, без «лампи» між
  ними (§9.4 п. 7; до рев'ю D1 скрипт ставив тут «лампу» `rgb(18, 26, 27)`, доки модуль її не виправляв);
- той самий favicon;
- **немає** og-тегів.

**Шапка** — стиль і компоненти лендінгу:

| Елемент | Вигляд | Поведінка |
|---|---|---|
| Лого `.brand` «Liora» | Як на лендінгу. Нижче 26em — лише знак. | `href="/"`. Якщо є що втратити (I7), спершу відкривається діалог `leave` (§3.12). |
| «Якщо важко» `.help-link` + visually-hidden «: контакти допомоги, 112 і 103» | Бурштиновий контур | Відкриває діалог `help` (§3.11) **поверх** сторінки. Це не посилання на `/#safety`: перехід стер би розмову [C]. У `crisis` має `aria-current="true"` [P]. |
| «Пауза» / «Звук» `.media` | Той самий компонент і `initMotionToggle`, ключ `liora:motion` | Звук вимкнений на кожному візиті. Мовчить у `crisis`, поки відкритий `help`, на паузі й у прихованій вкладці. |
| «Акаунт» | Кругла кнопка 40 px — того ж розміру й на тому ж місці, що `.menu-toggle` на лендінгу; іконка-контур людини 16 px. Від 64em — іконка й слово «Акаунт» у пілюлі 40 px. | `aria-haspopup="dialog"`, `aria-label="Акаунт"`. Видно лише тоді, коли є сесія. Email у шапці не показуємо [C]. |

- На `/chat/` немає CTA «Розмова з AI →» і розділів лендінгу.
- Шапка телефону — це шапка лендінгу, де «Меню» замінили на «Акаунт» того самого розміру. Але тест
  «шапка влазить у 320 px» (`header.spec.ts:92`) ганяє лише `/` (`page.goto('/')`), а шапка `/chat/` на
  телефоні нижча (56 px). Тому в `chat.spec.ts` є той самий тест для `/chat/` (#43b).
  `[verified: sed -n 80,105p tests/e2e/header.spec.ts → page.goto('/')]`
- Висота шапки:
  - desktop — 68 px (`min-height: 4.25rem`), поля `0.75rem var(--gutter)`;
  - телефон (< 64em) — 56 px (`min-height: 3.5rem`), лише на `/chat/`.
- `--header-h`, `--session-h` і `--composer-h` **не захардкоджені**: їх міряє `ResizeObserver` і пише
  `style.setProperty` на `:root`. У `chat.css` стоять лише стартові значення (68 px / 56 px і 52 px) до
  першого виміру. Так при масштабі 200 % чи text-spacing, коли шапка переноситься в два рядки, `top`
  липких рядків рахується від справжньої висоти.
- **Фокус не ховається під липкими шарами** (WCAG 2.2 SC 2.4.11):
  ```css
  html {
    scroll-padding-top: calc(var(--header-h) + var(--session-h) + 0.5rem);
    scroll-padding-bottom: calc(var(--composer-h) + 0.5rem);
  }
  ```
  Tab по діях у транскрипті («-> Надіслати ще раз», «-> Змінити», «↓ До кінця»), по перемикачу «Не
  зберігати» і по пілюлях сценаріїв прокручує елемент так, що він не опиняється під шапкою, рядком сесії
  чи композером. Той самий `scroll-padding` дає відступ і якорю надсилання (§3.7.6). Без рядка сесії
  (нова розмова) `--session-h` = 0.

#### Desktop (≥ 64em), еталон 1440 × 900

**Сітка:**
- `--gutter` 56 px, рамка 1328 px;
- тіло — `grid-template-columns: minmax(0, 42rem) minmax(0, 1fr); column-gap: clamp(2rem, 5vw, 4rem)`;
- текстова колонка — 672 px (x 56…728), проміжок — 64 px, колонка сцени — 592 px (x 792…1384).

**Рішення (бік сцени й ширина колонки):**
- Сцена праворуч [C][E], а не ліворуч [P]. На лендінгу куля hero стоїть праворуч — на знімку проду
  центр ≈ (1065, 440), d ≈ 430. Перехід з лендінгу має приземлятися на ту саму кулю.
- Колонка тексту 42rem [C], а не 46rem [E][P]. Тоді центр кулі в чаті (x ≈ 1088) майже там, де в hero.

**Колонка сцени:**
- `position: sticky; top: var(--header-h); height: calc(100svh - var(--header-h))` = 832 px на 1440 × 900;
- слот кулі — `width: min(100%, 30vw, 26rem, 52svh); aspect-ratio: 1` = 416 px на 1440 × 900;
  - `100%` — ширина колонки сцени. Без нього від 64em до ≈ 1180 px слот ширший за колонку: на 1024 px
    колонка ≈ 219 px, а `min(30vw, 26rem, 52svh)` = 307 px; на 1100 px — 285 і 330 px. Куля вилізла б у
    проміжок і на текст. `[verified: node -e "…gutter clamp(1rem,4vw,3.5rem), gap clamp(2rem,5vw,4rem)…" → 1024: col 219 / slot 307; 1100: 285 / 330; 1180: 355 / 354; 1440: 592 / 416]`;
  - на 1024 × 768 куля ≈ 219 px — менша, але світло фізично лишається в колонці сцени (ADR-006);
  - по горизонталі — по центру колонки;
  - по вертикалі — на 46 % висоти (y ≈ 451).

Припущення: беру `min(100%, …)` замість двох колонок лише від ~75em, бо це одна властивість і жодної
нової точки зламу (64–75em не стає окремим «планшетним» макетом з іншою шапкою); якщо не так — скажіть.

**Під кулею:**
- на +24 px — моно-мітка «AI · не людина»: `--color-teal`, 11 px, 0.14em;
- на +6 px під нею — стан присутності: Onest 15 px, `--color-text-soft`. Варіанти тексту (§9.2):
  - «Чекає на ваше повідомлення»;
  - «Думає над відповіддю»;
  - «Відповідає»;
  - «Складає тези»;
  - «Тези збережено»;
  - «Розмову зупинено».
- Цей блок `aria-hidden`: стан озвучує live-регіон (§5.7).
- Мітку стану видно лише там, де людина може писати або AI працює: `booting`, `chat`, `summarizing`,
  `saved` і `crisis`. На входах, `not-invited`, згоді, `review`, `ended`, `fatal`, `account-deleted` і
  `session-expired` «Чекає на ваше повідомлення» було б неправдою, тож CSS ховає її (`visibility: hidden`,
  місце лишається, нічого не зсувається). На телефоні мітки стану немає зовсім (`display: none`).

**Рішення (модель скролу):** скролиться документ [C][E], а не внутрішній контейнер (app-shell [P]).
- Нативний скрол — правило ADR-006.
- Працюють пошук на сторінці й масштаб.
- Немає «скролу в скролі».
- Транскрипт не треба робити фокусованою областю (axe `scrollable-region-focusable`).

Те, що [P] вирішував app-shell'ом, тримає `position: sticky`: рядок сесії зверху, композер знизу і
колонку сцени.

#### Телефон (< 64em), еталон Pixel 7: viewport 412 × 839

**Сітка:**
- поля 16 px (`--gutter` ≈ 16.5 px);
- одна колонка. На планшеті (600–1023 px) — та сама, з `max-width: 46rem` по центру.

**Куля:**
- **WebGL-кулю видно лише в новій розмові**, поки людина нічого не надіслала:
  - 160 px (`--slot: 10rem`, як на текстових екранах), по центру, на 8 px нижче шапки. Було 200 px, але на
    412 × 839 тоді перемикач «Не зберігати» стояв під композером (y ≈ 655–699 при непрозорій смузі з
    ≈ 682 px) і без прокрутки його не видно, а після першого повідомлення він зникає. Тому в новій
    розмові на телефоні менша куля і проміжки 12 px (`.screen--chat`, `.compose-head`); тест розкладки
    412 × 839 (#43) тримає низ перемикача над композером;
  - стоїть у власному слоті в потоці документа: текст під нею, ніколи не на ній;
  - під кулею — «AI · не людина».
- Після першого надісланого повідомлення:
  - слот ховається, GL переходить на `pause()`;
  - у рядку сесії зʼявляється CSS-куля 32 px [P].
- На текстових екранах (вхід, згода тощо) куля 160 px стоїть над тегом, у потоці. **На `crisis` кулі на
  телефоні немає:** номери мають бути у viewport без скролу (§6.4).

**Екранна клавіатура** (`ui/keyboard.ts`):
- `html[data-kb]` ставимо, коли фокус у текстовому полі, `pointer: coarse` і `visualViewport.height`
  зменшився щонайменше на 150 px відносно висоти до фокуса. Знімаємо на `focusout` або коли висота
  повернулася.
- `--kb = max(0, innerHeight − visualViewport.height − visualViewport.offsetTop)` на кожну подію
  `visualViewport` `resize` / `scroll`. Android Chrome з `interactive-widget=resizes-content` стискає
  layout viewport, тож там `--kb` ≈ 0. iOS Safari цей ключ ігнорує, і `bottom: 0` композера рахувався б
  від layout viewport під клавіатурою — тому композер стоїть на `bottom: var(--kb, 0px)`.
- `html[data-kb]` і `@media (max-height: 30em)` (landscape телефону):
  - шапка й рядок сесії — `position: static`, тобто скролуються разом зі сторінкою;
  - під полем лишається лише моно-рядок «AI, не людина · може помилятися · не терапія», другий рядок
    ховається (він є на екрані згоди й у `leave`);
  - нижній відступ композера без `env(safe-area-inset-bottom)`: над клавіатурою ці ≈ 34 px були б
    порожнечею;
  - градієнт над композером — 12 px замість 32.
- Усі `input` і `textarea` на `/chat/` — кегль ≥ 16 px (поле нового тегу, пошук у `revisit-pick`,
  назва, тези, композер), інакше iOS збільшує сторінку на фокусі.
- Повноекранні накладки на телефоні — `height: 100dvh`. `revisit-pick` з пошуком — `height:
  var(--vvh, 100dvh)`, де `--vvh` = `visualViewport.height`: список не ховається під клавіатуру.
- Поведінка на справжніх Pixel 7 та iPhone — `[unverified]` (Додаток C). У CI її тримає тест розкладки
  839 × 200 (#43c).

**Рішення:** [P], а не куля 144 px, що скролиться з текстом [C], чи слот 36 px з WebGL [E]. WebGL на
32 px коштує майже як на 200 px, а 20 хвилин розмови на телефоні помітно за батареєю.

#### Типографіка

Лише наявні токени й класи.

| Роль | Клас або стиль |
|---|---|
| Моно-мітка, тег екрана | `.tag`: Martian Mono 11 px (`--step-label`), 0.14em, uppercase через CSS, `--color-text-soft`. Індекс — `--color-light`. |
| H1 текстових екранів | `.display-2`: `--display-2` від 30 до 68 px, моно 300, ширина 87.5 %, `--leading-display`, `max-width: 18ch` |
| Лід | `.lead`: `--step-1` від 17.6 до 20 px, `max-width: 40rem` |
| Рядки з лініями | `.rows` / `.row` / `.row__title` — як принципи приватності на лендінгу |
| Абзаци | Onest `--step-0` (16–17 px) / 1.6, `--color-text-soft` |
| Дрібний текст | Onest `--step--1` (13–14 px), `--color-text-dim` — ≥ 4.5:1 на найсвітлішому небі під текстом |
| Третинні дії | `.arrows`: моно, стрілка `->` світлом |
| Великі номери в кризі | `.help__number`: `clamp(3.5rem, 2.4rem + 4.5vw, 7rem)` |

#### Кнопки

Форма пілюлі — лише для того, що натискається [P].

| Тип | Вигляд |
|---|---|
| Основна | Заповнена: фон `--color-light`, текст `--color-bg` (≈ 13:1), Onest 600 16 px, висота 48 px, поля `0 1.5rem`, `border-radius: 999px` |
| Другорядна | Контур 1 px `--color-line-strong`, фон `rgb(4 8 9 / 0.82)`, текст `--color-text`, висота 44 px |
| Небезпечна | Як другорядна, але лінія й текст `--color-light`. Сам напис каже, що станеться: «Так, видалити все». |
| Третинна | Моно-посилання чи кнопка зі стрілкою `->` (`.arrows`), зона влучання ≥ 44 px |

**Рішення (колір небезпечних дій):** `--color-light` [P][E], а не новий токен `--color-caution` [C].
Правило токенів лендінгу — «колір дає лише світло», і червоного в палітрі немає навмисно.

**Нові токени** в `tokens.css` — лише для форми, кольорів не додаємо:
- `--radius-field: 0.875rem` (14 px) — поле вводу;
- `--radius-dialog: 1rem` (16 px) — діалоги.

#### Діалоги

Загальні правила:
- нативний `<dialog>` + `showModal()`, без `<form>`;
- Esc закриває (крім `confirm(new-after-crisis)`, де Esc = «Скасувати»);
- **фокус повертаємо вручну, а не покладаємося на браузер.** На відкритті `dialogs.ts` запамʼятовує
  ініціатора (`opener`), на закритті ставить фокус на `opener.isConnected ? opener : кнопка «Акаунт»`, а
  якщо й її немає — на `h1` поточного екрана (I6);
- стек `account` → `confirm(…)` (§2.5): верхній діалог закривається першим, фокус іде на кнопку в
  `account`, що його відкрила; `account` лишається відкритим;
- `confirm(end)` ↔ `confirm(end-no-theses)` міняють вміст **того самого** `<dialog>`: після «Завершити
  без тез» фокус на «Назад», після «Назад» — на «Завершити без тез». Закриття повертає фокус на
  «Завершити розмову»;
- зміна екрана (`State.s`) закриває всі діалоги без повернення фокуса ініціатору: фокус іде на `h1`
  нового екрана (§2.4, рядок «будь-який»). Так кризовий екран, `session-expired` чи `consent(resume)` не
  лишаються під backdrop і `inert`;
- фон `--color-bg` непрозорий, без blur;
- `::backdrop` — `rgb(4 7 8 / 0.6)`;
- поки відкритий діалог, `html` бере `--color-bg-under-scrim` (`#d1cac2` / `#0b1011` — колір сторінки під
  `::backdrop`): класична смуга прокрутки стоїть поза backdrop, і її жолоб інакше лишався б світлою смугою
  поруч із затемненою сторінкою (фаза C3, #96). **Лише там, де такий жолоб є** (`html[data-gutter]`): на телефоні
  (смуги поверх вмісту) корінь лишається `--color-bg`, і смуга браузера над повноекранним аркушем — теж. Шар-зображення
  замість кольору не годиться: жолоб показує лише колір кореня (перевірено пікселем у Chromium). «В укритті» має
  власне правило й лишається темним;
- `theme-color` читається знову щоразу, коли діалог відкривається чи закривається (`tools.ts`, ключ `shelter` /
  `dialog` / `page`), а не лише з «В укритті»: тема, обрана в «Акаунт» → «Вигляд», раніше лишала смугу браузера
  кольору scrim (`rgb(209, 202, 194)`) і після закриття аркуша; так само «В укритті» над «Якщо важко» (ревʼю C3, #99).

**Desktop:**
- `confirm` і `help` — по центру;
  - ширина: `confirm` — `min(34rem, 100% - 2 * var(--gutter))`, `help` — `min(44rem, …)`;
- діалоги інструментів (§3.13) — `min(38rem, …)`, **прикріплені згори** (`min(12dvh, 6rem)`), не по центру:
  вони міняють висоту по ходу (зʼявляються слова чек-іну, «Почати» стає колом, крок довший), і центрований
  аркуш зсунув би те, що людина щойно натиснула; шапка лишається, де відкрилася, аркуш росте вниз;
  - лінія 1 px `--color-line-strong`, радіус `--radius-dialog`, поля 28 px;
- `account` — бічний аркуш праворуч [E]: 26rem, на всю висоту, лінія ліворуч.

**Телефон:**
- `account`, `help` і `revisit-pick` — на весь екран, як `.site-menu`: `100dvh`, «Закрити» праворуч угорі;
- `confirm` — нижній аркуш на всю ширину, кнопки стовпчиком по 52 px [E].

#### Фокус і рух

**Фокус:**
- зміна екрана → `h1[tabindex="-1"].focus()`;
- у діалогах небезпечних дій стартовий фокус — на «Скасувати» чи «Залишити»;
- видимий фокус — 2 px `--color-focus` з відступом 2 px;
- цілі влучання — за WCAG 2.2 AA SC 2.5.8: кожна ≥ 24 × 24 px (або з достатнім відступом), а **основні
  дії ≥ 44 px**: «Надіслати» / «Зупинити», основні (48 px) і другорядні (44 px) кнопки, рядки галочок
  (≥ 56 px), `tel:`-посилання (≥ 48 px), «×» у тезах, третинні `.arrows` (зона ≥ 44 px), пілюлі сценаріїв
  на телефоні. Свідомо менші, як на лендінгу: «Акаунт» і пілюля «Завершити розмову» — 40 px, radio-пілюлі
  сценаріїв на desktop — 40 px, кнопки `.media` — 36 px усередині пілюлі.

**Рух** (фаза B, #19 — «живий», але тихий):
- приглушуємо лише кольором `--color-text-dim`, ніколи `opacity`. `opacity` буває лише в переході, що
  закінчується на 1 (поява), і в «сховано до наведення» дій під відповіддю («Копіювати», «→ У тези») на `pointer: fine` (§3.7.2);
- при `html[data-motion="off"]` чи `prefers-reduced-motion` усе зʼявляється одразу, а сцена стоїть:
  кожна анімація в `chat.css` стоїть під `html[data-motion='on']`;
- токени відповіді зʼявляються однаково, з рухом і без: це вміст, а не декор. З рухом кожне нове слово
  (`span.w`) проявляється за `--dur-2` (180 мс); після `done` текст переписується без обгорток;
- тривалості — токени `tokens.css`: `--dur-screen` 280 мс, `--dur-item` 220 мс, `--dur-breath` 7 с;
  підйом `--rise-screen` 8 px, `--rise-item` 4 px;
- **екран** заходить за 280 мс: fade і 8 px підйому (`rise-in`). Старий екран ховається одразу, анімацій
  виходу немає. `crisis`, `booting`, `fatal` і `session-expired` не рухаються ніколи (§6.2);
- **репліка**, що прийшла наживо (надіслане повідомлення, слот відповіді, підмінена перша репліка при
  зміні сценарію), — 220 мс і 4 px (`.said--in`). Перебудований список і read-only копії не рухаються;
- **перше повідомлення**: транскрипт ковзає з-під шапки нової розмови на своє місце (FLIP через
  `Element.animate`, 240 мс), щоб людина бачила, куди поділися сценарії. «Пауза» чи зміна екрана
  одразу доводять його до кінця (`finish()`);
- **куля**: `idle` повільно дихає (7 с), `listening` (1.6 с після останнього натиску в полі, лише коли AI
  нічого не робить) — трохи збільшується (без руху лише яскравішає ядро), `thinking` і `speaking` — пульс
  ядра. З WebGL те саме робить сцена, CSS-куля схована;
- `.chat` обрізає переповнення по обох осях (`overflow: clip`, не контейнер скролу — sticky працює):
  екран, що підіймається з 8 px нижче, інакше на час анімації робив би сторінку на один екран
  прокручуваною;
- **діалоги** `confirm`, `revisit-pick` і бічна панель «Акаунт» заходять через `@starting-style` (fade і
  зсув), `help` — одразу; виходу без анімації. Toggletip і меню «Інструменти» — fade і 4 px. Діалоги
  інструментів (§3.13) — як `revisit-pick`; «В укритті» — одразу, як контакти. Коло дихання (крива
  `--ease-breath`) і крок заземлення — лише під `html[data-motion='on']` **і** `prefers-reduced-motion:
  no-preference`. Куля під час дихання стоїть (§3.13).

### 3.2 `booting`

- **0–400 мс:** лише небо, шапка й куля, без тексту — щоб не блимало на швидкій мережі [P].
- **Після 400 мс:** під кулею моно-мітка «Зʼєднуємося» (`--color-text-muted`).
- **Для скрінрідера:**
  - `<main aria-busy="true">`;
  - прихований `role="status"`: «Відкриваємо розмову…».
- **`<noscript>`** [E]: «Для розмови з AI потрібен JavaScript. Якщо вам зараз дуже важко — телефонуйте 112 або 103.»
- Таймаут `GET /me` — 15 с, далі `fatal`.

### 3.3 `signed-out`: вхід

**Розкладка:**
- desktop — текстова колонка, куля праворуч;
- телефон — куля 160 px, під нею текст.

| Елемент | Текст і поведінка |
|---|---|
| Банер — лише з `auth_error` або після виходу | Стоїть над тегом. `role="status"`, `tabindex="-1"`, фокус на ньому [P]. Бурштинова ліва лінія 2 px; рамки фокуса немає, як і в `h1` (сторінка фокусує банер сама, Tab до нього не доходить), лише лінія в фокусі світлішає. Моно-мітка «Вхід не відбувся» — тільки для `auth_error`. Після виходу й після 401 на першому `DELETE /me` (вхід не зривався, сесія просто скінчилася) мітки немає. Речення 17 px — з таблиці нижче. |
| Тег | «Розмова з AI» |
| H1 | «Розмова з AI, а не з людиною» |
| Лід | «AI ставить запитання, а наприкінці пропонує 3–5 коротких тез — зберегти їх у щоденник чи видалити, вирішуєте ви.» |
| Примітка (Onest 500 `--step-0`, `--color-teal`, звичайний регістр — фаза C3: моно-капс читався як ще один тег) | «Саморефлексія, а не терапія й не медична допомога.» |
| Під кнопкою (`.small`, фаза B — замість окремого рядка `.row`) | «Потрібна підтверджена адреса Google і 18 років; перед першою розмовою — екран згоди.» |
| Основна кнопка | «Увійти через Google». Це `<a href="/api/v1/auth/google/start?next=/chat/">`: top-level перехід, не `fetch` і не `<form>`. Значок «G» — локальний SVG. |
| `<details class="more">`, закритий наперед (фаза B) | `summary` «Що буде після входу»; усередині — три пункти нижче. |
| Пункт 1 | «Google спитає, яким акаунтом увійти. Від нього ми отримаємо ідентифікатор акаунта й email — без імені, фото, листів, Диска й календаря.» |
| Пункт 2 | «Перед першим повідомленням — окремий екран згоди: хто обробляє текст розмови (назва постачальника AI і країна) і що зберігається.» |
| Пункт 3 | «Під час входу браузер отримає тимчасовий файл cookie входу (до 20 хвилин), а після входу — файл cookie сесії, щоб ви залишалися в акаунті. Обидва недоступні скриптам сторінки. Реклами й аналітики тут немає.» Пункт закриває розбіжність із футером лендінгу: людина дізнається про cookie ще до входу [C]. |
| Третинна дія | «-> На головну» (`href="/"`) |
| Рядок допомоги (внизу, `--color-light`) | «Якщо вам зараз дуже важко, не чекайте входу: 112 або 103 — цілодобово й безкоштовно.» Номери — посилання `tel:`. |
| «Без входу» (фаза C, §3.13) | Рядок третинних дій «Подихати хвилину» · «Заземлення 5-4-3-2-1» · «В укритті». Один дотик, без запиту й без розмови: шлях через «Якщо важко» коштував би `GET /helplines`. |

**Тексти банера.**
- Код з URL проходить білий список. Сирий рядок з URL у DOM не потрапляє [P].
- `role="status"`, а не `alert` [C]: нічого страшного не сталося.

| Звідки | Текст |
|---|---|
| `auth_error=access_denied` | «Вхід скасовано. Можна спробувати ще раз, коли будете готові.» |
| `auth_error=state_mismatch` | «Вхід не завершився. Так буває, якщо сторінку входу відкрили в іншій вкладці або повернулися кнопкою «Назад». Спробуйте ще раз.» |
| `auth_error=expired` | «Сторінка входу була відкрита понад 10 хвилин і застаріла. Спробуйте ще раз.» |
| `auth_error=server_error` | «Google або наш сервер відповіли не так, як треба. Спробуйте за хвилину.» |
| `auth_error=auth_unavailable` | «Вхід тимчасово недоступний. Спробуйте пізніше — 112 і 103 працюють завжди.» |
| `auth_error=not_invited` | Не банер, а екран `not-invited` (§3.4) |
| Невідомий код | «Не вдалося увійти. Спробуйте ще раз.» |
| Після «Вийти» (`variant=logged-out`) | «Ви вийшли з акаунта на цьому пристрої.» |
| `DELETE /me` → 401 **з першої спроби** | «Вхід завершився. Увійдіть, щоб видалити акаунт.» 401 на повторі після невідомого результату — не банер, а `account-deleted(presumed)` (§8.5). |

**`?auth_error=…`, але `GET /me` → 200.** Стара cookie жива, а новий вхід (наприклад, іншим, незапрошеним
акаунтом) не вдався. Банер не губимо: він стоїть над тегом екрана, на який веде boot (`consent` чи нова
розмова), з тими самими `role="status"`, `tabindex="-1"` і фокусом.

| Код | Текст |
|---|---|
| `not_invited` | «Новий вхід не відбувся: тієї адреси немає в списку тестувальників, або Google не підтвердив її. Ви й далі в акаунті {email} [A /me].» |
| будь-який інший з білого списку чи невідомий | «Новий вхід не відбувся. Ви й далі в акаунті {email} [A /me].» |

«Новий вхід», а не «вхід іншим акаунтом»: людина могла пробувати той самий акаунт.

### 3.4 `not-invited`: доступ за запрошенням

**Без сесії** (`?auth_error=not_invited`):
- Це не помилка, а спокійний екран.
- Колбек сервера викликає `ensure_allowed` **до** `_sign_in`. Отже, цей вхід не створює ні **нового**
  акаунта, ні сесії, і це можна чесно сказати. `[verified: grep -n ensure_allowed server/app/api/auth.py → 162: ensure_allowed(...), 163: _sign_in(...)]`
  Але акаунт, створений раніше, лишається: тестувальника могли прибрати з `AUTH_ALLOWED_EMAILS`, а його
  сесія скінчилася (30 днів, вихід, інший пристрій). Тоді `GET /me` дає 401 і людина бачить саме цей варіант,
  хоча рядок `users` з її email і щоденник на сервері є. Тому текст говорить лише про цей вхід.
- Той самий код приходить, коли Google не підтвердив email.

| Елемент | Текст |
|---|---|
| Тег | «Доступ за запрошенням» |
| H1 | «Поки що вхід — за запрошеннями» |
| Текст | «Цієї адреси Google немає в списку тестувальників, або Google не підтвердив її. Ви нічого не зробили не так. Новий акаунт не створено, і під час цього входу вашої адреси ми не записали.» Не «Акаунт не створено, і вашої адреси ми не зберегли»: це хибно для людини з наявним акаунтом (див. вище). Не «ми нічого не зберегли»: на цей колбек сервер пише технічні записи (рядок доступу й `not_invited` у журналі, `server/app/api/auth.py:165`), лише без адреси — це те саме абсолютне «нічого», що й у §3.7.8. |
| Текст 2 | «Коли доступ відкриється ширше, про це буде написано на головній сторінці.» Листа очікування й дат немає, тож ми їх і не обіцяємо. |
| Другорядна кнопка | «Увійти іншим акаунтом» — той самий `google/start?next=/chat/`. Вибір акаунта покаже сам Google (`prompt=select_account`). |
| Третинна дія | «-> На головну» |
| Блок допомоги (`.row__title`) | «Якщо ви прийшли, бо зараз важко». Текст: «Поговорити з людьми можна просто зараз:», далі 112, 103 і «Гарячі лінії «Ти як?»» ↗. Людина прийшла поговорити, а їй відмовили — тож сторінка мʼяко показує, куди йти далі [C]. |

**З сесією** (403 `not_invited` на `turn`, `summarize` чи `POST /summaries`):

| Елемент | Текст |
|---|---|
| Тег | «Доступ за запрошенням» |
| H1 | «Розмови з AI для вашого акаунта зараз закриті» |
| Текст | «Ви увійшли як {email} [A /me]. Цієї адреси зараз немає в списку тестувальників, тож розмови з AI і збереження в щоденник недоступні. Те, що вже збережено, на місці: щоденник можна завантажити або видалити разом з акаунтом.» |
| Якщо є транскрипт, неподане повідомлення (`pending`) або чернетка | «Останню дію не виконано. Текст розмови поки що на цій сторінці; якщо закрити її, він зникне.» Друга кнопка — «Скопіювати текст розмови» (або «Скопіювати тези», якщо була чернетка). Сам транскрипт — у `<details>` «Показати текст розмови», лише для читання; неподане повідомлення стоїть у ньому останнім, з міткою «Не надіслано», і потрапляє в копію як «Ви (не надіслано): …» (§2.3). |
| Основна кнопка | «Завантажити щоденник (.md)»: `<a href="/api/v1/export?format=md" download>` |
| Третинні дії | «-> Файл .json» · «-> Акаунт» (відкриває накладку) · «-> Вийти» |
| Блок допомоги | Як без сесії |

**Рішення:** транскрипт лишаємо на сторінці [C][P], а не стираємо [E]. Сервер відмовив у доступі, а
людина розмови не закривала. Стерти написане без її дії — зайва втрата.

### 3.5 `consent`: згода

**Дані з `GET /consents`** [A]:
- `{provider}` — `llm_provider.name` дослівно, наприклад «Ollama Cloud (Ollama Inc.)».
- `{country}` — з `llm_provider.country` [E]:
  1. мапа `{ US: 'США' }`;
  2. якщо коду там немає — `new Intl.DisplayNames(['uk'], {type: 'region'}).of(code)`;
  3. якщо й це не дало назви — сирий код.

  Мапа потрібна, бо `Intl` дає «Сполучені Штати», а лендінг пише «США».
  `[verified: node -e "…Intl.DisplayNames(['uk'],{type:'region'})…" → US=Сполучені Штати, DE=Німеччина, XX=XX]`
- `{version}` — з `current_policy_version`. Якщо рядок має вигляд `^\d{4}-\d{2}-\d{2}$`, форматуємо
  через `Intl.DateTimeFormat('uk', {day:'numeric', month:'long', year:'numeric'})` → «6 жовтня 2026 р.»
  `[verified: node -e … → 6 жовтня 2026 р.]`. Інакше показуємо як є [P].
- Якщо `llm_provider` немає, `name` — не рядок 1..200 символів або `country` після `trim` порожній чи
  довший за 64 символи, галочок згоди **не показуємо**: на передачу безіменному постачальнику чи постачальнику
  без країни погодитися не можна [P] (`transferAskable` у `core/state.ts`, і `consent/agree` теж). Сервер
  порожню країну не забороняє (`server/app/schemas.py:106-108`), тож вистачить порожнього
  `LLM_PROVIDER_COUNTRY` у prod-`.env`. Замість галочок:
  - постачальника немає або його дані не пройшли перевірку — «Не вдалося завантажити дані про
    постачальника AI, а без них погодитися неможливо.» і «Спробувати ще раз»;
  - назва є, країни немає — «Невідомо, у якій країні текст розмов обробляє постачальник AI, а без цього
    погодитися неможливо.» **без** «Спробувати ще раз»: дані завантажилися, а повторний `GET /consents`
    поверне те саме, бо країни немає в конфігурації сервера (`consent-no-country`).
- Поза цим шлюзом назва без країни лишається: `api.ts` віддає `{ name, country: '' }`, і сторінка називає
  постачальника всюди, де згадує. Чого бракує, те випадає зі сторінки разом зі своїм зворотом
  (`[data-provider="named" | "located"]`), а без назви стоїть «постачальник AI» / «постачальнику AI»
  (`[data-provider="unnamed"]`): жодних «Текст обробляє , .» чи «Передача тексту  — надано…».

**Розкладка:**
- одна текстова колонка 42rem, куля праворуч тиха;
- розділи — `.rows`;
- кнопка не sticky: спершу текст, потім галочки, потім дія [C];
- **шари** (фаза B, #19): кожен рядок — одне видиме речення; подробиці — під `<details class="more">`
  з власним `summary`, закриті наперед. Видимими лишаються завжди: «AI, не людина», «не терапія»,
  `{provider}, {country}`, `tel:112`, `tel:103` і гарячі лінії. Галочки згоди посилаються на «як описано
  вище» — текст під `<details>` теж вище, і людина може його відкрити до того, як погодиться.

| Елемент | Текст |
|---|---|
| Банер у режимі `update` або з `policyChanged` (і в `resume`, тоді — над банером `resume`) | «Умови щойно оновилися. Перегляньте, будь ласка, текст ще раз і підтвердьте.» |
| Банер у режимі `resume` | «Щоб продовжити, потрібна ваша згода. Розмова на місці — після згоди те, що ви почали, продовжиться само.» |
| Тег | «Перед розмовою». Коли згоди просить правка запису щоденника (`resume` з `patch`, §7.7), тега немає: людина не перед розмовою, і про те, що чекає, каже банер |
| H1 | «Що відбувається з тим, що ви напишете» |
| Лід | «Усе про ваші дані — на цьому екрані, окремого документа немає.» |
| Рядок 1, заголовок | «Ви говорите з AI» |
| Рядок 1, текст | «Відповідає штучний інтелект, а не людина, і він може помилятися або неточно зрозуміти вас.» |
| Рядок 2, заголовок | «Це не терапія» |
| Рядок 2, текст | «Liora — для саморефлексії: це не психологічна, не медична й не екстрена допомога, вона не ставить діагнозів і не лікує.» Окремим абзацом, завжди видимим: «Якщо вам зараз дуже важко — 112 або 103, цілодобово й безкоштовно, або гарячі лінії «Ти як?».» Посилання: `tel:112`, `tel:103` і `https://howareu.com/hot-lines` у новій вкладці з прихованим «(відкриється в новій вкладці)». |
| Рядок 3, заголовок | «Хто обробляє текст розмови» |
| Рядок 3, текст | «Відповіді й тези створює не наш сервер, а постачальник AI — {provider}, {country}.» |
| Рядок 3, `<details>` «Що саме йому передається» | «Щоб AI міг відповідати, йому щоразу передається текст усієї розмови. Для тез текст передається ще раз — разом із назвами тегів, які найчастіше трапляються у вашому щоденнику, щоб нові теги збігалися зі старими. У сценарії «Повернення до теми» постачальник отримує також назви, тези й теги записів, які ви оберете. Як довго постачальник зберігає ці дані, визначають його умови, а не Liora.» і другим абзацом «Наш сервер автоматично перевіряє текст на фрази, які можуть свідчити про кризу. У базу даних і журнали він текст розмови не записує.» |
| Рядок 4, заголовок | «Що зберігає Liora» |
| Рядок 4, текст (видимий) | «Повного тексту розмови на сервері Liora немає. Він живе на цій сторінці, поки вона відкрита.» |
| Рядок 4, `<details>` «Що саме зберігаємо» | Повний перелік з ADR-005, без слова «лише»:<br>• «Тези, які ви самі вирішите зберегти: назва, тези, теги.»<br>• «Ваш email та ідентифікатор Google-акаунта, дату реєстрації й останнього входу.»<br>• «Входи в акаунт: з якого застосунку, коли створено й коли востаннє використано. Ключ входу зберігаємо у вигляді, з якого його не відновити.»<br>• «Ваші згоди: яка саме, версія умов, коли дано й коли відкликано.»<br>• «Технічні журнали сервера без тексту розмов: який запит надійшов і коли, чим завершився, скільки тривав і скільки тексту обробив AI (у токенах). Замість вашого акаунта в них псевдонім. Журнали з часом перезаписуються.»<br>• «Після видалення акаунта — його номер і дата видалення, щоб видалення не скасувалося при відновленні даних із резервної копії.»<br>• «У вашому браузері — файл cookie сесії (скриптам сторінки він недоступний) і ваш вибір паузи анімації, теми та фону.» |
| Рядок 5, заголовок | «Як видалити» |
| Рядок 5, текст | «Акаунт разом з усім щоденником видаляється однією кнопкою в меню «Акаунт», без листів до нас.» Під `<details>` «Що ще там є»: «Там само можна завантажити щоденник у файл і відкликати будь-яку згоду.» Про видалення окремого запису тут не пишемо: екран згоди — про згоду, а сторінка щоденника (§7.7) показує це сама. |
| Легенда `<fieldset>` | «Ваша згода — окремо на кожен пункт» |
| `data_processing` | «Я погоджуюся, щоб Liora обробляла мої дані, як описано вище, і зберігала тези, які я вирішу зберегти.» |
| `llm_transfer` | «Я погоджуюся, щоб текст моїх розмов передавався постачальнику AI — {provider}, {country} — для відповідей і тез.» Без дужок навколо `{provider}`: значення з контракту вже має дужки («Ollama Cloud (Ollama Inc.)»). |
| `age_18` | «Мені виповнилося 18 років.» |
| Згода, вже дана для поточної версії | Галочка стоїть, поруч «(ви вже погодилися {дд.мм.рррр})» — дата з `granted_at` [A]. |
| Основна кнопка | «Погоджуюся — почати». У режимі `resume` — «Погоджуюся — продовжити». |
| Не всі три галочки (`role="alert"` під галочками) | «Позначте всі три пункти — без них розмова з AI неможлива.» Фокус іде на першу непозначену. |
| Помилка мережі, 5xx чи 422 (`role="alert"` під кнопкою) | «Не вдалося зберегти згоду. Спробуйте ще раз.» Позначки лишаються. |
| Третинна дія | «-> Не зараз» |
| Внизу, 13 px, `--color-text-dim` | «Версія умов від {version}» |

**«-> Не зараз»** [C] розкриває під кнопками блок:
- текст: «Без цих згод розмова з AI неможлива. Під час входу ми вже створили акаунт: зберегли ваш email та ідентифікатор Google. Якщо не хочете продовжувати, акаунт можна одразу видалити.»;
- кнопки:
  - небезпечна «Видалити акаунт» → `confirm(delete-account)` (§8.5);
  - другорядна «Вийти» (§8.4);
  - третинна «-> На головну».

**Рішення:** [C], а не тихий вихід [E] чи перехід на `/` [P]. Акаунт уже існує, і людина має про це
дізнатися й отримати спосіб його прибрати.

**Механіка:**
- **Кнопка завжди активна** [C][P][E]: неактивна кнопка не пояснює, чому вона неактивна.
- **Джерело даних.** У `first` після boot — `ctx.consents`. У `update` і `resume` — **завжди свіжий**
  `GET /consents` на вході: `ctx.consents` з boot застарів (там `missing = []` і стара версія), а
  `details.missing` з 403 на `POST /summaries` містить лише два види. Галочки, «(ви вже погодилися …)»,
  `{version}` і тіло POST беремо лише з цієї свіжої відповіді й кладемо її в `ctx.consents`.
- **Запит:** `POST /consents {policy_version: current_policy_version, kinds: missing}`. Якщо свіжий
  `missing = []`, POST не робимо (контракт: `kinds` 1..3, інакше 422) — у `resume` одразу повторюємо дію.
- **Нова версія умов посеред сесії.** 403 `consent_required` з `details.policy_version`, що відрізняється
  від версії в `ctx`, вмикає `policyChanged`: над банером `resume` стоїть банер «Умови щойно оновилися…».
  Це прапорець, а не режим: `mode='resume'` і `resume` лишаються, тож після згоди хід, тези чи збереження
  повторюються самі.
- **409 `policy_outdated`:**
  1. знову `GET /consents`;
  2. зняти всі галочки;
  3. `policyChanged = true` (банер «Умови щойно оновилися…»); у режимі `resume` `mode` і `resume` не
     скидаються, у `first` режим стає `update`;
  4. фокус на банер.
- **Повернення після зміни умов (boot).** Людина, яка погодилася на стару версію, після підвищення
  `current_policy_version` потрапляє в `consent(first)` без банера «Умови щойно оновилися…».
  **Відхилено:** знахідка пропонувала входити в `consent(update)`, «якщо в `granted` є записи зі старою
  `policy_version`». Таких записів у відповіді не буває: `_consent_state` вибирає лише
  `Consent.policy_version == settings.policy_version`, тож `granted` завжди про поточну версію, а старі
  згоди клієнт не бачить. `[verified: sed -n 58,100p server/app/api/account.py → .where(Consent.policy_version == settings.policy_version, …)]`
  Щоб відрізнити «вперше» від «умови змінилися», серверу треба віддавати попередні згоди — це поза
  контрактом. Екран `first` однаково показує повний текст і три порожні галочки, тож людина нічого не
  пропускає.
- **Без `<form>`.** Галочки — `<input type="checkbox">` у `<label>` на весь рядок, висота ≥ 56 px,
  розмір чекбокса 22 px [P]. Кнопка — `type="button"`.

  Причина: CSP має `form-action 'none'`, а нативний submit дав би `Origin: null` → 403 `csrf_failed`.

### 3.6 `chat`: нова розмова (жодного повідомлення людини)

**Рішення:** окремого екрана вибору сценарію немає [C].
- Сценарій обирають перемикачем над полем вводу; `free` обраний наперед.
- Це на екран менше, тож людина, що повертається, робить лише 3 дії.
- Окремий екран зі списком сценаріїв [P][E] відкинуто: це зайвий крок перед тим, як заговорити.

Щеплено від інших:
- описи сценаріїв — з клієнтського словника [P];
- `GET /summaries?limit=20` іде паралельно, щоб знати, чи доступне «Повернення до теми» [E].

**Desktop, текстова колонка згори вниз:**
1. Тегу «Нова розмова» немає (фаза B): заголовок екрана — легенда «З чого почнемо?» шрифтом Onest
   (`.scenarios__legend`). Прихований `h1`: «Розмова з AI».
2. Рядок `--color-light`, лише після кризи в цьому перегляді сторінки [E]: «Якщо важко — 112 або 103. Контакти завжди є вгорі: «Якщо важко».»
3. `<fieldset>` з легендою «З чого почнемо?».
   - Radio-пілюлі по 40 px; вибрана має бурштинову точку, як `.mark--on`.
   - Порядок і `title` — з `GET /scenarios` [A]; скільки їх прийде, стільки й пілюль.
4. Опис обраного сценарію — **одне речення** з клієнтського словника (таблиця нижче). Моно-рядка `.flow`
   («Тригер → реакція → інший погляд») більше немає.
5. Лише для `revisit` з уже обраними записами: «Ви повертаєтеся до: {назва 1}, {назва 2}» і «-> Змінити».
6. Транскрипт. Перша репліка — «AI» і `opening_message` обраного сценарію [A]. Поки людина нічого не
   надіслала, зміна сценарію замінює цю репліку.
6a. **Як почати** (`[data-el=starters]`, `role="group"`, `aria-label="Почати зі слів"`): три короткі
   кнопки-чипи на сценарій (`ui/copy.ts`, `starters(id)`). Чип **лише вставляє** свої слова в поле (через
   пробіл після вже написаного, курсор у кінець; фокус у поле — лише на `pointer: fine`, щоб на тачі не
   вискакувала клавіатура). Нічого не надсилається само; після першого повідомлення чипи зникають.
   Сценарій без списку чипів (новий сценарій сервера) показує лише чип «Як ви зараз?».
   Останній у тому ж ряду — чип «Як ви зараз?» (`.checkin`, зі значком): відкриває чек-ін (§3.13). Клас
   інший, ніж у `.starter`: він нічого не вставляє сам, слово йде в поле лише через «Додати до розмови».
7. Перемикач `role="switch"` «Не зберігати цю розмову». Підказка «Тези наприкінці можна буде переглянути, але не зберегти. Повного тексту розмови сервер Liora не зберігає в жодному разі.» більше не стоїть під ним: вона в toggletip ⓘ поруч (`popovertarget="nosave-tip"`, `aria-label` «Що означає «Не зберігати»»). Enter/пробіл відкриває, Esc і клік поза ним закривають, фокус лишається на ⓘ. Перемикач і без того має її описом (`aria-describedby="nosave-hint"`).
   - `<button type="button" role="switch" aria-checked>`; доступна назва — текст мітки.
   - Доріжка 44 × 24 px, радіус 999px. Вимкнено: рамка 1 px `--color-text-dim` (6.17:1 на `--color-bg`),
     фон прозорий, повзунок 16 px `--color-text-dim` ліворуч. Увімкнено: доріжка залита `--color-light`
     (13.1:1), повзунок `--color-bg` праворуч.
   - Стан передаємо не лише кольором: зсув повзунка + видимий моно-текст «Вимкнено» / «Увімкнено» поруч
     (`aria-hidden`, бо стан уже в `aria-checked`).
   - Уся мітка — зона влучання ≥ 44 px.
8. Композер (§3.7.3).

**Якщо `GET /scenarios` не вдався** (мережа, 5xx, порожнє тіло):
- нова розмова все одно відкривається, але лише зі сценарієм `free`: перша репліка — клієнтська копія
  `opening_message` з контракту, «Про що вам хочеться поговорити сьогодні?», а `title` — «Вільна розмова»;
- замість перемикача сценаріїв — рядок `--color-text-dim`: «Інші сценарії зараз не завантажилися.» і
  «-> Спробувати ще раз» (повторний `GET /scenarios`). Успіх повертає перемикач, поки людина нічого не
  надіслала; після першого повідомлення сценарій однаково не змінюється.

Припущення: беру фолбек «лише `free`» замість рядка помилки без композера, бо `/scenarios` — публічний
довідник, а людина прийшла поговорити; копія першої репліки — один рядок у `ui/copy.ts`. Якщо не так —
скажіть.

Праворуч — сцена з «AI · не людина».

**Телефон, згори вниз:**
1. Куля 160 px і «AI · не людина».
2. «З чого почнемо?».
3. Сценарії рядками, що переносяться, кожна пілюля ≥ 44 px, без горизонтального скролу.
4. Опис.
5. Перша репліка.
6. Чипи «як почати».
7. Перемикач з ⓘ.
8. Композер.

**Словник описів** (`ui/copy.ts`, ключ — `id`):

| `id` | `title` [A] | Опис (клієнт) |
|---|---|---|
| `free` | «Вільна розмова» | «Будь-яка тема: можна просто виговоритися, а AI ставитиме запитання.» |
| `situation` | «Розбір ситуації» | «Що сталося, що ви подумали й відчули — і як ще на це подивитися.» |
| `day` | «Розбір дня» | «Що було за день, що ви відчували і що з цього варте уваги.» |
| `revisit` | «Повернення до теми» | «Повернутися до теми зі щоденника: AI отримає тези, які ви оберете.» |
| `worry` | [A] | «Коли всередині неспокійно: назвати, що саме турбує, і що з цим у ваших руках.» |
| `hard_talk` | [A] | «Підготуватися до непростої розмови: що сказати, чого ви хочете і чого боїтеся.» |
| `gratitude` | [A] | «Помітити, що було добре — навіть дрібне — і що це для вас означає.» |
| `evening` | [A] | «Спокійно завершити день: що відпустити і з чим іти спати.» |
| Невідомий `id` | `title` [A] | `description` [A] — заради сумісності з майбутніми сценаріями |

`worry`, `hard_talk`, `gratitude`, `evening` — словник наперед: сервер їх ще не віддає, а щойно віддасть,
сторінка покаже їх з цими описами, чипами й плейсхолдерами без нового релізу. Описи, чипи й плейсхолдери
всіх восьми `id` проходять стоп-лист (тест #50).

**Чипи «як почати»** (`ui/copy.ts`, по три):

| `id` | Чипи |
|---|---|
| `free` | «Хочу виговоритися» · «Мене дещо зачепило» · «Не йде з голови» |
| `situation` | «Сьогодні сталося ось що:» · «Мене зачепили слова» · «Досі не можу відпустити» |
| `day` | «Найбільше сил забрало» · «Найкраще за день» · «Досі думаю про» |
| `revisit` | «Відтоді змінилося» · «Досі повертаюся до» · «Хочу глянути ще раз» |
| `worry` | «Мене турбує» · «Думки крутяться довкола» · «Найбільше боюся, що» |
| `hard_talk` | «Мені треба поговорити з» · «Хочу, щоб мене почули» · «Найважче буде сказати» |
| `gratitude` | «Сьогодні порадувало» · «Я ціную» · «Мені допомогло» |
| `evening` | «Сьогодні вдалося» · «Хочу відпустити» · «Завтра хочу» |

**Рішення:** словник [P], а не текст API як є [C][E]. Серверний опис `situation` — «Тригер → реакція →
альтернативний погляд (техніка з КПТ).» КПТ — це метод психотерапії, і людина побачила б його одразу
після слів «не терапія». Правку на сервері рекомендуємо (§1.3), але від неї клієнт не залежить.

**`opening_message`.** Усі три дизайни згодні: показуємо його першою реплікою AI і **надсилаємо** першим
елементом `messages` як `{role:"assistant"}`.
- Людина відповідає саме на це запитання.
- Схема дозволяє будь-яку першу роль, головне — щоб остання була `user`.
- Як на це реагує модель — `[unverified]`. Перевірити одним ходом на локальному стеку з fake і з
  реальною моделлю. Рішення записати в ADR-007.

**«Повернення до теми».**
- **Щоденник порожній** (`GET /summaries?limit=20` → `items: []`):
  - замість опису: «Тут можна повернутися до тем зі щоденника. Поки що в ньому немає записів — вони зʼявляться, коли ви збережете тези після розмови.»;
  - композер ховається, на його місці «-> Почати вільну розмову», що обирає `free` [C].
- **Не вдалося завантажити щоденник:** «Не вдалося завантажити збережені тези.» і «-> Спробувати ще раз».
- **Щоденник не порожній:** вибір radio `revisit` **не відкриває** накладку. Він лише показує опис і
  третинну кнопку «-> Обрати записи» (`aria-haspopup="dialog"`); накладку `revisit-pick` відкриває ця
  кнопка. Причина — WCAG 3.2.2: у групі radio стрілки змінюють вибір миттєво, і ← з `free` переводить на
  `revisit`, тож модалка на виборі не дала б пройти групу клавіатурою.
- Поки записи не обрано, композер видно, але `canSend = false`; натиск «Надіслати» показує під полем
  `role="status"`: «Спершу оберіть записи, до яких повернутися.» Тіло з `scenario: 'revisit'` і порожнім
  `revisit_summary_ids` не йде ніколи (контракт: непорожні тоді й лише тоді, коли `revisit`).

| Елемент `revisit-pick` | Текст і поведінка |
|---|---|
| H2 | «До яких записів повернутися?» |
| Текст | «Оберіть від 1 до 5. Їхні назви, тези й теги AI отримає разом із розмовою — а отже, і постачальник AI, як сказано в згоді.» |
| Пошук | Лише коли в першій сторінці є `next_cursor`. Мітка «Пошук у щоденнику», плейсхолдер «Слово з назви чи тези». Поле — Onest 16 px, рамка 1 px `--color-text-dim` (як усі поля, §3.7.3). Запит `GET /summaries?q={q}&limit=20` з debounce 300 мс [P]. Порожній результат: «За запитом «{q}» нічого не знайшлося.» (`{q}` — лише через `textContent`). |
| Рядок списку | `<label>` з чекбоксом. Назва — Onest 600 17 px. Дата `дд.мм` і теги `#сон #робота` — моно 11 px `--color-text-muted`. Перша теза — `--color-text-soft`, обрізана до двох рядків. |
| Ще | «-> Показати ще» (`next_cursor`) |
| Лічильник | «Обрано {n} з 5». Після 5-го решта чекбоксів `disabled`, поруч видимий текст «Можна обрати до 5.» |
| Кнопки | Основна «Продовжити ({n})». Якщо `n = 0` — `role="alert"` «Оберіть хоча б один запис.». Третинна «Скасувати». |
| Закриття без «Продовжити» (до першого повідомлення) | «Скасувати», Esc і «Закрити» працюють однаково: обрані до відкриття записи лишаються як були. Якщо записів ще не було, вибір повертається на попередній сценарій. Стан «`revisit` без id» після закриття неможливий. |
| 404 на ході | Накладка відкривається знову зі списком, завантаженим заново, і банером «Одного з обраних записів уже немає в щоденнику. Оберіть, будь ласка, ще раз.» Транскрипт не чіпаємо. Після «Продовжити» той самий хід іде знову з новими id. |
| Закриття після 404 (розмова вже йде) | Сценарій **лишається** `revisit` — після першого повідомлення його не змінюємо (§2.4). Повідомлення людини стоїть з міткою «Не надіслано» і «-> Обрати записи» · «-> Змінити». |
| 404, і записів у щоденнику вже немає | Накладку не відкриваємо. Замість композера — блок: «Записів, до яких ви поверталися, у щоденнику вже немає.» Кнопки: основна «Підсумувати» → `summarizing` (тіло без `revisit_summary_ids`) · другорядна «Завершити без тез» → `confirm(end-no-theses)`. Якщо 404 прийшов на першому ході і відповіді AI ще немає, замість «Підсумувати» — «-> Почати вільну розмову»: сценарій стає `free`, перша репліка — його `opening_message`, а текст неподаного повідомлення повертається в поле вводу. |

**Рішення (404):** [C][E], а не перевірка кожного id через `GET /summaries/{id}` [P]. Так простіше, а
запис видаляють посеред розмови рідко.

**Режим «не зберігати».**

**Рішення:** перемикач робимо [C], а не відмовляємося від нього [P]. Вирішальне:
- ADR-005 визначає режим як «клієнт цей виклик (`POST /summaries`) не робить»;
- лендінг обіцяє: «Режим «не зберігати» … вмикається перед сесією».

Без перемикача обидва тексти стали б неправдою. Ціна — одне поле в `Session` і два варіанти тексту.

Як працює:
- перемикач видно, поки людина нічого не надіслала;
- далі режим стає міткою « · Не зберігати» в рядку сесії;
- при новій розмові він скидається;
- ніде не записується.

**Фокус:**
- desktop (`pointer: fine`) — у полі вводу;
- тач (`pointer: coarse`) — на прихований `h1`, без автофокусу поля. Клавіатура закрила б рядок «AI,
  не людина» ще до того, як людина його прочитала [C][P].

### 3.7 `chat`: розмова

#### 3.7.1 Рядок сесії

**Розміри й фон:**
- `position: sticky`, `top` — висота шапки;
- висота 52 px, нижня лінія `--color-line`;
- фон — той самий градієнт, що в `.site-header::before`.

**Ліворуч** (фаза B — один рядок замість двох моно-рядків):
- на телефоні — мала куля 32 px (`.orb--mini`) з повільним пульсом ядра (лише з рухом); на desktop її
  немає — там велика куля праворуч;
- Onest 15 px: **{title сценарію}** (600, `--color-text`) · «AI, не людина» (`--color-ai`), у режимі «не
  зберігати» — ще « · Не зберігати». Роздільник « · » — `aria-hidden`; «AI, не людина» і «Не зберігати»
  ніколи не розриваються (`.keep`, `white-space: nowrap`);
- на телефоні — два рядки: назва сценарію, під нею «AI, не людина · Не зберігати»;
- **на desktop (≥ 64em) «AI, не людина» в рядку сесії немає** (фаза C3): там його вже кажуть мітка «AI · не
  людина» під великою кулею праворуч і рядок під полем (§3.7.3), а третій повтор у ста пікселях від них був
  шумом. На телефоні великої кулі в розмові немає, тож рядок сесії — єдине місце біля кулі, де це сказано, і
  він лишається. G2 тримається на обох ширинах: «AI» на кожній відповіді, «AI · не людина» біля кулі,
  «AI, не людина · може помилятися · не терапія» під полем (#94);
- «не терапія» тепер не тут, а в рядку під полем (§3.7.3), що видно завжди, поки є поле.

**Праворуч:**
- другорядна пілюля 40 px «Завершити розмову» (на телефоні — «Завершити»);
- зʼявляється після першої завершеної відповіді AI на повідомлення людини;
- у кризі її немає.

#### 3.7.2 Транскрипт

**Розмітка:**
- `<ol class="talk" aria-label="Розмова">` у `<section>`;
- **без** `role="log"` і `aria-live` — інакше кожен токен звучав би окремо [C][P][E].

**Репліка** — `<li class="said said--ai|said--you">` (фаза B — бульбашки):
- **AI** — ліворуч, на всю колонку: над текстом мала куля 22 px (`.said__mark`, `aria-hidden`; поки
  відповідь чекає — ядро дихає) і мітка «AI» (`.said__who`, справжній текст, `--color-ai`, моно) —
  **на кожній** відповіді, і на першій репліці теж (G2);
- **людина** — праворуч, у мʼякій бульбашці: `--color-bubble-you` (світла тема — `#dce9e4`, фаза C3: було
  `#e6efec`, і на папері бульбашка майже зникала), рамка 1 px `--color-bubble-line` (бірюза 20 % / 12 %),
  радіус 1.25rem з меншим кутом знизу праворуч, `max-width: min(34rem, 85%)`. Текст `--color-text-dim` на ній
  ≥ 4.5:1 (світла 5.00:1); рамка — декор, не межа елемента керування, тож 1.4.11 до неї не застосовується. Мітка «Ви» — лише для скрінрідера (visually-hidden);
- текст:
  - Onest `--step-0` / 1.6;
  - **і AI, і людина — `--color-text`**: голос AI тримають мітка «AI» і куля, а не бірюзові абзаци;
  - `max-width: 38rem` (~64 знаки);
  - `white-space: pre-wrap; overflow-wrap: anywhere`;
  - абзаци ділимо за `\n\n` на окремі `<p>` з проміжком 0.75em [P];
  - Markdown не рендеримо.
- **під реплікою** (`.said__meta`): час `HH:MM` (`<time datetime>`, `Intl` `uk`, `--color-text-dim`) і, під
  відповіддю AI, дві дії: «Копіювати» і «→ У тези». Час — з `Session.times` (паралельно до `messages`): для повідомлення —
  мить натиску «Надіслати» (і повтор «Надіслати ще раз» її не міняє), для відповіді — мить `done`; перша
  репліка часу не має. Час живе лише в памʼяті вкладки, як і текст;
- **«Копіювати»** копіює одну відповідь, з номером на паузі, заміненим так само, як на екрані
  (`maskPausedLine`). Підпис на 2 с стає «Скопійовано» (або «Не вдалося скопіювати»), і те саме каже
  live-регіон. На `pointer: fine` кнопка зʼявляється при наведенні на репліку або з фокусом у ній (з Tab не
  ховається), на тачі стоїть завжди. У read-only копіях (криза, `session-expired`, `not-invited`) рядка
  `.said__meta` немає взагалі.
- **Назви дій** (фаза C3): спершу видимі слова (WCAG 2.5.3), далі прихований хвіст `.said__which` — котра
  відповідь: «Копіювати відповідь 2, 23:10», «У тези відповідь 2, 23:10». Номер — серед відповідей AI (перша
  репліка не рахується), час — бо дві відповіді часто мають одну хвилину. Список кнопок скрінрідера більше не
  складається з десяти однакових «Копіювати» (#88). На «Скопійовано» міняється лише видиме слово.
- **«→ У тези»** — перемикач (`aria-pressed`), іконка «→|», натиснутий — галочка й `--color-ai`, і він видно
  завжди, не лише з наведенням (стан не лише кольором: іконка інша). Позначка — це індекс відповіді в
  `Session.marks` (лише памʼять вкладки, як і текст; не йде ні в `/chat/turn`, ні в `/chat/summarize`). Не
  більше 5 (`MAX_MARKS` = `MAX_BULLETS`): шоста не ставиться, live-регіон каже «У тезах уже 5 з 5. Щоб
  додати цю, приберіть іншу.». Кожна зміна озвучується: «Додано до тез · 2 з 5» / «Прибрано з тез · 1 з 5»
  (натиснутий стан озвучують не всі скрінрідери). Позначки переживають «Підсумувати» → «Повернутися до
  розмови», забуваються з новою розмовою; у кризі й у read-only копіях дій немає. Позначені відповіді
  чекають на `review` (§7.2).

**Ритм** [P]:
- між реплікою людини й відповіддю — 1rem;
- від відповіді до наступної репліки людини — 1.75rem;
- аватарів і «прочитано» немає.

**Статус під повідомленням людини:**
- моно 11 px `--color-light`: «Не надіслано» або «Відповідь зупинено»;
- під ним — речення Onest 15 px `--color-text-soft` з §4;
- дії `.arrows`: «-> Надіслати ще раз» · «-> Змінити». «Змінити» повертає текст у поле вводу й
  прибирає репліку.

**Обрізана відповідь** (`finish_reason === "length"`): під реплікою AI моно 11 px dim — «Відповідь
обрізано за довжиною.» [E]

#### 3.7.3 Композер

**Рішення:** композер [P].

**Контейнер:**
- `<div class="composer">`, **без `<form>`**;
- `position: sticky; bottom: var(--kb, 0px)`, ширина текстової колонки (`--kb` — §3.1 «Екранна
  клавіатура»);
- над ним — 32 px градієнта (градієнт шапки, перевернутий);
- поля:
  - desktop — `0.75rem 0 1.25rem`;
  - телефон — `0.5rem 16px calc(0.5rem + env(safe-area-inset-bottom))`; з `html[data-kb]` — без
    `safe-area`.

**Мітка поля** — `<label class="visually-hidden">`: «Ваше повідомлення для AI».

**`<textarea>`:**
- `rows="1"`, `autocomplete="off"`, **без** `maxlength`: він мовчки обрізав би вставлений текст [E];
- шрифт — Onest 17 px (1.0625rem) / 1.5. Не менше 16 px, щоб iOS не масштабував сторінку;
- поля — `14px 60px 14px 18px`;
- висота:
  - мінімум 56 px (на телефоні 52 px): один рядок — це 25.5 + 2 × 14 + 2 = 55.5 px (на телефоні 51.5),
    і кнопка 44 px стоїть рівно посередині;
  - максимум `min(40svh, 15rem)` (на телефоні `min(30svh, 140px)`), далі скрол усередині;
  - росте через `field-sizing: content`, де його немає — JS за `scrollHeight`;
- вигляд (фаза B — «пілюля»):
  - рамка 1 px `--color-field-border`, радіус `--radius-pill` (1.5rem), фон `--color-surface`, мʼяка тінь
    `--color-field-shadow`; без `backdrop-filter`;
  - у фокусі рамка стає `--color-focus` і подвоюється до 2 px (`box-shadow: 0 0 0 1px`) — одна спокійна
    лінія замість кільця навколо кільця;
  - поля `14px 60px 14px 58px`: ліворуч у полі — кнопка «Інструменти», праворуч — «Надіслати».
- **«Інструменти»** (`+`, 44 × 44, `aria-label="Інструменти"`, `popovertarget="composer-tools"`): меню з
  чотирьох пунктів — «Подихати хвилину», «Заземлення 5-4-3-2-1», «Як ви зараз?», «В укритті» (фаза C,
  §3.13; `aria-haspopup="dialog"`). Пункт спершу закриває меню й віддає фокус «Інструментам», тоді
  відкриває діалог; закритий діалог повертає фокус на «Інструменти». Розмова від цього не починається.
  «Інструменти» стоїть ліворуч у полі, тож і в DOM — **перед** `<textarea>`, а його меню одразу за ним: Tab
  іде зліва направо («Інструменти» → поле → «Надіслати»), Shift+Tab із поля — на «Інструменти» (фаза C3, #93).
- **Чому не `--color-line-strong`** (WCAG 1.4.11, межа поля ≥ 3:1): `rgb(238 242 238 / 0.26)` дає лише
  2.05:1 на `--color-bg` і 2.21:1 на найсвітлішому небі `#0d2226`. `--color-text-dim` дає 6.17:1 і 5.04:1,
  і новий колір не потрібен. `[verified: node -e "…WCAG relative luminance…" → line-strong on bg 2.05, on sky 2.21; dim on bg 6.17, on sky 5.04]`
- Те саме правило — для **всіх** текстових полів `/chat/`: назва й тези в `review`, новий тег, пошук у
  `revisit-pick`. Кнопки з текстом лишаються з `--color-line-strong`: їх ідентифікує напис, і 1.4.11 до
  їхньої рамки не застосовується.
- **Правило `--color-line-strong`** (аудит 1.4.11, фаза C3, обидві теми): рамку під 3:1 лишаємо лише там, де
  елемент керування ідентифікує напис чи іконка ≥ 3:1 (другорядні кнопки, «Акаунт», «Вигляд», «×» у тезах і
  тегах, «Закрити» аркушів, пілюлі неба). Поля так не рахуються: їхня рамка — це їхня форма, і вона
  `--color-field-border`. Єдиним елементом без слів і без рамки ≥ 3:1 був повзунок класичної смуги
  прокрутки: тепер `scrollbar-color: var(--color-field-border) transparent` (#96, #97).

**Плейсхолдер** (`--color-text-dim`):

| Коли | Текст |
|---|---|
| До першого повідомлення, `free` | «Пишіть так, як думаєте…» |
| До першого повідомлення, `situation` | «Що сталося?» |
| До першого повідомлення, `day` | «Як минув день?» |
| До першого повідомлення, `revisit` | «Що змінилося?» |
| До першого повідомлення, `worry` / `hard_talk` / `gratitude` / `evening` | «Що зараз турбує?» / «З ким ця розмова?» / «Що сьогодні було добре?» / «Що зараз на думці?» |
| Далі | «Ваша відповідь…» |

**Кнопка** 44 × 44 у правому нижньому куті поля, відступ 6 px (на телефоні 4 px) справа й знизу — у
однорядковому полі це однаково зверху й знизу; 8 px в однорядкове поле не вміщаються:

| Стан | Вигляд | `aria-label` |
|---|---|---|
| Поле порожнє або лише пробіли | Коло `rgb(238 242 238 / 0.08)`, стрілка ↑ `--color-text-dim`; `aria-disabled="true"` | «Надіслати» |
| Є текст | Заповнене `--color-light`, стрілка `--color-bg` | «Надіслати» |
| Чекаємо або йде відповідь | Контур `--color-line-strong`, квадрат ■ `--color-text` | «Зупинити відповідь» |

- На `pointerdown` кнопка робить `preventDefault`, тож на тачі фокус лишається в полі [P].

**Клавіші:**
- `pointer: fine`: Enter надсилає, Shift+Enter переносить рядок, `enterkeyhint="send"`;
- `pointer: coarse`: Enter переносить рядок, надсилає лише кнопка, `enterkeyhint="enter"`;
- Ctrl/Cmd+Enter надсилає завжди [C];
- під час IME-композиції (`isComposing` або `keyCode === 229`) Enter не надсилає [P][E];
- поки йде відповідь, Enter нічого не надсилає і не зупиняє. Наступне повідомлення можна писати, а
  надіслати — після `done` [P].

**Під полем.**

**Рішення:** моно-мітка про AI [P] і повне речення про збереження [C]. Розкриття «це AI» говорить мовою
міток лендінгу. Обіцянку щодо збереження людина має зрозуміти до того, як закриє вкладку, тому вона —
окремим реченням.

Фаза B — **один рядок і ⓘ**:
- видимий рядок (Onest 13 px `--color-text-dim`): «AI, не людина · може помилятися · не терапія», поруч
  кнопка ⓘ «Про цю розмову» (`popovertarget="composer-tip"`) і лічильник;
- у toggletip `#composer-tip` — повне речення `#composer-note`: «Liora не зберігає цю розмову: якщо
  закрити чи оновити сторінку, текст зникне. Текст обробляє {provider}, {country}.» і клавіші «Enter —
  надіслати · Shift+Enter — новий рядок». Речення однакове на всіх ширинах (короткої телефонної версії
  більше немає) і завжди є описом поля (`aria-describedby="composer-note"`), відкрите воно чи ні;
- **до першого повідомлення на desktop** (`html[data-talk='off']`, ≥ 64em) речення стоїть просто під
  рядком, без ⓘ: людина читає обіцянку до того, як почне писати. Далі — лише через ⓘ.

Без поля (порожній щоденник у «Повернення до теми», блок замість композера) рядок 1 не зникає разом із
ним: внизу екрана стоїть його копія `[data-el="chat-ai"]`, і екран завжди каже, з ким розмова. Без країни
речення рядка 2 закінчується назвою, без назви — «Текст обробляє постачальник AI.» (§3.5).

**Довжина повідомлення.** Рахуємо **кодові точки** (`[...text].length`) [E], як рахує сервер.
Лічильник `.length` у UTF-16 [C][P] заблокував би 2001 емодзі як «задовгий» текст.
- Від 3 500 — лічильник праворуч у рядку 1: «3 812 / 4 000».
- Понад 4 000:
  - лічильник `--color-light`;
  - `role="status"`: «Повідомлення задовге: {n} із 4 000 символів. Розділіть його на два.»;
  - кнопка `aria-disabled`, натиск лише повторює підказку.

#### 3.7.4 Очікування і стрім

Слот відповіді зʼявляється одразу під повідомленням людини: мала куля і «AI», під ними — три крапки й
мітка стану (`.said__wait`, `--color-text-muted`, `aria-hidden`). З рухом крапки зʼявляються лише через
300 мс (швидка відповідь не блимає індикатором) і повільно пульсують; без руху стоять.

**Номер на паузі в стрімі.** Хвіст тексту, що росте, який може бути початком номера, не показуємо,
доки за ним не прийде щось інше (або `done`). Хвіст читаємо так само широко, як маска §6.3: цифри
будь-якого письма (повноширинні, надрядкові, у колі…), кирилична «З»/«з» замість 3, позначки на
цифрі (keycap, закреслення) і все, що маска вважає роздільником груп, — пробіли, дужки, «+», дефіси
й тире, крапки, невидимі символи форматування (`NUMBER_TAIL` у `src/chat/ui/transcript.ts`, шукаємо
в останніх 96 символах). Так номер, розрізаний між токенами, не мигне на екрані жодною своєю
частиною до маскування; ціна — кінцеве «112.» зʼявляється на токен пізніше.

**Рішення:** фазові мітки [P], а не одна мітка за часом [C]. До заголовків відповіді сервер може чекати
вільний LLM-слот до 20 с, і чесний текст про чергу тут краще за 20 с тиші.

| Фаза | Час | Мітка |
|---|---|---|
| До заголовків (можлива черга до слота) | 0–6 с | «Думає». Світна крапка «дихає» з рухом і просто горить без руху. |
| | 6–12 с | «Думає довше, ніж зазвичай» |
| | 12–35 с | «Сервер AI зайнятий — чекаємо черги, до 20 с» |
| | понад 35 с | Хід не вдався: «Відповідь не прийшла.» і «-> Надіслати ще раз» |
| Прийшов `meta`, токенів ще немає | 0–8 с | «Думає» |
| | понад 8 с | «Думає довше, ніж зазвичай». Про чергу не пишемо: слот уже наш. |
| | 45 с без жодного байта | Обрив, далі за §5.5 |
| Ідуть токени | — | Текст росте в репліці AI, з рухом нові слова проявляються (§3.1). Каретка — смужка 2 px × 1em `--color-ai`, **не блимає** (WCAG 2.2.2), після `done` гасне за 200 мс (transition). Без руху світіння немає й гасне вона одразу [P]. |

#### 3.7.5 «Зупинити»

1. Натиск викликає `AbortController.abort()`: сервер звільняє слот і нічого не зберігає.
2. Часткову відповідь прибираємо.
3. Під повідомленням людини — «Відповідь зупинено.» і «-> Надіслати ще раз» · «-> Змінити».
4. Не пишемо «скасовано, ніхто не побачив»: те, що пішло на сервер, уже пішло [C].

**Рішення:** часткову відповідь прибираємо [C][E], а не лишаємо з міткою «Зупинено» в історії [P]:
- одне правило I3 для всіх обривів;
- модель не бачить свою обірвану фразу;
- контракт так само вимагає відкидати часткову відповідь при `error` і `crisis`.

#### 3.7.6 Скрол: «якір надсилання»

**Рішення:** якір [P], а не «автоскрол, якщо людина внизу» [C][E]. Під час стріму сторінка не смикається,
і якір працює зі скролом документа.

- **Після надсилання:** репліка людини прокручується наверх (`scrollIntoView({block: 'start'})`). Відступ
  від шапки й рядка сесії дає `scroll-padding-top` на `html` (§3.1), плюс `scroll-margin-top: 0.5rem` на
  репліці.
- **Місце під відповідь:** остання пара реплік отримує
  `min-height: calc(100svh - var(--header-h) - var(--session-h) - var(--composer-h) - 2rem)`, тож відповідь росте
  в порожнє місце.
  - `--composer-h` міряє `ResizeObserver`, а записує `style.setProperty` (CSSOM, CSP це дозволяє).
- **Плавність:** плавно — лише коли рух дозволено, інакше миттєво.
- **Коли** (фаза C3): скрол і вимір кімнати — у мікрозадачі після всього рендеру, а не посеред нього. Перше
  повідомлення в тому самому рендері ховає слот кулі на телефоні, стартери й речення під полем; виміряний
  раніше, якір брав старий композер, сторінка потім коротшала, і миттєвий скрол зупинявся коротше — перша
  репліка лишалася наполовину в згасанні. З тієї ж причини `.talk` і `.said` мають `transition-property:
  none`: правило `prefers-reduced-motion` у `base.css` дає кожній властивості перехід 0.01 мс, і відступ
  кінця розмови та кімната відповіді діставали свій розмір кадром пізніше (#93b).
- **Якщо відповідь виросла нижче видимої області,** за нею не йдемо. Над композером зʼявляється пілюля:
  - текст «↓ Далі відповідь», після `done` — «↓ До кінця»;
  - 36 px, моно 11 px, лінія `--color-line-strong`, фон `rgb(4 8 9 / 0.82)`;
  - доступна назва — сам видимий текст («Далі відповідь» / «До кінця»), стрілка `aria-hidden`, окремого
    `aria-label` немає: назва мусить містити видимий підпис, інакше голосова команда «натиснути Далі
    відповідь» не спрацює (WCAG 2.5.3);
  - стрибок миттєвий (`behavior: 'instant'`), навіть коли рух дозволено: інакше пілюля ховалася б
    пізніше, під фокусом, який на ній стояв;
  - ховається, щойно низ транскрипту видно. Якщо фокус був на ній, він переходить у поле (з клавіатури)
    або на `h1` екрана (дотик), а не на `body` (I6).
- **Якщо людина сама прокрутила вгору,** нічого не рухаємо.

#### 3.7.7 Межі розмови

`canSend` дорівнює `messages.length + 2 ≤ 200`: так після відповіді ще влізе й `summarize`, у якого теж
≤ 200 повідомлень [C][E]. З `opening_message` останнє «Надіслати» можливе при довжині 197.

| Поріг | Що бачить людина |
|---|---|
| `messages.length ≥ 180` | Рядок над композером, `--color-text-dim`: «Розмова вже довга. Ще кілька повідомлень — і її варто буде підсумувати.» |
| `canSend = false` | Замість композера блок: «Ця розмова досягла межі довжини. Підсумуйте її — або завершіть і почніть нову.» Кнопки: основна «Підсумувати» → `summarizing`, другорядна «Завершити без тез» → `confirm(end-no-theses)`. |
| Сума `content` > 24 000 кодових точок (один раз) | Рядок над композером: «Розмова довга: найперші репліки AI вже може не враховувати.» Сервер обрізає найстаріше понад 24 000 лише для моделі [P]. |
| 413 | §4 |

**Нагадування про паузу** (фаза C3). Один тихий рядок над полем — через **40 хвилин** від першого
надісланого повідомлення (`Session.times`) або на **60 репліках** (`messages.length − 1`, перша репліка AI не
рахується), що настане раніше:

| Причина | Текст (`role="status"`, рендериться порожнім, §5.7) |
|---|---|
| 40 хвилин | «Ви тут уже 40 хвилин. Можна зробити паузу або зібрати тези.» |
| 60 реплік | «У розмові вже 60 реплік. Можна зробити паузу або зібрати тези.» |

- Під ним — третинні «-> Зібрати тези» (→ `confirm(end)`, той самий діалог, що каже про повторну передачу
  тексту; фокус після закриття — на «Завершити розмову») і «-> Сховати». Обидві прибирають рядок **назавжди
  для цієї розмови** (`Session.pause`: `none` → `time`/`count` → `hidden`); нова розмова рахує заново.
- Нічого не блокує: поле, «Надіслати» й фокус лишаються; рядок не модальний, без таймера на зникнення, без
  похвали й лічильників. Поки йде відповідь, «Зібрати тези» `aria-disabled`, а сам рядок зʼявляється лише між
  відповідями (з `done` чи з таймера, коли хід `idle`/`cooldown`).
- Таймер — **один** `setTimeout` на мить `pauseAt(session)`, ніколи не по одному на рендер; знімається в
  `leave()` екрана (щоденник, тези, криза) і ставиться знову, коли розмова повертається. У кризі та після неї
  рядка немає (#89–#91).
- Рядок стоїть у липкому композері й робить його вищим догори. Якщо кінець розмови був видно, сторінка
  в ту саму мить піднімається рівно на висоту рядка (`anchor.hold()`, миттєво — не плавно, щоб кінець не
  встиг зникнути під ним): кінець відповіді лишається над полем з тим самим відступом, пілюля «↓» не зʼявляється.
  Прокрутили вгору — нічого не рухається; фокус не змінюється ніколи (ревʼю C3: на 320 × 640 останні рядки
  відповіді й «↓ До кінця» опинялися під ним, #100, #100b).
- Подвійний клік: друге натискання того самого подвійного кліку, що влучає туди, де щойно була «Зібрати тези»
  (на телефоні там кнопки `confirm`), не натискає нічого й не зсуває фокус (I10, #101).

#### 3.7.8 Діалог «Завершити розмову?» (`confirm(end)`)

| Елемент | Текст |
|---|---|
| H2 | «Завершити розмову?» |
| Текст | «AI запропонує 3–5 коротких тез. Ви переглянете їх, виправите, якщо треба, і самі вирішите: зберегти в щоденник чи видалити.» |
| Якщо від людини менше 2 повідомлень | «Розмова ще коротка, тож тези можуть вийти загальними.» |
| Режим «не зберігати» | «Увімкнено «не зберігати»: тези можна переглянути, але не зберегти.» |
| Дрібно, `--color-text-dim` | «Для тез текст розмови ще раз передається постачальнику AI — разом із назвами ваших найчастіших тегів.» |
| Кнопки | Основна «Підсумувати». Другорядна «Завершити без тез». Третинна «-> Повернутися до розмови» (те саме, що Esc). |

«Завершити без тез» перемикає вміст того самого діалогу (`confirm(end-no-theses)`) [E]:

| Елемент | Текст |
|---|---|
| H2 | «Завершити без тез?» |
| Текст | «Текст розмови зникне з цієї сторінки. Ні тексту, ні тез у Liora не залишиться — лише технічні записи без тексту, про які сказано на екрані згоди. Скасувати це не можна.» |
| Кнопки | Небезпечна «Завершити» → `ended`. Другорядна «Назад» (стартовий фокус). |

Чому не «нічого не залишиться»: сервер на кожен запит пише технічний рядок — метод, маршрут, статус, час,
псевдонім користувача й кількість токенів (рядок 4 екрана згоди). Обіцянка «нічого» порушила б правило
«не обіцяти нульового зберігання». `[verified: sed -n 1,10p server/app/logging.py → «What is logged: method, route template, status, latency, request id, a pseudonymous user hash and LLM token counts»]`

**Рішення:** діалог перед підсумком [C][E], а не прямий перехід до підсумку [P]. «Завершити без тез»
дозволяє не передавати текст постачальнику вдруге, і людина має знати про це до натискання.

### 3.8 `session-expired` (401 посеред розмови)

**Що на екрані:**
- транскрипт лишається видимим, лише для читання;
- композер замінює блок [C]. [E] тут ставив окремий екран, [P] — діалог.

| Елемент | Текст |
|---|---|
| Мітка (моно, `--color-light`) | «Вхід завершився» |
| Текст | «Вхід в акаунт завершився — наприклад, ви вийшли в іншій вкладці. Увійти знову можна, але сторінка перезавантажиться, і ця розмова зникне: Liora її не зберігає.» |
| Другорядна кнопка | «Скопіювати текст розмови». Під час перегляду тез — «Скопіювати тези». Після копіювання на 2 с: «Скопійовано»; якщо буфер обміну відмовив — «Не вдалося скопіювати», а live-регіон каже «Не вдалося скопіювати. Виділіть текст розмови вручну.» (для тез — «… Виділіть тези вручну.», §5.7). |
| Основна кнопка | «Увійти знову» → `confirm(relogin)` |
| Неподане повідомлення | Якщо 401 прийшов на хід, текст людини (`pending`) стоїть останньою реплікою транскрипту з моно-міткою «Не надіслано» і є в копії (§2.3). Без цього зникло б саме те, що людина щойно написала. |

`confirm(relogin)`:
- H2 «Увійти знову?», текст «Текст цієї розмови зникне зі сторінки.»;
- кнопки «Увійти» · «Залишитися»;
- після «Увійти» знімаємо `beforeunload` і переходимо на `google/start?next=/chat/`.

**Формат копії** [P]:
- перший рядок — «Liora · розмова з AI · {7 жовтня 2026}»;
- далі репліки «AI: …» / «Ви: …» через порожній рядок;
- неподане повідомлення (`pending`), якщо є, — останнім: «Ви (не надіслано): …»;
- `navigator.clipboard.writeText` — лише на явний натиск.

### 3.9 `fatal`: немає зʼєднання під час завантаження

| Елемент | Текст |
|---|---|
| Тег | «Немає зʼєднання» |
| H1 | «Не вдалося зʼєднатися з Liora» |
| Текст за замовчуванням | «Сервер не відповідає. Перевірте інтернет або спробуйте за хвилину.» |
| Текст, якщо `navigator.onLine === false` | «Схоже, немає інтернету. Коли зʼєднання повернеться, спробуйте ще раз.» |
| Текст 2 | «Розмова ще не почалася — нічого не втрачено.» [E] |
| Кнопки | Основна «Спробувати ще раз» → `booting`. Третинна «-> На головну». |
| Рядок допомоги | «Якщо вам зараз дуже важко — 112 або 103. Ці номери працюють і без інтернету.» |

### 3.10 Інші екрани

- `summarizing`, `review`, `saved`, `ended` — §7.
- `crisis` — §6.
- Меню акаунта і `account-deleted` — §8.

### 3.11 Діалог `help` («Якщо важко» з шапки)

| Елемент | Текст і поведінка |
|---|---|
| H2 | «Якщо вам зараз дуже важко» |
| Текст | «Зверніться до людей, які можуть допомогти просто зараз. В Україні 112 і 103 працюють цілодобово й безкоштовно.» |
| Номери | 112 і 103 — великі `.help__number` у статичному HTML, з підписами з §6.5. Нижче — «Гарячі лінії «Ти як?»» ↗. |
| Лінії підтримки | Після першого відкриття — `GET /api/v1/helplines`, лише через `sanitizeHelplines` (§6.3). Якщо запит не вдався, блоку просто немає. |
| Під номерами, лише коли є транскрипт | «Ваша розмова на сторінці нікуди не зникла — закрийте це вікно, щоб повернутися до неї.» |
| «Вправи без розмови» (фаза C, brief §4.8) | «Подихати хвилину» · «Заземлення 5-4-3-2-1» · «В укритті» — над контактами відкривається інструмент (§3.13), Esc повертає сюди. У `crisis` рядка немає (§6.7). |
| Кнопка | «Закрити» |

- Поки діалог відкритий, звук мовчить.
- Стрім діалог не зупиняє і в кризовий режим не переводить.
- Якщо, поки діалог відкритий, хід дав `crisis`, 401 чи 403, діалог закривається, а фокус іде на `h1`
  нового екрана (§3.1 «Діалоги»). Кризовий екран сам починається з тих самих номерів.
- **`tel:` не впирається в `beforeunload`.** Поки є розмова, `beforeunload` увімкнений (I7). У Chromium
  клік по `tel:` запускає `beforeunload` і показує нативне «Покинути сайт?»; «Скасувати» там зриває
  дзвінок. `[verified: node phase2/tel-check/check.cjs (Playwright, channel chromium і webkit) → «chromium plain beforeunload events = 1 dialogs = ["beforeunload"]», «chromium guard beforeunload events = 0 dialogs = []», «webkit plain … = 0»; console порожній в усіх варіантах]`
  Тому `leave-guard.ts`:
  - слухає `click` у фазі capture на `document` для `a[href^="tel:"]`;
  - перед переходом знімає слухача `beforeunload`;
  - вмикає його знову за I7 на першу з подій: `focus` вікна, `visibilitychange → visible` або
    `setTimeout` ≈ 1 с.
  Стосується всіх `tel:` на сторінці: цей діалог, `not-invited` з транскриптом, згода в режимі `resume`,
  `session-expired`. Android Chrome перевірити на пристрої — `[unverified]`.

**Рішення:** беремо лінії з `GET /helplines` [C][P], але пропускаємо їх через правила санітайзера [E].
Сира відповідь гілки `main` містить `notes` із «7333».

### 3.12 Діалог `leave` (вихід з розмови всередині сторінки)

Відкривається, коли людина йде через лого чи «На головну», а втратити є що (I7).

| Елемент | Текст |
|---|---|
| H2 | «Піти з розмови?» |
| Текст | «Liora не зберігає текст цієї розмови. Якщо підете, на цій сторінці його вже не буде.» |
| Текст, лише поруч із «Підсумувати» (`chat`, є відповідь AI, без «не зберігати») | «Хочете залишити тези — спершу підсумуйте розмову.» Без умови речення радило б неможливе: у «не зберігати» (де підказка каже, що тези не зберегти), на `summarizing`, `session-expired`, `not-invited`, `consent(resume)`. |
| Текст, лише на `review` без «не зберігати» | «Чернетка тез теж зникне — щоб залишити тези, збережіть їх у щоденник.» Тези вже складено, тож дія тут — «Зберегти в щоденник», а не підсумок. |
| Кнопки | «Залишитися» — стартовий фокус.<br>«Підсумувати» — ховаємо, якщо ще немає відповіді AI або увімкнено «не зберігати».<br>Небезпечна «Піти». |

Закриття вкладки, перезавантаження й «Назад» ловить нативний `beforeunload`. Свого тексту там задати не
можна: браузери його ігнорують [C][E].

### 3.13 Інструменти самодопомоги (фаза C)

Джерело копірайту й безпеки — `research/selfhelp.md` §1, §3.1, §3.2, §3.5, §3.6, §5, §8. Ядро —
`core/selfhelp.ts` (розклад дихання, словник чек-іну) і накладки в `state.ts`; DOM — `ui/tools.ts`.

**Спільні правила:**
- кожен інструмент — нативний `<dialog>` + `showModal()` (`breathe-dialog`, `ground-dialog`, `mood-dialog`,
  `shelter-dialog`), з `aria-labelledby`; фокус лишається всередині, Esc закриває, фокус повертається
  ініціатору (§3.1 «Діалоги»). Шапка діалогу не прокручується: прокручується лише `.tool__body` під нею, тож
  «Стоп» і «Закрити» завжди на екрані, і на телефоні боком (839 × 200);
- **нічого не зберігається й не надсилається**: ні стан вправи, ні слово настрою — лише памʼять вкладки
  (`ctx.mood` в ядрі, лічильники в `ui/tools.ts`); жодного запиту на відкриття чи в процесі; нових ключів
  сховища немає;
- **криза закриває будь-який інструмент за той самий кадр**: `reduce()` порожнить `overlay`, `dialogs.ts`
  закриває діалог і синхронно зупиняє годинник вправи (`tools.close`), чек-ін забувається. У `crisis`
  інструменти не відкриваються взагалі (і в «Якщо важко» там їх немає);
- без обіцянок ефекту, без похвали, без серій і балів;
- стоп-лист DOM діє і тут: про сирену — «повітряна небезпека» й «укриття», про стан — «неспокій», «напруга».

**«Подихати хвилину»** (`breathe`):

| Крок | Що на екрані |
|---|---|
| Початок | H2 «Подихати хвилину». «Вдих на 4, видих на 6. Можна зупинитися будь-коли.» — це й опис діалогу (`aria-describedby="breathe-lines"`: читається рядок обраного дихання, схований — ні), бо фокус стає на «Почати», повз інструкцію. Перемикач `role="switch"` «Циклічне зітхання» (тоді рядок «Вдих носом, ще короткий довдих — і довгий повільний видих.»). Основна «Почати» — стартовий фокус. `<details>` «Чому це може допомогти»: «Довший видих — простий спосіб трохи сповільнитися. Комусь допомагає, комусь ні — спробуйте й подивіться на себе.» |
| Хвилина | Повільне: вдих 4 с / видих 6 с, 6 разів (60 с). Зітхання: 2 + 1 + 6 с, 7 разів (63 с). Крок рахується від часу (`breathAt`), а не від тиків. Слово кроку — «Вдих», «Ще трохи», «Видих»: у колі й один раз на крок у прихованому `role="status"` (секунди не озвучуються). Дрібно: «Якщо паморочиться в голові — дихайте як зазвичай.» Кнопка в шапці — «Стоп»: закінчує вправу й закриває діалог. |
| З рухом | Коло (`aria-hidden`) росте на вдиху й осідає на видиху за `transition: scale` тривалістю решти кроку (`--breath-ms`). |
| Без руху (`data-motion="off"` чи `prefers-reduced-motion: reduce`) | Коло стоїть, у ньому слово кроку й відлік «4 3 2 1» моно-цифрами. |
| Кінець | «Хвилина минула.» і «Ще хвилину». Кнопка в шапці знову «Закрити». |

Куля поки діалог відкритий — `data-presence="breathing"` (мітка «Дихальна вправа» — і для повільного, і для
зітхання; сцена — `fire 0.1`); згодом це стан 3D-персонажа. CSS-куля в цей час **стоїть** (без власного
подиху): коло — єдиний темп на екрані. Своя 10-секундна пульсація кулі йшла б зі зсувом від «Почати» (і
розходилася б із 9-секундним зітханням) — два різні ритми поруч тягнули б у різні боки. Подих сцени WebGL
(`breath(elapsed)`, 1,2 % масштабу) лишився на своєму годиннику: він ледь помітний, а синхронізувати його з колом — окрема зміна API присутності (фаза персонажа).

**«Заземлення 5-4-3-2-1»** (`ground`): по одному кроку, «Далі» / «Назад», жодного поля вводу. Кроки: «Повільно
видихніть. Відчуйте ступні на підлозі.» → «5 · Знайдіть поглядом 5 речей довкола.» → «4 · Торкніться 4
речей поруч. Які вони на дотик?» → «3 · Почуйте 3 звуки.» → «2 · Помітьте 2 запахи — або 2 відчуття в тілі.»
→ «1 · Назвіть одне, що ви відчуваєте просто зараз. Можна подумки.» → «Ви тут. Рухайтеся далі у своєму
темпі.» з «Готово» і «Ще раз». Над кроком — «Крок N з 6»; зміна кроку звучить через прихований
`role="status"`, фокус лишається на «Далі» (на «Готово» в кінці, на «Далі», коли «Назад» зникає). Крок на
екрані — опис діалогу (`aria-describedby="ground-steps"`; сховані кроки не читаються).
**Кнопки не рухаються під вказівником:** основна — перша й завжди на тому самому місці («Далі» на кожному
кроці, «Готово» в кінці), «Назад» / «Ще раз» — після неї; усі кроки лежать в одній клітинці сітки
(сховані — `visibility: hidden`, розмір лишається), тож блок має висоту найдовшого кроку, а рядок «Крок N з 6»
у кінці лише ховається, не зникає. Два натискання в одне місце — два кроки вперед, ніколи вперед-назад; у
кінці таке натискання — «Готово», не «Ще раз». На першому
кроці: «Якщо зараз повітряна небезпека — спершу в укриття. Вправу можна зробити там.» (не з укриття).
Унизу: «Можна зупинитися будь-коли.»

**«Як ви зараз?»** (`mood`): шапка «Лише на цій сторінці» і «Пропустити». Сітка 2 × 2 кнопок `aria-pressed`
(енергія × приємність, словами в кожній клітинці: «Багато сил, неприємно», «Багато сил, приємно», «Мало сил,
неприємно», «Мало сил, приємно») → 6 слів-чипів клітинки зі словника ядра (`MOOD_WORDS`, 24 слова, без
стоп-слів) → «Готово» і, лише на розмові з полем, «Додати до розмови». «Готово» записує слово (`mood/pick`);
«Додати до розмови» ще й вставляє «Зараз у мене — {слово}.» у поле — надсилає людина сама. Esc і
«Пропустити» не записують нічого. Вільного тексту немає (прогалина словника кризи, selfhelp §5).
- `ctx.mood = { before, after }`: перше слово розмови — `before` (наступні чек-іни посеред розмови його не
  міняють), `after` — лише з «А зараз?».
- **«А зараз?»** — на `review`, `saved` і `ended`, коли є `before`: рядок «Спершу — {before}.» / «Спершу —
  {before}, зараз — {after}.» і кнопка «А зараз?» (`mood(after)`, без «Додати до розмови»). Ні балів, ні
  «краще/гірше». Поки тези зберігаються (`review`, `saving`), кнопка `aria-disabled`, а ядро не відкриває
  чек-ін: «Збережено» закрило б його напіввибраним (I6); там він знову доступний.
- Ніколи не тег і не поле запиту: `POST /summaries` і `/chat/summarize` несуть те саме, що й раніше.
- Забувається з новою розмовою (`startChat`, `startRevisit`), у кризі, після виходу й видалення акаунта.

**«В укритті»** (`shelter`): темний за будь-якої теми (токени темної теми переписано на піддереві діалогу,
`tokens.css`; рівність перевіряє `chat-core`, а #81b — що кожен колір усередині, і в диханні й заземленні над
ним, однаковий в обох темах); `html` теж темніє, і `theme-color` за ним (`refreshThemeColor()` з
`ui/theme.ts`, що веде його після першого кадру; до модуля його ставить лише `public/theme-init.js`, §3.1) — смуга браузера на телефоні не світла над темним
укриттям; без звуку (`presence.ts` глушить його, як у `help`), на весь
екран, великі кнопки (64 px). Згори: H2 «Спершу — безпека», «Якщо ви ще не в укритті — ідіть туди. Ця
сторінка зачекає.» (опис діалогу); далі «Подихати хвилину» й «Заземлення 5-4-3-2-1» (стають над укриттям,
лишаються темними; Esc повертає в укриття) і контакти 112, 103, «Гарячі лінії «Ти як?»» — статично, без
`GET /helplines`. Вмикає лише людина; геолокації немає; таймера, що закриває режим, немає.

**Де інструменти** («аптечка» без розмови, selfhelp §8.1, ≤ 2 дотики, без запитів):
- нова розмова: «+ Інструменти» → пункт; чип «Як ви зараз?» — один дотик;
- «Якщо важко» → «Вправи без розмови» (сам діалог робить свій `GET /helplines`, інструмент — нічого);
- екран входу: рядок «Без входу» — один дотик.

---

## 4. Помилки API → що бачить людина

### 4.1 Як розбираємо відповідь (`core/errors.ts`)

Алгоритм — з [E].

1. **Тіло.** Читаємо `await res.text()` і в `try` робимо `JSON.parse`.
   - Беремо результат, лише якщо `error.code` — рядок. Тоді є `code` і `details`.
   - Інакше тіло вважаємо порожнім. Caddy сам віддає 502/504 з порожнім тілом, а проксі може повернути
     HTML.
2. **Код без тіла** — зі статусу:

   | Статус | Код |
   |---|---|
   | 400 | `bad_request` |
   | 401 | `unauthenticated` |
   | 403 | `forbidden` |
   | 404 | `not_found` |
   | 405 | `method_not_allowed` |
   | 413 | `payload_too_large` |
   | 502, 503, 504 | `upstream_unavailable` |
   | решта | `http_error` |
3. **`retryAfterMs`:**
   - формат: ціле число секунд × 1000 або HTTP-дата мінус `now`;
   - результат обмежуємо до [1 с, 60 с];
   - без заголовка: 5 с для `llm_busy`, `null` для решти.
4. **`requestId`** беремо із заголовка `X-Request-ID`, а для SSE — з `meta.request_id`.
5. **`error.message` із сервера** (англійською) людині не показуємо **ніколи**. Текст завжди береться з
   клієнтського словника за кодом [C][P][E].

### 4.2 Де показуємо помилку

Таксономія місць — з [P].

| Місце | Коли |
|---|---|
| **Рядок під повідомленням людини** | Помилки ходу. Моно-мітка «Не надіслано» `--color-light`, речення `--color-text-soft` і дії `->`. |
| **Рядок над композером** (`role="status"`) | Те, що стосується всієї розмови: відлік, межі. |
| **Блок замість композера** | Розмову не можна продовжити: 401, 413, межа довжини. |
| **Екран** | Доступ, згода, вхід, криза, `fatal`. |
| **Поле** | Помилки перевірки тез (`aria-describedby`, фокус на першому хибному полі). |

Червоного кольору немає, слова «Помилка» великими літерами — теж [P].

**Загальний текст** для `internal`, `http_error`, `bad_request`, `method_not_allowed`, `json_invalid`
і невідомого коду:
- «Щось пішло не так на нашому боці. Спробуйте ще раз.»;
- під ним, якщо є id, моно 11 px dim: «Код запиту: {requestId}».

### 4.3 Таблиця

«Транскрипт» — що відбувається з розмовою в памʼяті. Якщо в рядку не сказано інакше, вона лишається.

| Код (HTTP) | Звідки | Де й що бачить людина | Транскрипт | Повтор |
|---|---|---|---|---|
| Мережа: `TypeError` у `fetch`, офлайн | `GET /me` | `fatal` (§3.9) | — | «Спробувати ще раз» |
| Мережа | `turn` | Рядок: «Не надіслано — немає зʼєднання.» і «-> Надіслати ще раз». Кнопка стає активною на подію `online`. | лишається | вручну |
| Мережа | `POST /consents`, `POST /summaries`, `DELETE /me`, `DELETE /consents/{kind}`, `POST /auth/logout` | Рядок біля дії: «Не вдалося — немає зʼєднання. Спробуйте ще раз.» Для `POST /summaries` — §7.3. | лишається | вручну |
| Таймаут 35 с до заголовків (`signal.reason === 'headers-timeout'`) | `turn` | Рядок: «Відповідь не прийшла.» і «-> Надіслати ще раз». Після заголовків цей таймер знято: довге тіло стріму він не обриває (§5.5). | лишається | вручну |
| 45 с без жодного байта після старту (`signal.reason === 'idle'`) | `turn` | Як обрив (нижче) | часткову відповідь прибираємо | авто ×1 |
| Таймаут 150 с | `summarize` | Як `llm_failed` | лишається | вручну |
| 400 `bad_request` | будь-що | Загальний текст | лишається | вручну |
| 401 `unauthenticated` | `GET /me` на старті | `signed-out` | — | «Увійти через Google» |
| 401 | `turn`, `summarize`, `POST /summaries`, `GET /summaries`, `DELETE /consents/{kind}` посеред сесії | `session-expired` (§3.8) | видно, лише читання; зникне після входу | «Увійти знову» |
| 401 | `POST /consents` | `signed-out(fresh)`; якщо була розмова — `session-expired` | — | — |
| 401 | `DELETE /me`, перша спроба | `signed-out` з банером «Вхід завершився. Увійдіть, щоб видалити акаунт.» [E] | — | — |
| 401 | `DELETE /me`, повтор після спроби з невідомим результатом (мережа, таймаут, 5xx без тіла) | `account-deleted(presumed)` (§8.5): сесії вже немає, бо перший запит, найімовірніше, видалив акаунт | стерто | — |
| 403 `csrf_failed` | будь-який POST/DELETE | **Перший раз** — рядок біля дії: «Не вдалося надіслати через технічну перевірку безпеки. Спробуйте ще раз.» і «-> Надіслати ще раз».<br>**Повторно** — «Оновіть сторінку. Розмова при цьому зникне — спершу її можна скопіювати.», кнопки «Скопіювати текст розмови» і «Оновити сторінку» (через `confirm(leave)`).<br>Для `logout` — «Не вдалося вийти. Оновіть сторінку й спробуйте ще раз.» [P].<br>Це клас багів (не той origin чи `mode`), тому на нього є тест-сторож. | лишається | вручну, 1 раз |
| 403 `not_invited` | `turn`, `summarize`, `POST /summaries` | `not-invited(hasSession)` (§3.4) | лишається, у `<details>` | — |
| 403 `consent_required` (`details.missing`, `policy_version`) | `turn`, `summarize`, `POST /summaries` | `consent(resume)` зі свіжим `GET /consents` (§3.5). Нова `policy_version` → `policyChanged`, режим лишається `resume`. | лишається, неподане повідомлення теж (`pending`) | **авто** після згоди: для ходу — той самий `resume.request` |
| 403 `forbidden` без коду | будь-що | Рядок: «Цю дію зараз виконати не можна.» [C] | лишається | — |
| 404 `not_found` | `turn` з `revisit_summary_ids` | `revisit-pick` з банером (§3.6) | лишається | після нового вибору |
| 404 | інше | Загальний текст | лишається | — |
| 405 `method_not_allowed` | будь-що | Загальний текст | лишається | вручну |
| 409 `policy_outdated` (`details.policy_version`) | `POST /consents` | `GET /consents`, галочки зняті, банер «Умови щойно оновилися…» (`policyChanged`). З `first` режим стає `update`; у `resume` режим і `resume` лишаються (§3.5) | лишається | людина погоджується знову |
| 409 `crisis_stop` (`details.helplines`) | `summarize` | `crisis` (§6) | заблоковано | ніколи |
| 413 `payload_too_large` (JSON і від API, і від Caddy для chunked-тіла) | `turn` | Блок замість композера: «Розмова стала задовгою, щоб надіслати її цілком. Підсумуйте її або почніть нову.» Кнопки «Підсумувати» · «Завершити без тез». | лишається | — |
| 413 | `summarize` | Рядок на `summarizing`: «Розмова завелика навіть для тез. Її можна лише завершити без тез.» і «Завершити без тез» | лишається | — |
| 422 `json_invalid` | будь-що | Загальний текст. Це баг клієнта, на нього є тест тіла запиту. | лишається | вручну |
| 422 `validation_error` | `turn` | Рядок: «Повідомлення не пройшло перевірку. Спробуйте скоротити або змінити його.» і «-> Змінити» · «-> Надіслати ще раз» | лишається | вручну |
| 422 `validation_error` | `POST /summaries` | На полі за `details[].field`:<br>• `title` → «Назва: від 1 до 120 символів.»;<br>• `bullets.N` → поле, яке стоїть під індексом N **у тілі запиту**, через таблицю `requestIndex → fieldId` (§7.2): «Теза: до 500 символів.»;<br>• `tags.N.name` → так само через таблицю тегів: «Тег: до 40 символів.»;<br>• незнайоме поле або індекс поза таблицею → загальний текст. | лишається | після правки |
| 422 `validation_error` | `summarize` | Рядок на `summarizing`: «Не вдалося скласти тези з цієї розмови.» Кнопки «-> Завершити без тез» · «-> Повернутися до розмови». Без автоповтору й без «Скласти ще раз»: те саме тіло дасть ту саму 422. 422 тут — баг клієнта (тіло, а не модель), тож текст не каже «AI не зміг»; на нього є тест тіла (#32b). | лишається | — |
| 422 `validation_error` | `POST /consents`, `DELETE /consents/{kind}` | «Не вдалося зберегти згоду. Спробуйте ще раз.» Порожнього `kinds` клієнт не шле ніколи (§3.5), тож це баг тіла; «Оновіть сторінку» тут не радимо — оновлення стерло б розмову в режимі `resume`. | лишається | вручну |
| 422 `invalid_timezone` | `GET /reviews/weekly` | Нічого не показуємо: один повтор із `tz=Europe/Kyiv` (типова зона сервера), далі ця зона для всіх тижнів. Друга 422 — рядок «Не вдалося завантажити огляд тижня.» і «-> Спробувати ще раз». | — | авто ×1 |
| Будь-яка помилка | `GET /reviews/weekly`, `GET /summaries` щоденника | Рядок у своєму блоці: «Не вдалося завантажити огляд тижня.» / «Не вдалося завантажити записи.» і «-> Спробувати ще раз». `GET /tags` з помилкою — просто без групи «Теми». 401 — як усюди. | — | вручну |
| 422 `validation_error` | `PATCH /summaries/{id}` | На полі, як для `POST /summaries`: індекси тіла → поле форми; тема — «Теми: до 10, кожна до 40 символів.» Незнайоме поле — загальний текст під «Зберегти». | правка лишається | після правки |
| 404 `not_found` | `PATCH /summaries/{id}` | Запис зникає зі списку, рядок «Цього запису вже немає в щоденнику.» | — | — |
| 404 `not_found` | `DELETE /summaries/{id}` | Як 204: запис уже видалено (інша вкладка, повтор). «Запис видалено.» | — | — |
| Мережа, таймаут, 5xx | `PATCH /summaries/{id}` | Під «Зберегти»: «Не вдалося — немає зʼєднання. Спробуйте ще раз.» / «Відповідь не прийшла. Спробуйте ще раз — ваші правки на місці.» / «Не вдалося зберегти зміни. Спробуйте ще раз.» і «Код запиту». | правка лишається | вручну |
| Мережа, 5xx | `DELETE /summaries/{id}` | Рядок статусу: «Не вдалося — немає зʼєднання. Спробуйте ще раз.» / «Не вдалося видалити запис. Спробуйте ще раз.» | запис лишається | вручну |
| 429 `rate_limited` + `Retry-After` | `turn` | Рядок під повідомленням «Не надіслано»: «За хвилину можна надіслати до 20 повідомлень разом із тезами. Надіслати знову можна через {n} с.» Кнопка `aria-disabled` з відліком (`cooldown`). Анонс на старті — той самий рядок із секундами (§5.7), на нулі — «Можна надіслати ще раз.» | лишається | **вручну**, після відліку |
| 429 | `summarize` | Те саме на `summarizing`, кнопка «Скласти ще раз» після відліку. Ліміт спільний для ходів і тез, тож кілька «Скласти заново» поспіль можуть у нього впертися. | лишається | вручну |
| 429 | `POST /summaries` | Рядок біля «Зберегти в щоденник»: «Забагато запитів поспіль. Спробуйте за хвилину — ваші правки на місці.» Без відліку: сервер (`628a571`) на `POST /summaries` ліміту не ставить (`rate_limiter.check` є лише в `app/api/chat.py:75` і `:136`), тож це запасна гілка на випадок ліміту перед API. | лишається, чернетка теж | вручну |
| 500 `internal` | будь-що | Загальний текст і «Код запиту» | лишається | вручну |
| 502 `llm_failed` | `summarize` | §7.1: «AI не зміг скласти тези. Спробуйте ще раз — розмова на місці.» Кнопки «Скласти ще раз» · «Повернутися до розмови» · «Завершити без тез». | лишається | вручну |
| 502 / 504, порожнє чи не-JSON тіло (Caddy) → `upstream_unavailable` | `GET /me` на старті | `fatal` | — | «Спробувати ще раз» |
| те саме | будь-що інше | Рядок: «Сервер зараз не відповідає. Спробуйте за хвилину.» і «-> Надіслати ще раз» | лишається | вручну |
| 503 `llm_busy` + `Retry-After: 5` | `turn` (до стріму), `summarize` | Рядок: «AI зараз зайнятий іншою розмовою. Пробуємо ще раз через {n} с…» і «-> Скасувати». Після 2 автоповторів: «AI досі зайнятий. Спробуйте за хвилину — ваше повідомлення на місці.» і «-> Надіслати ще раз». | лишається | **авто ×2** за `Retry-After`, далі вручну |
| 503 `auth_unavailable` | лише top-level навігація на `google/start` | Після серверної гілки (§1.3) приходить як `?auth_error=auth_unavailable` → банер (§3.3). Як 503 у `fetch` не трапляється. | — | — |
| 503 без коду або інший | будь-що | Як `upstream_unavailable` | лишається | вручну |
| 200, але `Content-Type` не `text/event-stream` | `turn` | Як `internal`: проксі віддав HTML замість SSE [E] | лишається | вручну |
| SSE `error` `llm_failed` | `turn` | Рядок: «AI не зміг відповісти. Ваше повідомлення на місці — спробуйте ще раз.» і «-> Надіслати ще раз» · «-> Змінити» | часткову відповідь прибираємо | вручну. `retryable` завжди `true`, але автоповтор лише марнував би ліміт [E]. |
| SSE `error` `llm_busy` | `turn` | Як HTTP 503 `llm_busy`, затримка 5 с | часткову прибираємо | авто ×2 |
| SSE `error` `internal` або невідомий код | `turn` | Загальний текст | часткову прибираємо | вручну |
| SSE `crisis` (`keyword` / `model`) | `turn` | `crisis` (§6) | заблоковано, часткову прибираємо | ніколи |
| Стрім закрився без фінальної події, впав `read()`, `ProtocolError` | `turn` | Перший раз нічого не показуємо, у слоті знову «Думає». Удруге — «Зʼєднання обірвалося. Ваше повідомлення на місці.» і «-> Надіслати ще раз». | часткову прибираємо | **авто ×1** тими самими `messages` |
| `done` без жодного непробільного токена | `turn` | «AI не зміг відповісти.» і «-> Надіслати ще раз». В історію нічого не додаємо: `content` має бути 1..4000, інакше кожен наступний хід отримав би 422 [P]. | лишається | вручну |
| `?auth_error=…` | повернення з Google | Банер (§3.3) або `not-invited` (§3.4) | — | — |

**`GET /healthz`** у MVP не викликаємо: стан видно з самих запитів [P].

**Експорт** (`<a download>` на `/api/v1/export`) — звичайна GET-навігація з cookie. Якщо сесії вже
немає, браузер збереже файл із JSON-помилкою. Це рідкісний випадок, і на нього немає UI.

---

## 5. SSE: як працює хід

### 5.1 Запит (`core/api.ts`)

```ts
// Ілюстрація
const res = await deps.fetch(`/api/v1${path}`, {
  method,
  headers: body === undefined ? { Accept: accept } : { Accept: accept, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  credentials: 'same-origin',
  referrerPolicy: 'same-origin',   // нешкідливо й узгоджено з контрактом; для Origin вирішальне — не задавати mode (див. нижче)
  cache: 'no-store',
  signal,
})
```

**Чого не буває ніколи:**
- `mode` — ні `'same-origin'`, ні `'no-cors'`;
- `keepalive`;
- `Authorization`;
- `EventSource`;
- поле `timezone`;
- spread довільного обʼєкта в тіло (`extra="forbid"`): DTO будуємо явно [E].

**Чому `mode` не задаємо — і чому CI цього не впіймає.** Перевірив у цій сесії. Сторінка з
`Referrer-Policy: no-referrer` шле same-origin `fetch` POST:

| `fetch` | Chromium | WebKit |
|---|---|---|
| без `mode` | справжній `Origin` | справжній `Origin` |
| без `mode`, з `referrerPolicy: 'same-origin'` | справжній `Origin` | справжній `Origin` |
| `mode: 'same-origin'` | **справжній `Origin`** | **`Origin: null`** |

`[verified: node phase2/origin-check/check.cjs]`

Висновок:
- CI ганяє лише Chromium, тож регресію в `mode` він **не впіймає**, а на Safari вона дасть 403
  `csrf_failed`;
- тому є три охоронці:
  1. юніт-тест ядра з фейковим `fetch`, який перевіряє `init.mode === undefined` і
     `init.credentials === 'same-origin'`;
  2. grep-правило «у `src/chat` немає `mode:`»;
  3. локальний прогін проєкту `iphone-webkit`.

### 5.2 Відповідь

- `!res.ok` → `ApiError` (§4.1).
- `Content-Type` не починається з `text/event-stream` → `internal`.
- `X-Request-ID` зберігаємо.

### 5.3 Парсер кадрів (`core/sse.ts`)

Код — з [E].

```ts
export type SseFrame = { event: string; data: string }

export async function* readFrames(body: ReadableStream<Uint8Array>, onBytes: () => void, maxBuffer = 256 * 1024): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')   // stream:true склеює кириличний символ, розрізаний між чанками
  let buf = ''
  let carryCR = false                         // "\r" у кінці чанка + "\n" на початку наступного = один перенос
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onBytes()                               // будь-які байти, зокрема ": ping", скидають watchdog тиші
      let text = decoder.decode(value, { stream: true })
      if (carryCR && text.startsWith('\n')) text = text.slice(1)
      carryCR = text.endsWith('\r')
      buf += text.replace(/\r\n?/g, '\n')
      for (let cut = buf.indexOf('\n\n'); cut !== -1; cut = buf.indexOf('\n\n')) {
        const frame = parseBlock(buf.slice(0, cut))
        buf = buf.slice(cut + 2)
        if (frame) yield frame
      }
      // Межа — на НЕЗАВЕРШЕНИЙ кадр, тобто на залишок після вирізання готових. Великий чанк із кількох
      // валідних кадрів (розморожена вкладка, route.fulfill цілим тілом) — не помилка.
      if (buf.length > maxBuffer) throw new ProtocolError('frame too large')
    }
    // Хвіст без "\n\n" — неповний кадр. Відкидаємо: це обрив.
  } finally {
    reader.cancel().catch(() => {})           // фінальна подія чи abort закривають зʼєднання
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue        // ": ping" і будь-які коментарі
    const i = line.indexOf(':')
    const field = i === -1 ? line : line.slice(0, i)
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    // id, retry і невідомі поля ігноруємо
  }
  return data.length ? { event, data: data.join('\n') } : null
}
```

### 5.4 Події: перевірка і порядок (`chatEvents`)

**Перевірка кадру:**
- `data` розбираємо `JSON.parse` у `try`;
- кадр приймаємо, лише якщо:
  - це обʼєкт;
  - `type === frame.event`;
  - `type` належить до `meta | token | done | crisis | error`.

  Інакше кадр пропускаємо: невідомий тип — це сумісність уперед.

**Порядок:** `meta` → `token*` → **рівно одна** фінальна подія (`done`, `crisis` або `error`).
- Якщо `meta` немає, не падаємо: `request_id` є й у заголовку.
- Після фінальної події зупиняємо читання (`reader.cancel()`), а все, що прийшло після неї, ігноруємо.

**Поля:**

| Поле | Правило |
|---|---|
| `token.text` | Рядок, інакше кадр пропускаємо. |
| `done.finish_reason` | `string \| null` |
| `error.code` | Один з `llm_failed`, `llm_busy`, `internal`; інакше вважаємо `internal`. |
| `error.retryable` | Читаємо, але політику повторів задає код (§5.5). |
| `crisis.helplines` | Одразу в `sanitizeHelplines` (§6.3). Сирий обʼєкт далі **не йде** — ні в стан, ні в лог. |

### 5.5 Watchdog-и і повтори (`core/turn.ts`)

| Константа | Значення | Чому |
|---|---|---|
| `HEADERS_TIMEOUT` | 35 000 мс | Лише **до заголовків**: сервер чекає LLM-слот до 20 с, потім віддає 503. `meta` іде одразу, щойно слот отримано. 35 с [E], а не 30 [C][P]: запас на мережу. Після resolve `fetch` таймер знято — на тіло він не діє. |
| `IDLE_TIMEOUT` | 45 000 мс | Після заголовків: 45 с без жодного байта. Сервер шле `: ping` після 15 с тиші, тож три пропущені пінги означають мертве зʼєднання. Загальної межі на тривалість стріму немає. |
| `MAX_TRUNC_RETRIES` | 1 | Контракт: «stream closing without a final event → retry». |
| `MAX_BUSY_RETRIES` | 2 | `Retry-After: 5`; free-план Ollama дає один слот на всіх. 2 [C][E], а не 1 [P]: з одним слотом черга буває довгою. |
| `SUMMARIZE_TIMEOUT` | 150 000 мс | Звичайний JSON після всієї генерації: черга до 20 с + `llm_timeout_s` 120 с + запас. **Рішення:** 150 с [C], а не 120 с [E] — 120 коротше, ніж сервер може законно працювати. |
| `BOOT_TIMEOUT` | 15 000 мс | `GET /me` |

**Один хід «Надіслати»:**
1. `request = Object.freeze([...messages, {role: 'user', content}])`.
2. `attempt()` — чотири контролери, кожен abort **з причиною**:

   | Контролер | Хто викликає `abort` | Причина |
   |---|---|---|
   | `userCtl` | «Зупинити», «Скасувати» у відліку, вихід, видалення акаунта | `'user'` |
   | `pageCtl` | `pagehide` (§5.6) | `'pagehide'` |
   | `headersCtl` | `setTimeout(HEADERS_TIMEOUT)` | `'headers-timeout'` |
   | `idleCtl` | idle-watchdog | `'idle'` |

   ```ts
   // Ілюстрація
   const signal = anySignal([userCtl.signal, pageCtl.signal, headersCtl.signal, idleCtl.signal])
   const headersTimer = deps.setTimeout(() => headersCtl.abort('headers-timeout'), HEADERS_TIMEOUT)
   let res: Response
   try { res = await api.turn(req, signal) }
   finally { deps.clearTimeout(headersTimer) }           // одразу після заголовків: тіло цей таймер не обриває
   let idle = deps.setTimeout(() => idleCtl.abort('idle'), IDLE_TIMEOUT)
   const onBytes = () => { deps.clearTimeout(idle); idle = deps.setTimeout(() => idleCtl.abort('idle'), IDLE_TIMEOUT) }
   // readFrames(res.body, onBytes) → chatEvents → …; у finally — clearTimeout(idle)
   ```
   - **Не** `AbortSignal.timeout(35000)` у `AbortSignal.any`: такий таймер не зупиняється після заголовків
     і на 35-й секунді від старту обриває вже тіло стріму. `read()` падає з `TimeoutError`, це `truncated`,
     автоповтор обривається так само, і довга відповідь під чергою не завершується ніколи.
     `[verified: node phase2/abort-check/check.mjs (Node 24, undici fetch; заголовки одразу, тіло 1.2 с) → «AbortSignal.timeout(500): body failed after 502 ms: TimeoutError»; «setTimeout(500)+clearTimeout: done after 1207 ms»; «idle abort with reason: body failed after 301 ms: idle | signal.reason = idle»]`
     У браузері те саме за специфікацією Fetch; окремо в Chromium не ганяв — це тримає тест #22b.
   - `anySignal` — це `AbortSignal.any`, а де його немає — ручне звʼязування, яке **передає причину**:
     `src.addEventListener('abort', () => out.abort(src.reason), { once: true })`.
   - Idle-watchdog обриває reader через той самий `signal`: abort сигналу, переданого в `fetch`, рве й тіло,
     тож `reader.read()` відхиляється.
   - `!res.ok` → `ApiError` → §4;
   - `Content-Type` не SSE → `internal`;
   - далі `readFrames`, idle-watchdog і `chatEvents`.

   **Класифікація винятку — за `signal.reason`, а не за типом помилки.** `fetch` і `read()` відхиляються
   самим значенням причини, а «Зупинити», `pagehide` і обрив виглядають з `read()` однаково:

   | `signal.aborted` / `signal.reason` | `TurnOutcome` | Повтор |
   |---|---|---|
   | `'user'`, `'pagehide'` | `aborted` | ніколи |
   | `'idle'` | `truncated` | авто ×1 |
   | `'headers-timeout'` | `headersTimeout` → «Відповідь не прийшла.» (§4.3) | вручну |
   | сигнал не перервано, `TypeError` до відповіді | `network` | вручну |
   | сигнал не перервано, впав `read()`, EOF без фінальної події, `ProtocolError` | `truncated` | авто ×1 |
3. Результат — `TurnOutcome`, одне з:
   - `done{text, finishReason}`;
   - `crisis{helplines}`;
   - `streamError{code}`;
   - `http{ApiError}`;
   - `truncated` — EOF без фінальної події, впав `read()`, idle-таймаут або `ProtocolError`;
   - `headersTimeout` — 35 с без заголовків;
   - `network` — `TypeError` до відповіді;
   - `aborted` — «Зупинити», «Скасувати», `pagehide`.
4. `truncated`, і бюджет ще є:
   - `RESET_PARTIAL` — часткова відповідь зникає з DOM (спершу скасовуємо заплановане скидання токенів, §5.7);
   - повтор з **тим самим** `request`.
5. `llm_busy` (HTTP 503 чи SSE `error`), і бюджет ще є:
   - фаза `busy-wait` з видимим відліком на `Retry-After`;
   - «Скасувати» чи «Зупинити» перериває очікування;
   - повтор з тим самим `request`.
6. `aborted` ніколи не повторюємо. `network` повторюємо лише вручну [C][P]. Ходи без стану, тож ручний
   повтор безпечний.

**Найгірший час до «не вдалося»:**
- ланцюжок `llm_busy`: 20 + 5 + 20 + 5 + 20 ≈ 70 с, бо сервер віддає 503 після 20 с черги [E];
- зависла мережа: `HEADERS_TIMEOUT` спрацьовує через 35 с, далі повтор лише вручну, без ланцюжка.

Увесь цей час людина бачить мітку або відлік, а «Зупинити» скасовує все.

### 5.6 Скасування й життєвий цикл сторінки

- **«Зупинити»** → `userCtl.abort('user')`, далі §3.7.5.
- **`pagehide`** → `pageCtl.abort('pagehide')` для всіх запитів у польоті: сервер звільняє слот, нічого не зберігається [E].
- **`visibilitychange` не скасовує запит:** людина на телефоні могла просто перемкнутися на іншу
  програму. Якщо ОС заморозила вкладку і зʼєднання вмерло, спрацює помилка `read()` або watchdog — це
  `truncated` з одним автоповтором.
- **`pageshow` з `persisted=true`** → `GET /me`. На 401 стираємо транскрипт → `signed-out`. Так «Назад»
  після виходу на спільному компʼютері не покаже розмову, навіть якщо браузер поклав сторінку з
  `no-store` у bfcache [E]. Якщо `GET /me` відповів **іншим акаунтом** (`id` не той), теж стираємо все й
  завантажуємо сторінку наново вже для нього: стара розмова не піде далі під чужою сесією.
- **Вихід на слово людини.** «Піти» в `confirm(leave)` обіцяє «на цій сторінці його вже не буде»,
  «Увійти» в `confirm(relogin)` — «текст цієї розмови зникне зі сторінки». Тому на `pagehide` після них
  сторінка стирає все синхронно, ще до знімка для bfcache: стан як після першого завантаження, без сесії,
  розмови, чернетки й `stale`. Повернення через «Назад» (`pageshow`, `persisted=true`) завантажує
  сторінку наново, як свіжий вхід. Із `crisis` будь-який `pagehide` прибирає розмову під `<details>`;
  контакти лишаються.
- **Відкладений автоповтор тез** (`llm_busy`): `pagehide` скасовує його так само, як запит у польоті, —
  стан отримує `aborted`, і після повернення на екрані «Скласти ще раз» з рядком «Тези ще не складено.
  Спробуйте ще раз — розмова на місці.», а не відлік, що завис на 0 с.
- **`pagehide` під час завантаження** обриває `GET /me` і `GET /consents` з кодом `aborted` (дедлайн
  завантаження дає `timeout`, тож `aborted` тут — лише від сторінки). Такий провал не веде у `fatal`:
  сторінка лишається `booting`, і повернення з bfcache (`pageshow` → `boot`) завантажує її наново, а не
  показує «немає зʼєднання».

### 5.7 Рендер токенів і озвучення

**Рендер:**
- Токени накопичуємо в буфері й скидаємо в DOM **раз на кадр** (`requestAnimationFrame`), через
  `Text.appendData()` в останній `<p>` [P][E].
- `\n\n` починає новий `<p>`.
- `innerHTML` немає.
- У прихованій вкладці rAF стоїть, тому скидаємо через `setTimeout` раз на 250 мс [E].
- Без руху (`data-motion="off"` чи reduced motion) — раз на 300 мс, без світіння каретки [P].
- Репліка, що стрімиться, має `aria-busy="true"`; після фінальної події — `false`.
- **Сцена:** на кожне скидання — `presence.pulse()`, не частіше 4 разів на секунду. Між станами
  перемикає `data-presence` (§9.2).

**Буфер на фінальній події** (`transcript.ts`). Між токеном і скиданням у DOM може стояти
запланований rAF чи `setTimeout`. Без явного правила він допише текст **після** фіналу:
- **будь-який фінал, крім `done`** (`crisis`, `error`, обрив перед повтором, «Зупинити», `pagehide`):
  1. `cancelAnimationFrame(raf)` і `clearTimeout(timer)`;
  2. `buffer = ''`;
  3. видалити `<li>` відповіді з DOM;
  4. лише потім — `RESET_PARTIAL` у стані, а для `crisis` — перенос транскрипту в `<details>` (§6.2).
  Так у перенесеному транскрипті не опиниться жодного токена (I3).
- **`done`:** синхронний flush залишку буфера → `messages` (§5.8) → анонс «Відповідь AI: …». Текст у DOM,
  у `messages` і в анонсі один і той самий.

**Live-регіон.** Один прихований `<div role="status" aria-live="polite" data-announcer>` на всю
сторінку [C][P][E]. За хід він змінюється **не більше двох разів**:
1. «AI думає над відповіддю» — лише якщо перший токен не прийшов за 700 мс [E];
2. на `done` — «Відповідь AI: {повний текст}». Відповіді короткі, 2–6 речень.

Інші анонси, кожен по одному разу:
- «Відповідь зупинено»;
- рядок помилки. Після 429 на ході відлік щойно почався, тож рядок каже його довжину: «Не надіслано. За
  хвилину можна надіслати до 20 повідомлень разом із тезами. Надіслати знову можна через {n} с.», а не
  «Можна надіслати ще раз» — кнопка ще `aria-disabled`;
- «Пробуємо ще раз через {n} {секунду | секунди | секунд}» — на старті відліку; форму слова вибирає
  `Intl.PluralRules('uk')` (1 секунду, 3 секунди, 5 секунд, 22 секунди);
- «Можна надіслати ще раз» — у кінці відліку;
- «Тези готові: {n}»;
- «Збережено в щоденник».

Сам відлік видно, але поза live-регіоном: щосекундних оголошень немає. На `summarizing` рядок стану
(`role="status"`) каже лише, що сталося («AI зараз зайнятий іншою розмовою.» / «За хвилину можна надіслати
до 20 повідомлень разом із тезами.»), а секунди стоять поруч, в окремому `<span>` поза регіоном. Він не
`aria-hidden`: тривалість очікування (до 60 с після 429) мусить бути доступна й скрінрідеру, у режимі
перегляду (SC 1.3.1), а оголошень щосекунди немає й так, бо він не live.

**Live-рядки на екранах** (`role="status"`: `composer-status`, `chat-line`, `sum-status`, `pick-status`,
`review-tag-error`) завжди в дереві доступності. Порожні вони лише візуально приховані (`position:
absolute`, 1 px, `clip`), а не `hidden` чи `display: none`: регіон, що зʼявляється разом зі своїм текстом,
NVDA/JAWS і VoiceOver озвучують ненадійно `[unverified: на скрінрідерах не перевірялося; джерело —
настанова MDN «ARIA live regions»]`. Тест #53 перевіряє, що порожній регіон відрендерений. Кінець відліку 429
змінює рядок («… Можна скласти тези ще раз.»), і це звучить один раз. «Можна надіслати ще раз» звучить
лише тоді, коли закінчився відлік саме цієї розмови, а не в новій.

**Діалоги.** `showModal()` робить решту документа inert, а inert live-регіон не читається. Тому регіон
переходить у верхній відкритий `<dialog>` і повертається на місце, коли діалогів немає. Так відповідь, що
прийшла під «Якщо важко» (§3.11), теж звучить.

**Копіювання.** «Скопійовано» або «Не вдалося скопіювати. Виділіть текст розмови вручну.» (для тез —
«Не вдалося скопіювати. Виділіть тези вручну.») звучить через той самий регіон. На кнопці на 2 с — «Скопійовано»
чи «Не вдалося скопіювати». Зміну назви сфокусованої кнопки більшість скрінрідерів не оголошує (WCAG 4.1.3).

У `crisis` анонсу немає: фокус на `h1` і так змусить його прочитати [C][E].

**Очищення.** У `[data-announcer]` лишається останній анонс, тобто й повний текст відповіді AI. Тому
`textContent = ''`:
- через ≈ 5 с після кожного анонсу;
- одразу на кожному стиранні `Session`: `saved`, `ended`, нова розмова після кризи, вихід,
  `account-deleted`, `pageshow` → 401, перехід у `crisis`.
Очищення не озвучується і не рахується як «зміна» в ліміті ≤ 2 за хід (#42 рахує лише непорожні записи).

### 5.8 Що потрапляє в історію (`messages`)

- **Повідомлення людини** потрапляє в `request` у момент надсилання. У `messages` воно переходить разом
  із відповіддю на `done`.
- **`done`:** додаємо `{role:'assistant', content: partial}`, якщо `partial.trim() !== ''`.
  - Якщо відповідь довша за 4 000 кодових точок, на екрані вона повна, а в історію йде обрізана до 4 000
    [P]. Інакше наступний хід отримав би 422.
- **`crisis`, `error`, обрив, «Зупинити»:** у `messages` нічого не додаємо (I3).
- **Сценарій `revisit`:** `revisit_summary_ids` іде з **кожним** ходом розмови — схема вимагає його для
  цього сценарію. У `summarize` його немає (тіло там `{scenario, messages}`).

---

## 6. Кризовий режим (takeover)

### 6.1 Коли вмикається

Три входи — один екран:
1. SSE `meta` → `crisis {source: "keyword"}`. Спрацював словник, LLM не викликався.
2. SSE `crisis {source: "model"}`, можливо **після** кількох `token`.
3. `POST /chat/summarize` → 409 `crisis_stop`, навіть якщо раніше в розмові криз не було.

Звідки беремо helplines:
- для 1 і 2 — поле `helplines` події;
- для 3 — `error.details.helplines`.

Обидва джерела проходять один санітайзер. Якщо обʼєкта немає або він зламаний, вмикається фолбек.

**Чому `crisis` — кінцевий стан:**
- для `keyword` так само працює сервер: словник щоходу перевіряє всю історію, тож кожен наступний хід
  знову дасть `crisis`;
- для `model` сервер нічого не блокує, тому блокує клієнт (ADR-005, «Обовʼязки клієнта»).

### 6.2 Що відбувається за один кадр, без анімації

1. Часткову відповідь AI прибираємо повністю: з DOM і зі стану, без сліду «повідомлення видалено» [C].
   Спершу скасовуємо заплановане скидання токенів і чистимо буфер (§5.7 «Буфер на фінальній події»),
   видаляємо `<li>` відповіді — і лише потім переносимо транскрипт.
2. Усі запити скасовуємо через `AbortController`. Відкриті діалоги закриваємо (§3.1 «Діалоги»).
3. Композер, рядок сесії з «Завершити розмову» і всі дії над транскриптом **видаляємо з DOM**, а не
   ховаємо [E]. Перед цим робимо `blur()`, щоб на телефоні закрилася клавіатура [C].
4. Показуємо секцію `data-screen="crisis"` — її каркас зашитий у `chat/index.html` [E].
   - Блок допомоги стоїть **першим**.
   - Транскрипт переносимо (переміщенням DOM-вузла, без копії) у `<details>` «Показати текст розмови»
     нижче контактів [P].
   - **Рішення:** [P], а не транскрипт над блоком [C] чи повністю схований [E]:
     - номери стоять першими, як у главі 05 лендінгу («The numbers come first»);
     - слова людини не зникають раптово.
5. Зовнішні ефекти:
   - `setPresence('quiet')`: `fire = 0`, стан 6 сцени;
   - звук мовчить;
   - на «Якщо важко» в шапці — `aria-current="true"`;
   - `beforeunload` знято.
6. Фокус — на `h1` секції (`tabindex="-1"`).
   - Окремого `role="alert"` і анонсу немає: він перекрикує, а тут потрібен спокій [C][E].
   - Esc нічого не відкриває: повернення в заблоковану розмову немає.

### 6.3 Санітайзер (`core/helplines.ts`)

Модуль чистий (без DOM) і переноситься в мобілку. Правила — з [E], найсуворіші з трьох дизайнів.

```ts
// Ілюстрація
export type SafeLine = Readonly<{ name: string; phone: string; tel: string; hours: string | null; free: boolean }>
export type SafeHelplines = Readonly<{ message: string | null; lines: readonly SafeLine[]; abroadText: string | null }>

const NO_7333 = (s: string): boolean => !s.replace(/\D/g, '').includes('7333') && !s.includes('7333')

export function sanitizeHelplines(raw: unknown): SafeHelplines
```

| Поле | Звідки | Правило |
|---|---|---|
| Лід | `message` | Рядок 1..400 символів, проходить `NO_7333`. Інакше — зашитий фолбек (§6.5). |
| 112 і 103 | **Константи в HTML** | `emergency` з payload **не читаємо**: ці два номери — константи, тож валідація тут лише додала б ризик [E]. |
| Лінії підтримки | `lines[]` | До 8 записів. Кожен перевіряємо:<br>• `name` — рядок 1..120, `NO_7333`;<br>• `phone` відповідає `^\+?\d(?: ?\d){2,18}$` (3..19 цифр, «+» лише на початку, один пробіл між цифрами — без мертвих `tel:` на кшталт «+++» чи «1+2») і серед його цифр немає `7333`;<br>• `hours` — рядок до 80 символів, `NO_7333`, необовʼязковий;<br>• `free === true` → «безкоштовно», `null` чи щось інше → про вартість нічого.<br>Невалідний запис пропускаємо. Якщо валідних нуль, блоку немає. |
| `tel:` | з `phone` | `'tel:' + phone.replace(/[^\d+]/g, '')`. На екрані `phone` такий, як прийшов, з пробілами («0 800 21 01 60»). |
| Текст «За кордоном» | `abroad.text` | Рядок до 300 символів, `NO_7333`. Інакше фолбек: «За кордоном: у країнах ЄС працює 112. Номери ліній підтримки в інших країнах — на сторінці «Ти як?».» |
| Посилання «Ти як?» | **Константа в HTML** | `https://howareu.com/hot-lines`. `abroad.url` з payload **не використовуємо ніколи** [E] — ні з перевіркою хоста [C], ні з перевіркою префікса [P]. |
| `notes`, `sources`, `verified_at`, `review_every_days`, невідомі поля | — | **Не читаємо взагалі.** Payload ніколи не серіалізуємо (`JSON.stringify`, `console`, атрибути). Сирий обʼєкт не потрапляє в стан. |

Як `noPausedLine` читає цифри (у коді — тільки дві половини номера, ніде цілим):
- NFKC; цифри, які NFKC не перетворює на 0-9 (арабсько-індійські, dingbat-кружечки…), і будь-яке сильне
  RTL-письмо (іврит, арабська, сирійська… — поруч із ним «333 7» малюється як «7 333») прибирають текст
  цілком, як і bidi-керувальні символи;
- кирилична «З»/«з» — це 3 у групі з цифрою («733З») або окремо між не-літерами поруч із цифрами
  («7 ЗЗЗ»); у слові («зараз») це літера, і одна мала «з» сама по собі — прийменник («7 з 33»);
- комбінуючі знаки й селектори варіантів після цифри належать їй (keycap-емодзі, закреслені цифри);
- далі цифри всього тексту зливаються підряд, через будь-що, і паузованого номера серед них бути не може.

**Текст AI маскуємо, а не прибираємо** (`maskPausedLine`): відповіді — у стрімі (щоразу вся відповідь
доти, тож номер, розбитий між токенами, ловиться з останньою цифрою), в історії, у статичних копіях
розмови, у живому регіоні, у «Скопіювати текст розмови»; тези — вже в чернетці (`summarize/ok`), тож їх
показуємо, копіюємо й зберігаємо замаскованими, а тег, що складається з номера, відкидаємо; записи
щоденника — у виборі записів, у «Ви повертаєтеся до:» і на `saved`.

- **Чим замінюємо.** На сторінці номер замінює фраза «[цей номер зараз не працює — актуальні контакти в
  «Якщо важко»]». У чернетці тез — коротка «[номер прибрано]» (`PAUSED_LINE_NOTE_SHORT`): чернетка йде в
  щоденник і файл експорту, де «зараз» застаріє, а кнопки «Якщо важко» немає, і довга фраза (63 кодові
  точки) зʼїла б половину ліміту назви. Якщо поле після маски все одно довше за ліміт (назва 120, теза
  500), обрізаємо його по межі слова з «…» і ніколи посеред примітки: людина не мусить виправляти довжину
  тексту, якого не писала.
- **Що рахується номером.** Цілі групи цифр одного числа (групи через ≤ 3 пробіли, дефіси, крапки чи
  невидимі символи), що разом дають рівно номер — і всередині довшого числа з пробілами («0 800 …»):
  зайва маска дешевша за номер на екрані. Групу не розриваємо: число без розривів, довше за номер (з
  цифрою перед ним чи після), — інше число й лишається.
- **Знаки на цифрі.** Комбінуючі знаки й селектори варіантів після цифри належать їй: keycap-емодзі,
  закреслені, обведені цифри — одна група, і виріз забирає знаки останньої цифри. Так само читає й
  `noPausedLine`.
- **«з».** Одна мала «з» між числами — прийменник («7 з 33 випадків»), а не 3. Велика «З» чи кілька
  підряд («7 ЗЗЗ») і далі рахуються.
- **Bidi.** У тексті з цифрою спершу вирізаємо bidi-керувальні символи: override перед перевернутими
  цифрами намалював би номер. Сильне RTL-письмо маска не шукає (фільтр хелплайнів такий текст відкидає,
  а AI сторінки пише українською).
- **Перенос рядка.** Для маски перенос рядка — межа числа: у транскрипті (`white-space: pre-wrap`)
  «73⏎33» справді стоїть на двох рядках. Але назву, тезу, тему, кандидата «→ У тези», рядки щоденника,
  «Збережено», вибору записів і копії тез/запису сторінка малює в один рядок, і браузер склеює перенос у
  пробіл — а «73 33» уже номер. Тому такий текст спершу стає одним рядком (`oneLine`: кожен пробіловий
  проміжок, переноси теж, — один пробіл), і лише потім маскується: на показі — `maskPausedLineInline`
  (текст без номера лишається як був), у чернетці тез і формі редагування — `maskedField` (поле з номером
  лишається одним рядком, без номера — як написав AI), у `markText` — завжди один рядок. Ніколи навпаки:
  маска, а потім склеювання, лишала номер видимим.

Слова людини не маскуємо. Другий рубіж — правило про номери в системному промпті сервера.

Захист у глибину:
- на сервері гілка `fix/4…` прибирає `notes`;
- тест `afterEach` перевіряє, що в `outerHTML` документа немає «7333» (§11).

### 6.4 Розкладка

**Desktop:**
- секція в текстовій колонці (672 px), куля праворуч тиха;
- 112 і 103 стоять поруч, по 50 %, розміром `.help__number`: ≈ 103–112 px на 1440, колір `--color-light`;
- лінії — рядками з тонкими лініями:
  - назва — Onest 600 17 px;
  - номер — моно 22 px `--color-light`, посилання `tel:` з зоною ≥ 48 px;
  - години — `--color-text-soft`.

**Телефон 412 × 839, клавіатура закрита:**
- кулі немає (§3.1, телефон);
- 112 і 103 поруч, по ≈ 182 px, цифри ≈ 57 px (токен `.help__number`: `clamp(3.5rem, 2.4rem + 4.5vw, 7rem)`
  на 412 px), кожне `tel:`-посилання — блок висотою ≥ 64 px;
  `[verified: node -e "…max(56, min(112, 2.4*16 + 0.045*412))" → 56.94]`;
- розрахунок [C]: шапка 56 + 24 + мітка 20 + H1 у 2 рядки ≈ 70 + лід ≈ 110 + 24 + блок номерів ≈ 120
  ≈ 424 px;
- обидва номери видно **без скролу** — це перевіряє тест.

### 6.5 Текст і порядок

| # | Елемент | Текст / дані |
|---|---|---|
| 1 | Тег (моно, `--color-light`) | «Розмову зупинено» |
| 2 | H1 (`.display-2`, менший кегль) | «Якщо вам зараз дуже важко» — так само, як глава 05 лендінгу [P] |
| 3 | Лід (Onest 20 px, `--color-text`) | `message` [A] після санітайзера. Фолбек: «Схоже, зараз вам дуже важко. Ви не мусите проходити через це наодинці. Будь ласка, зверніться до людей, які можуть допомогти просто зараз.» |
| 4 | **112** | Підпис: «**Екстрені служби.** Цілодобово, безкоштовно. Працює в Україні та в усіх країнах ЄС.» `href="tel:112"`, `aria-label="Зателефонувати 112"` |
| 5 | **103** | Підпис: «**Швидка медична допомога.** Цілодобово, безкоштовно.» `href="tel:103"`, `aria-label="Зателефонувати 103"` |
| 6 | H2 і список | «Лінії підтримки», далі `lines[]` після санітайзера |
| 7 | За кордоном | `abroadText` або фолбек, далі посилання «Гарячі лінії «Ти як?»» ↗: `target="_blank" rel="noopener noreferrer"`, прихований текст «(відкриється в новій вкладці)» |
| 8 | Чому розмову зупинено (`.help__check`, dim) | «Розмову зупинено автоматично: у ній трапилися слова, які можуть свідчити про кризу. Ця перевірка може помилятися. Але якщо вам зараз справді важко — будь ласка, не залишайтеся з цим наодинці.» |
| 9 | AI — не служба допомоги [P] | «AI не людина: він не бачить вас і не може викликати допомогу. Якщо комусь загрожує небезпека — телефонуйте 112.» |
| 10 | Що з розмовою [C] | «Продовжити цю розмову не вийде, і тези для неї не створюватимуться. Liora цю розмову не зберігає.» |
| 11 | `<details>` | «Показати текст розмови». Усередині транскрипт лише для читання, усі репліки `--color-text-dim` (без `opacity`). |
| 12 | Дрібно, над діями | «Якщо вам зараз небезпечно, спершу зателефонуйте 112.» |
| 13 | Тихі третинні дії в самому кінці | «-> Почати нову розмову» · «-> На головну» |

Великої кнопки «Нова розмова» поруч із номерами немає свідомо: вона не повинна змагатися з ними за
увагу [P].

### 6.6 Після кризи

**`confirm(new-after-crisis)`:**
- H2 «Почати нову розмову?»;
- текст «Текст цієї розмови зникне зі сторінки.»;
- кнопки «Почати нову» · «Скасувати» (стартовий фокус).

Далі — чиста нова розмова (§3.6) з рядком «Якщо важко — 112 або 103…» нагорі (`ctx.afterCrisis`).
Режим «не зберігати», сценарій і вибрані записи скидаються.

**Затримки й клієнтської блокади немає** [C][P][E — усі згодні]:
- людина доросла;
- сервер перевіряє кожну нову розмову наново;
- у новій історії тих фраз немає.

Якщо власник захоче паузу, потрібне окреме рішення й серверна підтримка.

### 6.7 Чого в кризі немає

- Анімації появи, «тривожного» кольору, звуку.
- Модального діалогу, що замикає людину.
- Таймерів.
- Інструментів самодопомоги (§3.13): відкритий закривається в кадрі кризи, нові не відкриваються, у «Якщо
  важко» їх рядка немає.
- Тексту від імені моделі: блок говорить від імені Liora, а не «AI каже: …».
- Числа 7333 у будь-якому вигляді.

---

## 7. Тези: генерація, перегляд, збереження й видалення

### 7.1 `summarizing`

- **Запит:** `POST /chat/summarize {scenario, messages}`, таймаут 150 с. `messages` — це
  `session.messages`, разом з `opening_message`.
- **Розкладка:** окремий екран у текстовій колонці [E][P]. Транскрипт лишається в памʼяті, і з екрана
  можна повернутися до розмови. Сцена в стані `summary`.

| Елемент | Текст |
|---|---|
| Тег | «Тези» |
| H1 | «AI складає тези» |
| Текст | «Зазвичай це до пів хвилини. Розмова на місці: якщо скасуєте, повернетеся до неї.» Що текст для тез ще раз іде постачальнику AI, людина вже прочитала в `confirm(end)` перед «Підсумувати» (§3.7.8). |
| Після 10 с | Додатковий рядок: «Іноді це триває до двох хвилин.» |
| Каркас | Три рядки «01 —», «02 —», «03 —» (моно `--color-text-dim`, тонкі лінії). Без шимера: блиск — це декоративний рух [P]. |
| Дія | «-> Скасувати й повернутися до розмови» — abort, далі `chat` |
| `llm_busy` | «AI зараз зайнятий іншою розмовою. Пробуємо ще раз через {n} с…» Два автоповтори, далі вручну. Під час відліку це не помилка (`error = null`): «Скласти ще раз» недоступна, щоб поруч із запланованим повтором не пішов другий запит (I2). Після 429 «Скласти ще раз» — лише після відліку. |
| 502 `llm_failed` або таймаут | «AI не зміг скласти тези. Спробуйте ще раз — розмова на місці.» Кнопки: основна «Скласти ще раз» · третинні «-> Повернутися до розмови» і «-> Завершити без тез». |
| `pagehide` до запиту чи до запланованого автоповтору (`aborted`, §5.6) | «Тези ще не складено. Спробуйте ще раз — розмова на місці.» і «Скласти ще раз». Нічого не зламалося, тож без «не зміг». |
| 409 `crisis_stop` | `crisis` (§6) |
| 422 `validation_error` | «Не вдалося скласти тези з цієї розмови.» Кнопки «-> Завершити без тез» · «-> Повернутися до розмови», без автоповтору (§4.3) |
| 401, 403, 413, 429 | §4 |

**Тіло `summarize`:** рівно `{scenario, messages}` — без `revisit_summary_ids` (`extra="forbid"` → 422),
`messages.length ≤ 200` (тримає `canSend`, §3.7.7). Перевіряє тест #32b.

### 7.2 `review`: перегляд і правка

**Рішення (правка):** правимо «на місці» [P]. Окремого режиму «Редагувати» немає: виправити слово —
найчастіша дія, і вона має коштувати один клік.

| Елемент | Текст і поведінка |
|---|---|
| Тег | «Тези · чернетка від AI» |
| H1 | «Перегляньте тези» |
| Вступ | «Тези написав AI — він міг помилитися чи сказати не вашими словами. У щоденник потрапить лише те, що ви залишите й збережете.» |

**Поля.** Межі рахуємо кодовими точками після `trim` — так само, як сервер [E]. Усі текстові поля тут
(назва, тези, новий тег) мають рамку 1 px `--color-text-dim` і кегль ≥ 16 px — як композер (§3.7.3).

| Поле | Розмітка | Межі | Повідомлення |
|---|---|---|---|
| Назва | Мітка «Назва» (моно 11 px). `<input>` Onest 600, 22 px; значення — `title` [A]. | 1..120, без NUL. Лічильник від 100. | «Додайте коротку назву — так запис легше знайти в щоденнику.» · «Назва: до 120 символів.» |
| Тези | `<fieldset>` з легендою «Тези» і `<ol>`. У кожному рядку:<br>• індекс «01» (моно `--color-light`);<br>• `<textarea>` Onest 18 px з автовисотою, прихована мітка «Теза {n}»;<br>• кнопка «×» 44 px, `aria-label="Прибрати тезу {n}"`. | 1..5, кожна 1..500. Лічильник від 450. | «Теза: до 500 символів.» · «Потрібна хоча б одна теза.» |
| Прибрана теза | Рядок згортається в «Тезу прибрано.» і «-> Повернути». Він лишається таким до збереження чи виходу. | — | — |
| Остання теза | Коли лишилася одна активна теза, «×» стає `aria-disabled`, поруч підказка «Має лишитися хоча б одна теза.» [P] | — | — |
| «+ Додати тезу» | Третинна дія під списком, поки активних тез менше 5. Нова теза одразу отримує фокус. | — | — |
| Теги | `<fieldset>` з легендою «Теги». Пілюлі `#{name}` з «×», `aria-label="Прибрати тег «{name}»"`. Поле з прихованою міткою «Новий тег» і плейсхолдером «наприклад, робота», поруч другорядна кнопка «Додати». Enter або кома теж додають тег. Підказка: «До 10 тегів, кожен до 40 символів.» | ≤ 10, кожен 1..40. Дублікати перевіряємо так, як їх зливає сервер (`normalize`: регістр, апострофи, ё→е, пробіли). | «Такий тег уже є.» · «Тег задовгий: до 40 символів.» · «Не більше 10 тегів.» Якщо тегів немає — dim «Тегів немає». |

**Позначене в розмові** (фаза C3, §3.7.2). Під тезами — `<section class="candidates">` з H2 «Позначене в
розмові», лише коли є позначені відповіді, яких ще немає в чернетці. Кожен рядок — цитата відповіді (номер на
паузі замасковано короткою приміткою після того, як пробіли й переноси стиснуто в один рядок, до 500
кодових точок по слову — `markText`) і дві
третинні дії з прихованим хвостом «(позначене N)»:
- «-> Додати до тез» — стає тезою (id поля `m{index}`), фокус у нове поле `#thesis-m{index}`. При 5 активних
  тезах — `aria-disabled` і опис «Тез уже пʼять — щоб додати цю, приберіть одну з них.»; шостої не буває;
- «-> Прибрати» — знімає позначку (і в розмові теж); фокус лишається в списку, далі на «+ Додати тезу» чи
  «Зберегти», не на початку екрана.
- Подвійний клік на «Прибрати» знімає **одну** позначку, а не дві (наступна «Прибрати» підʼїжджає під
  вказівник), на «Додати до тез» — додає одну тезу, і фокус лишається в ній (ревʼю C3, I10, #101).

Позначки не йдуть у `/chat/summarize` і не змінюють тіла `POST /summaries`: туди потрапляє лише текст тези,
як людина її залишила.

**Рішення (прибрана теза):** «Повернути» без таймера [C], а не 8 секунд [P]. Обмеження часу без потреби
порушує WCAG 2.2.1.

**Джерело тегів:**
- теги з чернетки AI → `{name, source: "ai"}`;
- додані людиною або перейменовані → `source: "user"` [P].

**Дії** (на телефоні — стовпчиком на всю ширину):
1. **«Зберегти в щоденник»** — основна.
   - Під час запиту: «Зберігаємо…», `aria-busy`, повторний клік ігнорується.
2. **«Видалити тези»** — другорядна, §7.4.
3. **«-> Скласти заново»** — третинна, через `confirm(regenerate)`:
   - H2 «Скласти тези заново?»;
   - текст «Ваші правки зникнуть, а текст розмови ще раз піде постачальнику AI.»;
   - кнопки «Скласти заново» · «Скасувати».
4. **«-> Повернутися до розмови»** — чернетку відкидаємо, транскрипт на місці, стан `chat`.

**Примітки під діями немає** (фаза B, менше тексту): що повного тексту розмови Liora не зберігає, вже
сказано в згоді (§3.5) і в ⓘ під полем (§3.7.3).

**Режим «не зберігати»:**
- замість «Зберегти в щоденник» — основна «Готово» → `ended`;
- над нею: «Увімкнено «не зберігати»: ці тези зникнуть, щойно ви закриєте сторінку.»;
- друга кнопка — «Скопіювати тези» (буфер обміну, лише на явний натиск);
- `POST /summaries` не робимо.

**Перевірка перед збереженням** (на клієнті, щоб не ловити 422):
- порожні тези тихо прибираємо [C];
- якщо не лишилося жодної, показуємо помилку;
- фокус — на перше хибне поле, повідомлення через `aria-describedby`.

**Тіло запиту:**

```
POST /summaries {
  scenario,
  title: title.trim(),
  bullets: bullets.map(trim).filter(nonEmpty),
  tags: tags.map(t => ({ name: t.name.trim(), source: t.source }))
}
```

**Індекси в 422.** Прибрані («Тезу прибрано.») і порожні тези в тіло не йдуть, тож `bullets.N` з
`details[].field` — це індекс **у відфільтрованому масиві**, а не номер на екрані. Під час побудови тіла
зберігаємо дві таблиці:
- `bulletIndex: fieldId[]` — `bulletIndex[N]` = id поля `<textarea>`, з якого взято `bullets[N]`;
- `tagIndex: tagId[]` — так само для `tags[N]`.

`bullets.N` і `tags.N.name` мапимо лише через ці таблиці; помилка й фокус ідуть на те поле. Приклад: теза
1 прибрана, 422 на `bullets.1` → помилка на **третьому** полі на екрані.

### 7.3 Помилки збереження

| Відповідь | Що робимо |
|---|---|
| 201 | → `saved` |
| 403 `consent_required` (потрібні `data_processing` і `age_18`) | `consent(resume: save)`. Чернетка лишається в памʼяті, після згоди збереження повторюється саме [E]. |
| 403 `not_invited` | `not-invited(hasSession)` з кнопкою «Скопіювати тези» [P][C] |
| 401 | `session-expired` з «Скопіювати тези» |
| 422 | На полях (§4.3) |
| Мережа або таймаут — результат невідомий, сервер міг зберегти (так само 201, тіло якого обірвалося чи не читається) | 1. Рядок «Не вдалося підтвердити збереження. Ваші правки на місці.» і «Спробувати ще раз». Поки результат невідомий, чернетка лише для читання: інакше перевірка нижче порівнювала б запис із пізнішою правкою, а не з тілом, яке ми слали.<br>2. Перед повтором — `GET /summaries?limit=1`: сервер віддає записи за `created_at desc`, тож це найновіший запис. Вважаємо його нашим, лише якщо **весь вміст після `trim` збігається з тілом, яке ми слали**: `scenario`, `title`, `bullets` (той самий порядок) і множина назв тегів після тієї самої `normalize`, що на сервері (тег, що вже є, повертається під збереженою назвою: «робота» на «Робота»). Тоді → `saved` без другого POST. Так не буде дубля [E].<br>3. Вік запису рахуємо від заголовка `Date` відповіді цього GET (`Date − created_at ≤ 2 хв`), а не від `Date.now()`: обидва значення — годинник сервера, тож зсув годинника пристрою не дає ні дубля, ні хибного «збережено». Без `Date` — лише збіг вмісту.<br>Однакова назва сама по собі нічого не доводить: fake-LLM завжди дає «Розмова про день». `[verified: sed -n 240,256p server/app/summary/journal.py → order_by(Summary.created_at.desc(), Summary.id.desc())]` |
| 429 | «Забагато запитів поспіль. Спробуйте за хвилину — ваші правки на місці.» (§4.3), без відліку |
| 5xx, порожнє тіло | Текст за §4 |

**Після невідомого результату** (`maybeSaved`) запис, можливо, уже є в щоденнику. Поки перевірка
(`GET /summaries?limit=1`) не показала, що його немає, і поки не почалася нова розмова, жоден текст не
каже, що в щоденник нічого не потрапило. Так у `confirm(discard)`, у `confirm(end-no-theses)` (сюди можна
прийти через «Повернутися до розмови» чи «Скласти заново») і на екрані `ended` (§7.6): там варіант
«Збереження тез не підтвердилося».

### 7.4 «Видалити тези» (`confirm(discard)`)

| Елемент | Текст |
|---|---|
| H2 | «Видалити тези?» |
| Текст | «Liora їх не зберігала, тож повернути їх не вийде. Текст розмови теж зникне з цієї сторінки.» |
| Текст після невідомого результату (§7.3) | «Збереження не підтвердилося: можливо, тези з цієї розмови вже є у вашому щоденнику — це видно у файлі щоденника в меню «Акаунт». Чернетка й текст розмови зникнуть з цієї сторінки.» Не «ці тези»: `maybeSaved` переживає «Скласти заново» і «Повернутися до розмови» → новий підсумок, тож на екрані може стояти чернетка, яка не відправлялася ніколи, а в щоденнику — хіба попередній варіант. Те саме в `confirm(end-no-theses)`: «…можливо, тези з цієї розмови вже є у вашому щоденнику…». |
| Кнопки | Небезпечна «Видалити» → `ended`. «Залишити» — стартовий фокус. |

Запиту до API немає: «не зберігати» означає просто не робити POST (ADR-005).

### 7.5 `saved`

| Елемент | Текст |
|---|---|
| Тег зі світною крапкою (`.mark--on`) | «Збережено в щоденник» |
| H1 | «Тези у вашому щоденнику» |
| Запис лише для читання, з відповіді [A] | Назва, тези з індексами, теги (моно). Дата моно: «{7 жовтня 2026, 14:52}» з `created_at` через `Intl.DateTimeFormat('uk')`. |
| Текст | «Розмову завершено, і її текст уже прибрано з цієї сторінки. Усі записи щоденника можна завантажити файлом:» і «-> Завантажити щоденник (.md)» |
| Текст 2 | — (фаза B: прибрано; обіцянку про сторінку щоденника не даємо, файл є вже зараз) |
| «Взяти з собою» (фаза C3) | Лише якщо серед збережених тез є та, що прийшла з «→ У тези»: мітка «Взяти з собою» і перша така теза, як її зберіг сервер. Інакше блоку немає — ми не вибираємо думку за людину. |
| Рядок про людей | «Можливо, варто поділитися цим із кимось близьким?» Замість «Добре, що ви знайшли на це час.»: без похвали й без того, що тримає людину на сторінці (фаза C3). |
| «А зараз?» (лише з чек-іном на початку, §3.13) | «Спершу — {слово}.» / «Спершу — {слово}, зараз — {слово}.» і «-> А зараз?». Те саме на `review` під діями. |
| Дії | Основна «Почати нову розмову» · третинні «-> Відкрити щоденник» (§7.7) і «-> На головну» в один рядок |

**Ефекти:**
- транскрипт стираємо з памʼяті (звільняємо всі посилання);
- знімаємо `beforeunload`;
- сцена в стані `saved` — стан 5, «тези в склі»;
- оновлюємо `GET /summaries?limit=20`: тепер доступне «Повернення до теми».

### 7.6 `ended` (без збереження)

| Елемент | Текст |
|---|---|
| Тег | «Розмову завершено» |
| H1 | «У щоденник нічого не потрапило» |
| Текст | «У Liora немає ні тексту цієї розмови, ні тез, ні запису в щоденнику. Текст розмови прибрано з цієї сторінки.» Перелік замість «нічого не залишилося»: технічні записи без тексту сервер пише й тут (рядок 4 екрана згоди, §3.7.8), а про журнали постачальника AI ми не обіцяємо нічого [E]. |
| Рядок про людей | «Можливо, варто поділитися цим із кимось близьким?» (фаза C3, без похвали) |
| Тихий рядок | «Якщо після розмови стало важче — 112, 103 або гарячі лінії «Ти як?».» Номери — `tel:`, посилання — нова вкладка. |
| «А зараз?» (лише з чек-іном на початку, §3.13) | Як на `saved`. |
| Дії | Основна «Почати нову розмову» · третинні «-> Відкрити щоденник» (§7.7) і «-> На головну» в один рядок |
| Після невідомого результату збереження (§7.3) | H1 «Збереження тез не підтвердилося». Текст: «Можливо, тези все ж потрапили у ваш щоденник — це видно у файлі щоденника. Тексту цієї розмови в Liora немає, і з цієї сторінки його прибрано.» Дія «-> Завантажити щоденник (.md)». |

### 7.7 `journal`: щоденник

Окремий екран на тій самій адресі `/chat/` (нових шляхів немає). Ядро — `core/journal.ts` і гілка
`journal/*` у `state.ts`; DOM — `ui/screens/journal.ts`.

**Вхід** (лише коли `canOpenJournal`):
- меню «Акаунт», рядок «Щоденник» — другорядна кнопка «Відкрити щоденник» (§8.3);
- `saved` і `ended` — третинна «-> Відкрити щоденник» поруч із «-> На головну».

У шапці кнопки немає: на 320 px там лишається близько 2 px. Поки летить хід, тези чи інший запит, входу
немає: розмова під щоденником має чекати, а не йти.

**Запити — лише на вході, ніколи на старті сторінки:** `GET /reviews/weekly[?tz]` ‖ `GET /tags` ‖
`GET /summaries?limit=20`. `tz` — зона з `Intl.DateTimeFormat().resolvedOptions().timeZone` (≤ 64 символи).

| Елемент | Текст і поведінка |
|---|---|
| Назад | Другорядна мала кнопка з намальованим шевроном: «До розмови» (відкрито з `chat`) або «Нова розмова» (з `saved`/`ended`). «До розмови» повертає розмову, неподане повідомлення, блок «Записів… уже немає» і текст у полі вводу як були. |
| H1 | «Щоденник», `tabindex="-1"`, фокус на вході |
| Тиждень | Одна світла поверхня (`--color-surface`, `--radius-dialog`), не картка серед карток.<br>• Заголовок h2: «Цей тиждень» або діапазон «12–18 жовтня», «28 вересня – 4 жовтня» (рік — коли тиждень не цьогорічний). Неділя — `week_end` сервера мінус день.<br>• Кнопки 44 × 44 px з `aria-label` «Попередній тиждень» / «Наступний тиждень». На поточному тижні й поки тиждень вантажиться — `aria-disabled="true"`: лишаються у фокусі, натиск нічого не шле.<br>• Рядок: «1 збережений запис», «2 збережені записи», «5 збережених записів» (`sessions`), «Збережених записів немає.»<br>• Рядок: «Теми: робота, сон» з `top_tags` (без тем рядка немає).<br>• Помилка: «Не вдалося завантажити огляд тижня.» і «-> Спробувати ще раз».<br>Нічого не порівнюємо й не оцінюємо: ні дельт, ні «більше/менше», ні графіків. Поки вантажиться інший тиждень, під новим заголовком немає старих чисел. |
| Пошук | Мітка «Пошук», `type="search"`, `autocomplete="off"`, підказка в полі «Слово з назви, тези чи теми». Запит — через 300 мс після останнього символу, Enter — одразу. `q` обрізаємо, ≤ 200 кодових точок, без NUL; порожній не шлемо. |
| Теми | `fieldset` «Теми»: радіо-пілюлі «Усі теми», «#робота», … з `GET /tags`. Тема й пошук разом — AND на сервері; «Показати ще» тримає обидва. Без тем (порожньо або помилка `/tags`) групи немає. Тема, якої після правки чи видалення не стало, знімається, і список іде без неї. |
| Список | `ol` «Записи», тонкі лінії між записами, без карток. У записі: дата моно «20 жовтня 2026» (з `created_at` за годинником сторінки), «20 жовтня 2026 · змінено», коли є `edited_at`; назва h2; тези з «01», «02»; теми моно «#робота #сон»; дії «Редагувати» · «Копіювати» · «Повернутися до цього» · «Видалити» з `aria-describedby` на назву. |
| Статус | `role="status"`: «Завантажуємо записи…», «Не вдалося завантажити записи.» і «-> Спробувати ще раз», «Зміни збережено.», «Запис видалено.», «Цього запису вже немає в щоденнику.», помилка видалення (§4.3). |
| Порожньо | Порожній щоденник — один рядок «Тут зʼявляться тези, які ви збережете після розмови.», без тижня, пошуку й тем. Пошук без результату: «За запитом «{q}» нічого не знайшлося.»; тема без результату: «Записів із цією темою немає.» Тиждень і пошук при цьому лишаються. |
| «Показати ще» | Третинна, коли є `next_cursor`: `GET /summaries?limit=20&cursor=…[&q][&tag]`, нове дописуємо в кінець без повторів. |

**Правка на місці** (один запис за раз; інші «Редагувати» — `aria-disabled`):
- поля «Назва», «Тези» («Теза 1»…, «+ Додати тезу» до 5), «Теми» з підказкою «Через кому.»; «Зберегти» ·
  «Скасувати»; Esc у формі — те саме, що «Скасувати». Фокус: у назву на відкритті (курсор на початку, щоб
  довга назва в однорядковому полі показувала свій початок, а не кінець), назад на «Редагувати»
  після закриття, на нове поле тези після «+ Додати тезу»;
- перші значення — як на сторінці: номер на паузі замасковано короткою приміткою (§6.3; номер, розірваний
  переносом рядка, теж — поле читаємо одним рядком, `maskedField`), тему, що його містить, не показуємо;
- нічого не змінилося → форма закривається без запиту: сервер ставить `edited_at` на кожен PATCH;
- перевірка — як у тез (`validateDraft`): помилка на полі, фокус на перше хибне;
- PATCH шле всі три поля. Тема, що вже була в записі (за нормалізацією сервера), іде зі своїм `source` —
  `'ai'` лишається `'ai'`; нова — `'user'`; порожні частини й повтори випадають;
- 403 `consent_required` → `consent(resume)` з банером «Щоб зберегти зміни в щоденнику, потрібна ваша згода.
  Після неї вони збережуться самі.» Після згоди той самий PATCH іде ще раз сам, і щоденник повертається
  як був (і тоді, коли розмови під ним немає);
- після PATCH чи DELETE знову `GET /tags` і тиждень. Відповіді `/tags` мають мітку запиту: старша, що прийшла
  пізніше, нічого не змінює. Якщо оновлення тем впало, показані пілюлі лишаються — інакше вибрану тему
  не було б чим зняти;
- `ctx.diary` («Обрати записи» і «Ви повертаєтеся до:» читають його) міняємо на місці: PATCH підставляє
  новий запис, DELETE прибирає. Без `GET /summaries?limit=20`, тож немає миті, коли запис, до якого
  повертаються, лишився без назви. Якщо так спорожніла перша сторінка, а далі є ще записи, її просимо
  знову. Коли `ctx.diary` ще не завантажено, лишаємо як є: відповідь у дорозі стоїть;
- пошук, тема чи зняття теми, що дають нову першу сторінку без запису, який зараз правлять, цей запис не
  прибирають: він лишається першим разом із формою і введеним текстом. Після закриття форми він знову
  звичайний запис;
- поки PATCH летить (і поки летить DELETE), «До розмови» і «Повернутися до цього» мають `aria-disabled` і
  нічого не роблять: відповідь — збережено, помилка, згода — показує ця сторінка. Ядро тримає це саме
  (`journalBusy`), бо `act()` не дивиться на `aria-disabled`. Якщо PATCH попросив згоди, поки летів
  DELETE, відповідь на DELETE губиться; після згоди запис більше не позначено як той, що видаляється.
  Повторне «Видалити» дасть 404, і це теж «видалено».

**Видалення:** `confirm(delete-summary)` — «Видалити запис?» / «Повернути його не вийде.» / небезпечна
«Видалити» · «Залишити» (фокус). DELETE 204 (або 404 — уже немає) → запис зникає, «Запис видалено.».
Фокус — на «Редагувати» запису, що став на його місце, інакше попереднього, інакше на h1; на `<body>` не
падає ніколи. Поки DELETE летить, «Редагувати» цього запису має `aria-disabled`. Сторінка, яку видалення
спорожнило, коли далі є ще записи, вантажиться знову з початку з тими самими пошуком і темою: рядок
«Тут зʼявляться тези…» над непорожнім щоденником був би неправдою.

**«Показати ще»** для останньої сторінки зникає. Якщо фокус був на ній, він переходить на «Редагувати»
першого нового запису, а не вгору на h1. Якщо ця сторінка не завантажилася — на «Спробувати ще раз».

**«Копіювати»:** запис як Markdown — `## {назва}`, `_{дата}_`, `- {теза}`, `Теми: робота, сон` — з
моделі, а не зі сторінки; номер на паузі замасковано. «Скопійовано» на 2 с і в live-регіоні; невдача —
«Не вдалося скопіювати. Виділіть запис вручну.»

**«Повернутися до цього»:** нова розмова «Повернення до теми» з цим одним записом. Якщо запису немає в
`ctx.diary` (знайдений пошуком чи на іншій сторінці), його додаємо туди для «Ви повертаєтеся до:». Якщо
`ctx.diary` ще не завантажено, там буде лише цей запис, а перша сторінка, що ще в дорозі, відкидається:
вона замінила б щоденник без нього. Пікер записів далі тримає назви обраних: позначений запис із пошуку
одразу потрапляє в `ctx.diary`, а перша сторінка пікера не прибирає обраних. Після 404 пікер цього не
робить: одного з обраних уже немає. Над
розмовою з повідомленням людини — спершу `confirm(revisit-restart)`: «Почати нову розмову?» / «Поточна
розмова закриється, і її текст зникне зі сторінки.» / «Почати нову» · «Скасувати» (фокус); поле вводу
очищаємо. Без сценарію `revisit` (впав `GET /scenarios`) кнопки немає.

**Тиждень і час.** Тиждень рахує сервер: `week_start` — будь-який день, він зсуває до понеділка в `tz`.
Клієнт лише крокує на ±7 днів календарно (UTC, без годинника й бази зон) і не йде далі поточного тижня з
першої відповіді. 422 `invalid_timezone` → один повтор з `Europe/Kyiv` (§4.3).

**Памʼять.** Записи, пошук і тиждень живуть лише в памʼяті вкладки й у DOM цього екрана. Виходячи з
екрана, список, теми, поле пошуку й рядки очищаємо. У `data-*` — лише id запису. Сховищ не чіпаємо.
`beforeunload` — лише коли під щоденником чекає розмова з повідомленням людини.

**Рух.** Форма правки підіймається як повідомлення (220 мс, 4 px) лише з `html[data-motion='on']`, як
решта руху чату: за `prefers-reduced-motion: reduce` атрибут типово `off`, і вмикає його лише явний вибір
людини (`src/ui/motion.ts`). Без View Transition між екранами.

---

## 8. Меню акаунта і видалення акаунта

### 8.1 Кнопка

Кругла кнопка 40 px у стилі `.menu-toggle` (§3.1):
- `aria-label="Акаунт"`, `aria-haspopup="dialog"`, `aria-controls`;
- видна лише тоді, коли є сесія. На `session-expired` її немає, і меню туди не відкривається: сесія вже
  скінчилася, а операція акаунта, що впала там із 401, лишила б кнопки підтверджень «зайнятими».

### 8.2 Вигляд

- **Desktop:** бічний аркуш праворуч, 26rem на всю висоту, `padding: 1.5rem`, лінія ліворуч [E].
- **Телефон:** на весь екран, як `.site-menu`.
- **Закриття:** «Закрити» або Esc, після чого фокус повертається на кнопку «Акаунт».

### 8.3 Вміст, згори вниз

Розділи йдуть рядками з тонкими лініями.

| Розділ | Текст і дії |
|---|---|
| Голова | «Акаунт» · кнопка «Закрити» |
| «Ви увійшли як» | `{email}` [A /me] через `textContent`, `overflow-wrap: anywhere` |
| «Щоденник» | Другорядна мала кнопка «Відкрити щоденник» (§7.7) — лише коли `canOpenJournal` (розмова, у якій нічого не летить, `saved`, `ended`). У шапці її немає: на 320 px там лишається близько 2 px.<br>Текст: «Завантажте всі збережені тези файлом.»<br>Посилання: `<a href="/api/v1/export?format=md" download>` «Файл .md» і `<a href="/api/v1/export?format=json" download>` «Файл .json».<br>Під ними dim: «Файл збережеться на цей пристрій.» |
| «Згоди» | Три рядки, у кожному дата з `granted_at` [A] і третинна кнопка «Відкликати» → `confirm(revoke)` (§8.6):<br>• «Обробка даних — надано {дд.мм.рррр}»;<br>• «Передача тексту {provider} — надано {…}»;<br>• «Мені виповнилося 18 років — надано {…}». |
| «Вигляд» | Радіогрупа «Фон»: у темній темі «Ніч» (за замовчуванням) · «Сутінки» · «Світанок», у світлій — «День» · «Вечір» · «Ранок» (фаза C3: «Ніч» над папером була неправдою). Значення ті самі — `night` / `dusk` / `dawn`; CSS показує назву своєї теми (`.sky-name--dark` / `--light`), друга `display: none` і в назву не входить.<br>Підпис: «Вибір памʼятає цей браузер, на сервер він не потрапляє.»<br>`liora:sky` пишемо лише після явного вибору. Вибір «Ніч» ключ видаляє (§9.2). |
| Вихід | Другорядна «Вийти» (§8.4) |
| Видалення | Після відступу 24 px і лінії — небезпечна третинна «Видалити акаунт…» → `confirm(delete-account)` |
| Примітка (моно 11 px dim) | «Ви розмовляєте з AI, а не з людиною. Не терапія й не медична допомога.» |

**Рішення (відкликання згод):** робимо його в MVP [C][E], а не відкладаємо [P].
- Це один `DELETE /consents/{kind}`.
- Відкликати згоду має бути так само легко, як дати (GDPR ст. 7(3)).
- На це посилається екран згоди («Там само можна … відкликати будь-яку згоду»).

### 8.4 Вийти

1. Якщо є що втратити (I7) — спершу `confirm(logout)`:
   - H2 «Вийти з акаунта?»;
   - текст «Поточна розмова закриється, і її текст зникне зі сторінки: Liora його не зберігає.»;
   - кнопки «Вийти» · «Скасувати».
2. Скасувати стрім → `POST /auth/logout` (завжди 204) → стерти транскрипт → `signed-out(logged-out)`.
3. Помилки:
   - 403 `csrf_failed` → «Не вдалося вийти. Оновіть сторінку й спробуйте ще раз.»;
   - мережа → «Не вдалося вийти — немає зʼєднання. Спробуйте ще раз.»

### 8.5 Видалити акаунт (`confirm(delete-account)`)

Стартовий фокус — на «Скасувати».

| Елемент | Текст |
|---|---|
| H2 | «Видалити акаунт назавжди?» |
| Що видаляємо одразу | «Одразу видалимо: усі записи щоденника — назви, тези, теги; ваші згоди; входи на всіх пристроях; ваш email та ідентифікатор Google.» |
| Що лишиться | «Що лишиться: службовий запис — номер акаунта й дата видалення, щоб видалення не скасувалося при відновленні даних із резервної копії. Технічні журнали сервера без тексту розмов, з псевдонімом замість акаунта; вони з часом перезаписуються.» |
| Постачальник AI | «Те, що під час розмов отримав постачальник AI, {provider}, зберігається за його умовами — Liora видалити це не може.» Прикладка без дужок, як у §3.5: значення з контракту вже має дужки, і «({provider})» дало б «(Ollama Cloud (Ollama Inc.))». |
| Незворотність | «Відновити акаунт не вийде. Якщо захочете повернутися, можна увійти знову — це буде новий, порожній акаунт.» |
| Експорт | «Хочете зберегти щоденник? Спершу завантажте його:» «-> Файл .md» «-> Файл .json» |
| Якщо є транскрипт | «Поточна розмова теж зникне.» |
| Кнопки | Небезпечна «Так, видалити все» · «Скасувати» |

**Рішення:** без додаткового чекбокса «Я розумію…» [C][E]. [P] його пропонував, але явний напис
кнопки і стартовий фокус на «Скасувати» вже дають достатньо тертя. Чекбокс додав би крок без нової
інформації.

**Механіка:**
1. Скасувати стрім → `DELETE /me`. Ефект памʼятає `deleteAttempt: 'none' | 'unknown'` — чи була вже
   спроба з невідомим результатом.
2. 204 → стерти все, `ctx.diary` = порожній → `account-deleted(confirmed)`.
3. Помилки:
   - мережа, таймаут, 5xx без тіла → `deleteAttempt = 'unknown'`; у діалозі: «Не вдалося підтвердити
     видалення. Спробуйте ще раз — повторний запит нічого не зламає.» і «Код запиту: {id}»;
   - 401 і `deleteAttempt = 'none'` (перша спроба) → `signed-out` з банером «Вхід завершився. Увійдіть,
     щоб видалити акаунт.»;
   - 401 і `deleteAttempt = 'unknown'` → стерти все → `account-deleted(presumed)`: перший запит, найімовірніше,
     дійшов і стер акаунт разом із сесією;
   - 403 `csrf_failed` → за §4.

**Чому повтор — не «завжди 204».** `DELETE /me` вимагає живої сесії (`CurrentUserDep`). 204 на повтор
отримує лише **паралельний** запит, що чекав на lock (подвійний тап); послідовний повтор після того, як
перший стер акаунт, приходить уже без сесії й отримує 401. Якби на нього показували «Увійдіть, щоб
видалити акаунт», вхід створив би **новий** акаунт.
`[verified: sed -n 35,70p server/app/api/account.py → «async def delete_me(user: CurrentUserDep, …)», «A second request (double tap, client retry) that waited on the lock…»; grep test_hardening.py → 430: test_a_double_tapped_account_deletion_answers_204_twice]`
Рядок контракту «repeat = 204» стосується саме паралельного повтору.

**`account-deleted`:**

| Елемент | Текст |
|---|---|
| Тег | «Акаунт видалено» |
| H1 | «Акаунт видалено» |
| Текст, `confirmed` | «Ми видалили ваш щоденник, згоди, входи на всіх пристроях, email та ідентифікатор Google. Файл cookie сесії прибрано з цього браузера.» |
| Текст, `presumed` | «Схоже, акаунт уже видалено: сесії на сервері більше немає. Якщо увійдете знову, це буде новий, порожній акаунт.» Текст 3 у цьому варіанті не показуємо — він повторює це речення. |
| Текст 2 | «Те, що під час розмов отримав постачальник AI, зберігається за його умовами.» |
| Текст 3 | «Якщо захочете повернутися, увійдіть знову — це буде новий, порожній акаунт.» |
| Дія | «-> На головну» |
| Рядок допомоги | Як на екрані входу (§3.3) |

### 8.6 Відкликати згоду (`confirm(revoke)`)

| Вид | H2 | Текст | Кнопки |
|---|---|---|---|
| `data_processing` | «Відкликати згоду на обробку даних?» | «Відкликання цієї згоди одразу видалить увесь ваш щоденник — назви, тези й теги, без можливості відновити. Акаунт залишиться, а розмови з AI стануть недоступні, доки ви знову не погодитеся.» Далі експорт («-> Файл .md» «-> Файл .json») і, якщо є транскрипт, «Поточна розмова закриється.» | Небезпечна «Відкликати й видалити щоденник» · «Скасувати» (стартовий фокус) |
| `llm_transfer` | «Відкликати згоду на передачу тексту {provider}?» | «Без неї AI не зможе відповідати: розмови стануть недоступні, доки ви знову не погодитеся. Щоденник залишиться.» Якщо є транскрипт — «Поточна розмова закриється.» | «Відкликати» · «Скасувати» |
| `age_18` | «Відкликати підтвердження віку?» | «Без нього розмови й збереження тез недоступні. Щоденник залишиться.» Якщо є транскрипт — «Поточна розмова закриється.» | «Відкликати» · «Скасувати» |

**Механіка:**
1. `DELETE /consents/{kind}` → 200.
2. Для `data_processing` — `ctx.diary = { items: [], nextCursor: null }`: сервер щойно стер щоденник, і
   «Повернення до теми» не повинне показувати видалені записи (інакше хід отримав би 404).
3. Стерти транскрипт → `consent(first)`.
   - Виняток — `crisis` (I5): пізня відповідь лише оновлює дані акаунта (`consents`, `diary`, `me`,
     знімає операцію revoke) і закриває свій confirm, якщо він ще згори. Контакти лишаються на екрані.
     Згода, якої тепер бракує, відкривається на «Почати нову розмову» — перед новою розмовою
     (`ctx.afterCrisis` зберігається).
4. Помилка → у діалозі: «Не вдалося відкликати згоду. Спробуйте ще раз.»

---

## 9. Модулі й файли, сцена, зміни на лендінгу

### 9.1 Файли в `web-client`

```
web-client/
  index.html                       лендінг: CTA, посилання кулі, футер, FAQ (§9.4)
  chat/index.html                  усі екрани — <section data-screen hidden>; статичний текст; <template>-и реплік
  vite.config.ts                   multi-page, preview.headers, no-store для /chat/ (§9.5, §10.4)
  deploy/Caddyfile                 заголовки (§10.3)
  src/
    main.ts                        лендінг (+ переадресація ?auth_error, §9.4)
    gl/
      core/                        фаза 4 «зараз»
        boot.ts                    ← src/gl/boot.ts; bootGL(canvas, { load, tier?, dprCap?, sizeTo? })
        quality.ts                 ← src/gl/quality.ts; Tier + msaa/charLod/envSize; pickTier({ force? }); FrameGovernor
        palette.ts                 ← src/gl/palette.ts
        renderer.ts                createRenderer(canvas, { msaa }) — ті самі параметри WebGLRenderer, що зараз
      scene.ts                     лендінг: ScrollStates + heroLight, як зараз, але через нові seams
      presence.ts                  чат: куля в слоті; setPresence / pulse; без скролу й hero-light (§9.2)
      neural.ts shapes.ts shaders/ спільні, без змін
      scroll.ts pointer.ts random.ts без змін
    ui/
      motion.ts                    без змін (liora:motion)
      sound.ts                     + режим керування з чату (§9.3)
      sky.ts                       liora:sky: читає й пише лише після явного вибору; html[data-sky]
    chat/
      core/                        без document/window/navigator/HTMLElement/localStorage/sessionStorage/indexedDB/three/../ui
        types.ts                   DTO з server/openapi.json: MeOut, ConsentState, ScenarioOut, ChatEvent,
                                   SummaryDraftOut, SummaryOut, ErrorBody
        api.ts                     createApi({ fetch }) → me, consents, grant, revoke, scenarios, summaries,
                                   turn(req, signal) → Response, summarize, saveSummary, deleteMe, logout, helplines,
                                   patchSummary, deleteSummary, tags, weekly; summariesPath, weeklyPath, patchBody
        sse.ts                     readFrames, chatEvents (§5.3–5.4)
        turn.ts                    runTurn: watchdog-и, повтори → TurnOutcome (§5.5)
        errors.ts                  ApiError, fromResponse, retryAfterMs (§4.1)
        limits.ts                  MAX_MESSAGES = 200, MAX_CONTENT = 4000, codePoints, canSend, validateDraft
        helplines.ts               sanitizeHelplines, FALLBACK (§6.3)
        country.ts                 countryName(code, displayNames) — Intl передаємо ззовні
        journal.ts                 щоденник без DOM: shiftDay, searchQuery, formOf, tagsFromText, patchOf (§7.7)
        selfhelp.ts                інструменти без DOM: breathAt (4/6 і зітхання), MOOD_WORDS, NO_MOOD (§3.13)
        state.ts                   State, Action, reduce (§2)
      ui/
        main.ts                    вхід chat/index.html: стилі, initMotionToggle, sound, sky, store, scene
        store.ts                   dispatch → reduce → effects → render
        effects.ts                 api, AbortController-и, таймери, beforeunload
        render.ts                  hidden на секціях; зміна State.s → закрити діалоги, фокус на h1; атрибути стану
        screens/*.ts               sign-in, not-invited, consent, compose, chat, crisis, summary, saved, ended,
                                   account-deleted, fatal
        transcript.ts              append-only рендер через <template> + textContent; Text.appendData; rAF-флаш;
                                   скидання буфера на фіналі (§5.7)
        composer.ts                textarea, клавіші, IME, лічильник кодових точок, автовисота
        scroll-anchor.ts           якір надсилання, пілюля «↓»; ResizeObserver → --header-h, --session-h, --composer-h
        keyboard.ts                visualViewport → --kb, --vvh і html[data-kb] (§3.1 «Екранна клавіатура»)
        announcer.ts               один live-регіон, ≤ 2 непорожні оновлення за хід; очищення (§5.7)
        dialogs.ts                 account, help, revisit-pick, confirm(kind), інструменти; стек account → confirm,
                                   help → інструмент, shelter → дихання / заземлення; opener → фокус
        tools.ts                   дихання, заземлення, чек-ін, укриття (§3.13): годинник вправи, кроки, слова
        leave-guard.ts             beforeunload за I7 (+ виняток tel:); pagehide → abort('pagehide'); pageshow(persisted) → GET /me
        presence.ts                data-presence ↔ сцена й звук
        clipboard.ts               копія транскрипту чи тез у форматі §3.8; entryMarkdown — запис щоденника (§7.7)
        screens/journal.ts         щоденник (§7.7): тиждень, пошук і теми, записи за id, правка на місці, фокус
        copy.ts                    динамічні рядки: помилки, відліки, анонси, словник описів сценаріїв
    styles/
      tokens.css                   + --radius-field, --radius-dialog
      stage.css                    кольори неба → custom properties; html[data-sky] (§9.2)
      components.css               + .orb — спільний вигляд статичної кулі (.hero__orb і чат)
      chat.css                     сітка чату, рядок сесії, транскрипт, композер, діалоги, криза
  tests/e2e/
    chat.spec.ts                   моки API; CI (desktop + mobile)
    chat-core.spec.ts              чисте ядро без page; лише проєкт desktop
    chat.stack.spec.ts             @stack; лише локально
    chat-fixtures.ts               mockApi, sse(), fetch-shim, аудит сховищ, stop-list
    header.spec.ts, landing.spec.ts  + CTA, посилання кулі, футер, CSP (§11.7)
```

**Що де лежить** [E]:
- Статичний текст — у `chat/index.html`.
  - Власник ревʼюїть його в одному файлі, як на лендінгу.
  - Перший показ працює без JS (є `noscript`).
- Динамічні рядки — в одному `ui/copy.ts`.
- Мобілка все одно писатиме свій текст окремо (ADR-007, «Consequences»).

**TypeScript:** `tsconfig` має `erasableSyntaxOnly`, тож у `core` немає `enum`, `namespace` і
parameter properties.

**Обмеження імпортів** перевіряє тест (§10.5):
- `core` не залежить від `ui`;
- `localStorage.setItem` є лише в `src/ui/motion.ts` і `src/ui/sky.ts`.

Окремий `tsconfig` для `core` без `lib.dom` відкинуто [E]: довелося б вручну переписувати типи для
`fetch`, `ReadableStream`, `AbortSignal` і `TextDecoder`. Grep-тест дешевший і ловить те саме.

### 9.2 Як сцена чату використовує `src/gl`

**Seams, яких зараз немає** (перевірено в коді цієї сесії):
- `src/gl/boot.ts` жорстко робить `import('./scene')`.
- `createScene` (`scene.ts`) сам створює `ScrollStates`, читає `heroLight()` і міряє вікно через
  `probe.style.cssText` (`scene.ts:503`).
- `pickTier()` читає `?tier` і параметри пристрою. Тир `low` має `dprCap: 1.25` і `bokeh: 80`, а не DPR 1.
- `sound.ts` вимикає звук у кризі через `IntersectionObserver` над `[data-gl-quiet]`, зібраними під час
  ініціалізації. Атрибут, доданий пізніше, він не помітить.

**Зміни:**
1. **Перенести** `boot.ts`, `quality.ts` і `palette.ts` у `src/gl/core/`. Додати
   `renderer.ts: createRenderer(canvas, { msaa })` з тими самими параметрами `WebGLRenderer`:
   `alpha`, `premultipliedAlpha`, `depth: false`, `powerPreference: 'low-power'`,
   `failIfMajorPerformanceCaveat`. Це фаза 4 «зараз».
2. **`bootGL(canvas, opts)`** з опціями `{ load: () => Promise<SceneModule>; tier?: TierName; dprCap?: number; sizeTo?: HTMLElement }`.
   - Лендінг: `{ load: () => import('../scene') }` — поведінка не змінюється.
   - Чат: `{ load: () => import('../presence'), tier: 'low', dprCap: 1, sizeTo: slotEl }`.
   - Логіка `offReason` та сама: reduced motion, «Пауза», forced-colors, Save-Data, немає WebGL2,
     програмний рендер, повільні кадри, втрата контексту → статична `.orb` і
     `html[data-gl="off"][data-gl-reason]`.
3. **`Tier`** отримує поля `msaa: 0 | 4`, `charLod: 'low' | 'high'`, `envSize: number`. Поки це лише
   значення за замовчуванням, вони потрібні фазі 4. `pickTier({ force })`: `force` має пріоритет над
   `?tier` і пристроєм. Чат — `force: 'low'`, `dprCap: 1`, боке 0.
4. **`presence.ts`** — новий модуль сцени для чату.
   - Бере з лендінгу `neural.ts`, `shapes.ts`, шейдери, скляну сферу й ореол.
   - Композиція одна: стан 0 у центрі слота.
   - Розмір бере з `sizeTo` через `ResizeObserver`, а не з вікна.
   - Немає `ScrollStates`, hero-light і боке.
   - API: `PresenceHandle extends SceneHandle { setPresence(p: Presence): void; pulse(): void }`.
   - `FrameGovernor` той самий: 30 fps через 2 с спокою, 20 fps через 8 с, повна частота під час стріму.
5. **Канвас** стоїть у `.presence__slot`: на desktop це липка колонка сцени, на телефоні — слот у новій
   розмові.
   - `position: absolute; inset: 0`, радіальна маска.
   - `html[data-gl='on'] .presence .orb { opacity: 0 }` — як `.hero__orb`.
6. **Телефон:**
   - GL працює, лише поки видно слот нової розмови;
   - після першого «Надіслати» — `pause()`, на новій розмові — `resume()`;
   - у прихованій вкладці — `pause()`, як на лендінгу.
7. **«Пауза»** — той самий `initMotionToggle` і ключ `liora:motion`.
8. **`scene.ts:503`**: замінити `probe.style.cssText = …` на `setProperty`. Це пункт плану: CSSOM `style-src`
   не блокує, але grep-правило забороняє `.cssText` (§10.5).

**Стани присутності.** Один атрибут `data-presence` на корені `.presence` [P] керує:
- WebGL-кулею;
- CSS-кулею;
- міткою стану;
- звуком;
- у фазі 4 — позою персонажа.

| `data-presence` | Сцена (номери станів лендінгу) | CSS-куля (з рухом) | Мітка під кулею | Настрій звуку |
|---|---|---|---|---|
| `idle` | 0: ядро в склі, повільне обертання, `fire 0.2` | Як `.hero__orb` | «Чекає на ваше повідомлення» | 0 |
| `listening` (людина друкувала < 1.5 с тому) | 0, ядро тепліше на 10 % | Без змін | Без змін | — |
| `thinking` | 2: сигнал біжить ланцюгом, `fire 0.6` | Свічення ядра 0.6 → 1, 2.4 с `--ease-in-out` (лише `opacity`) | «Думає над відповіддю» | 2 |
| `speaking` | 2 + `pulse()` на кожне скидання DOM, ≤ 4 на секунду, `fire 0.8` | Як `thinking` | «Відповідає» | 2 |
| `summary` | 3: 3–5 малих мереж | Без змін | «Складає тези» | 3 |
| `saved` | 5: тези в склі, 1.2 с | Без змін | «Тези збережено» | 5 |
| `quiet` (криза) | 6: тихий пил, `fire = 0` за один кадр, обертання стихає за 1.2 с | Без руху | «Розмову зупинено» | **мовчить** |
| `breathing` (відкрито «Подихати хвилину», §3.13) | 0 з `fire 0.1`: подих сцени вже 4/6 (на своєму годиннику) | стоїть: коло вправи — єдиний темп | «Дихальна вправа» | 0 |
| `error` | Як `idle`: помилка — не привід для «сумної» анімації | — | «Чекає на ваше повідомлення» | — |

Без руху (`data-motion="off"` чи reduced motion) стан передає лише текстова мітка, а куля стоїть.

Мітку стану видно лише там, де людина може писати або AI працює: `booting`, `chat`, `summarizing`,
`saved` і `crisis`. На входах, `not-invited`, згоді, `review`, `ended`, `fatal`, `account-deleted` і
`session-expired` «Чекає на ваше повідомлення» було б неправдою, тож CSS ховає її (`visibility: hidden`,
місце лишається, нічого не зсувається). На телефоні мітки стану немає зовсім (`display: none`).

**Пресети неба** (фаза 4 «зараз»):
- кольори `stage.css` → custom properties на `:root`: `--sky-top`, `--sky-mid`, `--sky-haze-teal`,
  `--sky-haze-violet`, `--sky-haze-amber`;
- перевизначення — на `html[data-sky="dusk"]` («Сутінки», у світлій темі «Вечір») і `html[data-sky="dawn"]`
  («Світанок» / «Ранок»);
- без атрибута — «Ніч», як зараз.

Правила:
- Кожен пресет тримає найсвітліше небо під текстом не світлішим за L ≈ 0.02, тож `--color-text-dim`
  лишається ≥ 4.5:1 [P]. Перевіряє axe на кожному пресеті.
- `src/ui/sky.ts`:
  - читає `liora:sky` у `try`;
  - пише його лише після явного вибору в меню;
  - «Ніч» ключ видаляє.
- У `crisis` атрибут `data-sky` тимчасово знімаємо: кризові контакти завжди на нічному небі [C].
- Лендінг пресети не читає: там завжди «Ніч».
- Модульний скрипт не може виставити атрибут до першого кадру, бо inline-скрипт заборонений CSP. Тому
  короткий кадр нічного неба перед пресетом прийнятний.

### 9.3 Звук

`initSound(opts?: { follow?: 'chapters' | 'manual' }): SoundControl | null`, де
`SoundControl = { setMood(n: number): void; setQuiet(quiet: boolean): void }`.

- **Лендінг:** `follow: 'chapters'` (за замовчуванням) — поточний `IntersectionObserver`, без змін.
- **Чат:** `follow: 'manual'`.
  - `ui/presence.ts` викликає `setMood` за таблицею §9.2.
  - `setQuiet(true)` — у `crisis` і поки відкритий `help`.
- Звук вимкнений на кожному візиті і мовчить на паузі й у прихованій вкладці — як зараз.

### 9.4 Зміни на лендінгу (`index.html`, `src/main.ts`, стилі)

1. **CTA у шапці.**
   - Від 64em — заповнена пілюля 40 px після групи «Пауза / Звук»:
     `<a class="cta" href="/chat/">Розмова з AI <span aria-hidden="true">→</span></a>`. Доступна назва —
     «Розмова з AI».
   - На телефоні — перший елемент `.site-menu`, основна кнопка на всю ширину.
   - На ширині 1024 px усе мусить влізти: лого, три розділи, «Якщо важко», «Пауза / Звук», CTA. Це
     `[unverified]`, перевіряє тест `cutOffAtEdges` на 1024 × 768 (§11.7).
   - Тест на 320 px не змінюється: CTA там прихована.
2. **Посилання кулі:** `<a class="hero__orb-link" href="/chat/" tabindex="-1" aria-hidden="true">`.
   - Позиція — з `--light-x`, `--light-y`, `--light-d`, як у `.hero__orb`.
   - Клавіатура й скрінрідер ідуть через видиму CTA, тож однакових tab-stop не буде (план 1c).
   - Підпис «Поговорити з AI» на hover і «пірнання» — фаза 1c. Якщо 1c ще не злита, фаза 2 додає лише
     посилання.
3. **Футер.**

   | | Текст |
   |---|---|
   | Зараз | «Ця сторінка не використовує файли cookie й аналітику. Вибір паузи анімації зберігається лише в цьому браузері.» |
   | Нове | «Лендінг сам не ставить файли cookie і не має аналітики. Після входу в розмову з AI браузер тримає файл cookie сесії, недоступний скриптам сторінки, а на час входу — ще й тимчасовий файл cookie входу. Вибір паузи анімації й фону зберігається лише в цьому браузері.» Фон — ключ `liora:sky` з меню «Акаунт» на `/chat/`; так само каже рядок 4 екрана згоди (§3.5). |

4. **Узгодити FAQ і приватність з `/chat/`.**

   | Місце | Зараз | Нове | Чому |
   |---|---|---|---|
   | Приватність, рядок «Відповіді створює зовнішній сервіс AI»; FAQ «Хто бачить те, що я пишу?» | «Постачальника для відкритого запуску ще обираємо.» / «…ми ще обираємо, а на екрані згоди будуть його назва й країна.» | «Зараз це Ollama Cloud (Ollama Inc., США); назву й країну видно й на екрані згоди.» | Екран згоди фази 2 вже називає постачальника, і лендінг суперечив би йому. План ставив цю правку у фазу 3, крок 4 — питання B2. Лендінг статичний: якщо `LLM_PROVIDER_*` зміниться, цей текст треба міняти разом з ним. |
   | FAQ «Чи можна видалити свої записи й акаунт?» | «Так. Будь-який запис у щоденнику можна видалити окремо. Акаунт можна видалити…» | «Так. Акаунт можна видалити разом з усіма записами щоденника — кнопкою в меню «Акаунт» на сторінці розмови, без листів і запитів до нас. Перед цим щоденник можна завантажити у файл. Видаляти записи по одному можна буде на сторінці щоденника — вона ще в роботі.» | У веб-MVP немає видалення окремого запису. Питання B1. |
   | FAQ «Це безкоштовно? Коли можна буде спробувати?» | — | Додати речення: «Розмова з AI на вебі вже працює для запрошених тестувальників.» | Поруч стоїть CTA. |
   | Глава 03, рядок «Режим «не зберігати»» | — | Без змін | Перемикач є (§3.6). |
   | Глава 03, список фактів: «Будь-який запис можна видалити окремо» | «Будь-який запис можна видалити окремо» | «Записи можна буде видаляти по одному» | На тій самій сторінці FAQ після B1 каже, що видаляти записи по одному можна буде на сторінці щоденника, якої ще немає. Решта фактів — без змін. |
   | FAQ «На яких пристроях працюватиме Liora?» | «Ми готуємо вебверсію та застосунки для iOS і Android. Акаунт буде один…» | «Розмова з AI вже працює у вебі для запрошених тестувальників; щоденник у вебі й застосунки для iOS і Android ми ще готуємо. Акаунт буде один…» | Поруч FAQ про ціну вже каже, що веб-розмова працює; «готуємо вебверсію» йому суперечило. |
   | FAQ «Хто бачить…», другий абзац | «Збережені тези лежать у зашифрованому сховищі сервера Liora…» | «Збережені тези лежать на зашифрованому диску сервера Liora…» (§1.3) | Runbook: диск сервера gp3 зашифрований ключем `aws/ebs` (`devops/docs/runbooks/deploy.md:25`). `[unverified: стан тому в AWS не перевірявся]`, як у §1.3 і §12. ADR-005 тримає «шифрування окремих полів» відкритим, тому рядок каже лише про диск. |
   | Hero «Закрите тестування», глава 07, мета-опис | — | Без змін до фази 3 | — |

5. **`/?auth_error=` → `/chat/`.** Перші рядки `src/main.ts`, ще до ініціалізації сцени:
   ```ts
   const AUTH_ERRORS = new Set(['access_denied', 'state_mismatch', 'expired', 'not_invited', 'server_error', 'auth_unavailable'])
   const authError = new URLSearchParams(location.search).get('auth_error')
   if (authError !== null) location.replace('/chat/?auth_error=' + (AUTH_ERRORS.has(authError) ? authError : 'unknown'))
   ```
   Звідки цей випадок: коли flow-cookie немає або його підроблено, сервер повертає `next` на `/`, тож
   людина опиняється на лендінгу з `?auth_error=state_mismatch` (контракт §5). Запиту до API тут немає,
   тож тест «`/` не робить запитів до `/api/`» лишається зеленим [C][P][E].
6. **`web-client/CLAUDE.md`.**
   - Зараз: «Жодних форм, аналітики, cookies і сторонніх запитів».
   - Нове: «На `/` — жодних форм, cookies і звернень до API; `/chat/` — за ADR-007. Аналітики й сторонніх
     запитів немає ніде.»
7. **Теми на лендінгу (ADR-012, фаза D1).**
   - `index.html` без `data-theme-lock`: лендінг іде за `liora:theme` / системою, як чат. `public/theme-init.js`
     першим у `<head>` ставить `data-theme` до першого кадру; `<meta name="color-scheme" content="light dark">`;
     один `theme-color` (його веде `ui/theme.ts`).
   - **«Вигляд»** у шапці — та сама кнопка й меню, що в чаті (`ui/theme-picker.ts`, без радіо): три `<button
     role="menuitemradio">` (на лендінгу `input` заборонені), поза `.media`, між «Пауза / Звук» і CTA. На лендінгу
     кнопка без рамки, як «Пауза» і «Звук» (36 px; до 35em — 32 px), тож шапка на 320 px влазить (header.spec).
   - **Токени.** Світла — «ранковий папір» чату, ті самі значення. Темна — **ніч лендінгу**, як була (не «лампа»
     чату): `landing.css` перевизначає тим самим селектором кожен токен `tokens.css`, чий темний бік відрізняється
     від ночі `:root`, як `light-dark(<світлий чату>, <ніч>)`, і ніч ще раз під `@supports not (light-dark)`.
     Власні токени `--landing-*` (небо, бліда кнопка → теракота вдень, другий рядок заголовка, картка прикладу,
     футер) — там само. Тест `chat-core.spec.ts` «landing: its tokens…» виводить обидва боки з `tokens.css`.
     Літерали кольорів у `landing.css`, `sections.css` і `layout.css` пішли: мертві темні ореоли, CSS-куля,
     SVG-небо щоденника й «схід» фіналу (усі перекриті `landing.css`) видалено, решта — токени.
   - **Без WebGL** (`data-gl="off"`) світла тема не показує й не завантажує темні `public/*-still.png`: змінні
     `--still-*` у двох світлих блоках (`[data-theme='light']` і системна світла, лише з `light-dark()`) ведуть
     на CSS-малюнки — кільця чорнилом (`--color-ai`) і теракотою (`--color-accent`) з мʼяким краєм. У темній —
     PNG, як були: обчислені стилі темного лендингу до й після збігаються, крім нової кнопки, ширини
     `.site-header__actions`, ширини `.brand` до 23em (поле кліку 64 → 53 px, текст на місці), висот
     абзаців п. «Копірайт» нижче і мертвого `.final::before`.
   - **WebGL** (`gl/scene.ts`): палітра на тему `GL_PALETTES[theme].scene` (`gl/core/palette.ts`). Кожен колір,
     що був у шейдерах нитей, пилу, ореолу, портрета, слідів і малюнка розмови, став uniform; темні значення —
     ті самі літерали. Вдень — `NormalBlending` замість `AdditiveBlending`, premultiplied (rgb ≤ alpha), тонше
     (`alpha`), голова портрета — папір, змішаний до чорнила (`uOver`). Перемикання — подія `liora:theme`:
     uniforms і `material.blending`, без нових матеріалів і перекомпіляції. Боке-шейдери ніхто не імпортує;
     частинки, ореол, соми й скло — сцена чату (`gl/presence.ts`), у неї денна палітра вже є.
   - **Копірайт.** Щоденник уже є (екран чату, §7.7), тож: FAQ «Чи можна видалити…» — «Окремий запис можна
     видалити в щоденнику, який відкривається на сторінці розмови.»; FAQ «На яких пристроях…» — «Розмова з AI і
     щоденник уже працюють у браузері…; застосунки для iOS і Android ми ще готуємо.»; глава 03 — «Збережені тези
     стають записами в щоденнику, а тижневий огляд допомагає помічати теми, які повертаються.», підпис «Щоденник ·
     вигаданий приклад», факт «Записи можна видаляти по одному». Футер: «Вибір паузи анімації, теми й фону
     зберігається лише в цьому браузері.» (лендінг тепер пише `liora:theme`).
   - **Тести:** `tests/e2e/landing-theme.spec.ts` (кожен тест — з `NO_WEBGL2` до навігації): меню з клавіатури,
     вибір переживає перезавантаження, `data-theme` на `DOMContentLoaded` і без модуля сторінки, «Як у системі»
     видаляє ключ, світлий фолбек без жодного `*-still.png`, axe у світлій (і з відкритим меню), темна — ніч,
     смуга темного лендингу — ніч від раннього скрипту, і з модулем, і без нього (кожен запис `theme-color`
     ловить `MutationObserver`).
     `playwright.config.ts`: `E2E_NO_WEBGL=1` вимикає WebGL у Chromium-проєктах (`--disable-webgl
     --disable-webgl2 --disable-3d-apis`), без змінної нічого не змінюється.
   - **Поява глав (`ui/reveal.ts`) — прогресивне покращення.** Прихований стан `html.js-reveal` ставиться
     лише з першою відповіддю `IntersectionObserver`; те, що вже на екрані в цю мить, позначається видимим
     до класу. Спостерігач, що не відповідає ніколи (завислий фон, зламаний рушій), не ховає нічого
     (landing.spec «an IntersectionObserver that never answers hides nothing»); без JS, без руху й на паузі
     текст видно, як і було. Поява — лише `opacity` і `transform`, тож зсуву макета (CLS) від неї немає.
     Стартовий стан ставиться за один кадр (`html.js-reveal-start` вимикає переходи, примусовий перерахунок
     стилів, клас знято): блоки під згином не «згасають» до нього при завантаженні (до цього — 36
     `transitionrun` на 18 блоках без жодного прокручування; landing.spec рахує їх і чекає нуль).
     Там, де скрол зупинився (`scrollend`, і 150 мс після останнього `scroll` як запасний шлях), усе, що на
     екрані, показується: корінь спостерігача закінчується на 12 % вище нижнього краю, і блок, чий верх
     зупинився в цій смузі, лишався порожнім місцем перед очима — після посилання з якорем (`/#faq`: перша
     відповідь спостерігача приходить до прокручування до якоря; на 412 × 839 так висіло питання FAQ, на
     1440 × 900 — рядок приватності), після збігу пошуку по сторінці, якому не треба скролу, і після зупинки з
     рядком біля краю. Нижче згину нічого не змінюється (landing-motion.spec «where the scroll comes to
     rest…»), і завантаження вгорі сторінки — так само без жодного `transitionrun` (landing.spec вище).
8. **Рух між главами і менше тексту (фаза D2).** Увесь новий рух — у `landing.css` (чат його не вантажить:
   `chat/index.html` і всі його ассети після збірки байт-у-байт ті самі), лише під `html[data-motion='on']` і
   `@media (prefers-reduced-motion: no-preference)`; стан спокою кожного елемента — видимий. Рухаються лише
   `opacity`, `transform` і окремі `rotate`/`scale`, тож зсуву макета немає.
   - **Hero при завантаженні** (`ui/intro.ts`, клас `html.js-intro`): заголовок — лише `opacity` (420 мс, затримка
     60 мс; `hero-light.ts` міряє гліфи разом із transform), лід і кнопки — підйом на 8 px (320 мс, затримки 160 і
     240 мс), усе — до 560 мс, decelerate. Клас ставиться, лише поки браузер нічого не намалював
     (`performance.getEntriesByType('paint')` порожній): текст, який людина вже бачила, не зникає, щоб зʼявитися
     знову. Через 700 мс клас знімається, тож «Пауза» і «Грати» каскад не повторюють.
   - **Поява кроків, рядків приватності й відповідей FAQ:** `data-reveal="item"` на 4 `.step`, 7 рядках
     `.principles` і 7 `.qa` — той самий `ui/reveal.ts` (прихований стан лише з першою відповіддю
     `IntersectionObserver`, фокус показує блок одразу), але 280 мс, 8 px, decelerate, один раз; сусіди, що
     входять разом, — із кроком 40 мс. Заголовок і лід приватності — звичайний `data-reveal`, як в інших главах.
   - **`#mind`** (`@supports (animation-timeline: view())`): текст розгортається разом зі скролом —
     `view-timeline: --mind` на секції (`view-timeline-inset: 0`, діапазони — сам пін): мітка й «Ближче» —
     поки секція підіймається (`entry`), «до себе.» — `contain 0–30 %`, примітка — `contain 25–55 %`, з
     `contain 70 %` текст відпливає вгору на 12vh. Скрол може зупинитися будь-де на цьому таймлайні, тож текст
     не згасає (`opacity` тут не анімується): він підіймається й світлішає від `--color-text-dim` (≥ 4.5:1) до
     власного кольору — читається й знаходиться пошуком у будь-якій точці (axe на середині таймлайну, обидві теми). Без WebGL портрет живе на тому самому таймлайні, лише CSS:
     `rotate: y −16° → 0 → 9°`, `scale` 0.94–0.98 (обернений бокс не ширший за саму картинку: `cutOffAtEdges` на
     412 і 320 px), `opacity` 0.45 → 1. На телефоні `.mind__still` центрується властивістю `translate`, не
     `transform`, щоб поворот був навколо центру. Без WebGL секція лишається запіненою (190svh), окрім
     `reduced-motion` і `forced-colors`: перехід `data-gl` loading → off більше не складає її до одного екрана
     (раніше — мінус 810 px на 1440 × 900 після старту), а «Пауза» не змінює позицію скролу.
     Рушій без scroll-driven animations: `ui/reveal.ts` ставить на `[data-mind-step]` `data-reveal="mind"`
     (та сама поява, кроки 0/120/240 мс), а портрет без WebGL повільно «дихає» (7 с, alternate) —
     `[unverified]`: у Chromium ця гілка перевіряється лише підміною `CSS.supports`.
   - **Небо між `#scenarios` і `#faq`:** `.stage::before` / `::after` — два мʼякі світла кольорами самого неба
     (`--landing-sky-cool`, `--landing-sky-warm`; нормальне змішування, тож під текстом не світліше вночі й не
     темніше вдень, ніж небо вже є), `transform` від `--progress` (`ui/nav.ts`). Біля кризових контактів
     (`#safety`, `data-gl-quiet`) `nav.ts` ставить `.stage[data-quiet]` — світла гаснуть за 420 мс (ADR-011). Без руху
     їх немає.
   - **FAQ** (`@supports (interpolate-size: allow-keywords)`): `::details-content` відкривається 320 мс (decelerate)
     і закривається (standard), `interpolate-size` лише на `.qa`; деінде — миттєво, як було. Чи відкриває пошук по
     сторінці закриту відповідь з цим `::details-content` — `[unverified]` (Playwright не викликає нативний пошук).
   - **«Пауза»** обриває те, що вже йде (поява посередині, «+» FAQ), і кольори, що йдуть за скролом (рядки
     прикладу розмови, номери кроків, поточна глава в шапці), міняються одразу.
   - **Менше тексту** (`index.html`, видимі слова, `<details>` відкрито): 1384 → 1250. Приватність 251 → 180 —
     по одному реченню на рядок, деталі лишаються у FAQ («Хто бачить…», «Що саме ви зберігаєте?»); постачальник
     і країна — Ollama Cloud (Ollama Inc., США) — видимі. Лід і перший рядок кажуть «**Із розмови** в нашій базі
     залишаються лише тези…» і «**Із розмови** в базу даних потрапляє лише підсумок…»: без «із розмови» «лише»
     стало б неправдою (email, `sub`, згоди й сесії теж зберігаються, ADR-005; FAQ «Що саме ви зберігаєте?»
     перелічує їх; лід до D2 пом'якшувало наступне речення «Ось як ми працюємо з даними»). Кроки «Як це працює» — по реченню (190 → 159), лід
     без повтору фінального заклику. Футер 68 → 56: розкриття лишається тим самим — «Liora — застосунок для
     саморефлексії з AI, а не психологічна, медична чи екстрена допомога. Екстрені служби — 112.» («не заміна
     фахової допомоги» подавало б Liora як різновид допомоги), коротшає абзац про cookie: «Лендінг не ставить cookie і не має аналітики. Після входу чат тримає
     cookie сесії, недоступний скриптам, а на час входу — ще тимчасовий cookie входу. Пауза, тема й фон
     запамʼятовуються лише в цьому браузері.» Hero без другого посилання вниз («Знайомство з Liora ↓»
     дублювало «Як це працює ↓»); «Режим «не зберігати»» і FAQ «На яких пристроях…» — без повтору. Глава
     `#safety` не змінена.
   - **Тести:** `tests/e2e/landing-motion.spec.ts` (кожен — з `NO_WEBGL2`; локально ще `E2E_NO_WEBGL=1`):
     reduced motion — усе на місці одразу, жодної анімації, `#mind` без піну; «Пауза» — жодної запущеної
     анімації на всій сторінці, висота `#mind` і скрол ті самі, каскад hero не повторюється; без
     `IntersectionObserver` (відсутній і «мовчазний») нічого не сховано; `#mind` посередині таймлайну — axe без
     порушень у темній і світлій, рядок, до якого «стрибнув» пошук, — `opacity` 1; каскад hero ≤ 600 мс, заголовок —
     лише `opacity`; поява кроків/рядків/FAQ — 280 мс, 8 px, decelerate, один раз; `#mind` без WebGL —
     розгортання, поворот портрета, пін; гілка без scroll-driven animations; FAQ плавно з рухом і одразу на
     паузі; небо дрейфує й гасне біля `#safety`; 320 px — без горизонтального скролу й обрізань через увесь
     `#mind`. `landing-theme.spec` чекає лише скінченні анімації документного таймлайну (scroll-driven не
     закінчуються з часом); `landing.spec` — новий текст футера, розкриття в ньому й «Із розмови» в ліді й
     першому рядку приватності. Без WebGL у браузері (`E2E_NO_WEBGL=1`) не перевірено, як `--color-text-dim` тексту
     `#mind` на початку таймлайну читається над живим портретом WebGL (контраст міряно лише над небом і
     статичним портретом) — `[unverified]`, перевіряє `@gpu`-прогін з дозволу власника.

### 9.5 Vite: збірка з двох сторінок

Vite 8.3.3: `build.rollupOptions` — застарілий аліас, тож беремо `rolldownOptions`
`[verified: grep rolldownOptions node_modules/vite/dist/node/index.d.ts → «@deprecated Use rolldownOptions instead»]`.

```ts
// vite.config.ts — ілюстрація
import { fileURLToPath } from 'node:url'
build: {
  assetsInlineLimit: 0,          // без data:-URI — строга CSP працює
  chunkSizeWarningLimit: 700,
  rolldownOptions: {
    input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      chat: fileURLToPath(new URL('./chat/index.html', import.meta.url)),
    },
  },
},
```

`Dockerfile` копіює весь `dist/` у `/srv`, тож `dist/chat/index.html` поїде без змін у Dockerfile.

---

## 10. Заголовки безпеки

### 10.1 CSP

Рядок з ADR-007 дослівно, однаковий для `/` і `/chat/` (так у плані):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

**Чому лендінг уже витримує цю CSP:**
- у зібраному `dist/index.html` є лише `<script type="module" crossorigin src="/assets/index-….js">` і
  жодного `<style>`;
- в `index.html` немає атрибутів `style=`;
- у зібраному CSS немає `data:`.

`[verified: grep -n "style=" index.html → порожньо; grep -o "<script[^>]*>" dist/index.html → один module-скрипт; grep -c "<style" dist/index.html → 0; grep -o "data:…" dist/assets/*.css → порожньо]`.
Перевірка йшла по наявному `dist/`; після змін фази 2 її повторює тест CSP-порушень (§10.5).

Єдиний запис стилю з JS — CSSOM (`style.setProperty`, `style.cssText` у `scene.ts:503`), і `style-src`
його не блокує. `cssText` однаково замінюємо (§9.2).

**Що з цього випливає:**
- `og.jpg` читають лише краулери, браузер його не вантажить;
- `grain.svg` підключено з CSS як `'self'`;
- воркерів зараз немає — `worker-src` знадобиться у фазі 4.

**Рішення (Trusted Types):** не вмикаємо зараз. [E] пропонував
`require-trusted-types-for 'script'; trusted-types 'none'` лише для `/chat/`, але:
- задача вимагає однакову CSP на обох сторінках;
- ADR-007 фіксує рядок дослівно.

Це окремий PR після поправки ADR-007 і прогону `@stack` без порушень. Чи пише three.js або preload-хелпер
Vite у TT-синки — `[unverified]`. Питання B3.

### 10.2 Інші заголовки

| Заголовок | `/` | `/chat/` | `/assets/*` |
|---|---|---|---|
| `Content-Security-Policy` | §10.1 | §10.1 | §10.1 (нешкідливо) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | те саме | те саме |
| `Cache-Control` | `no-cache` | **`no-store`** (також `/chat/index.html` і редирект `308` з `/chat` на `/chat/`) | `public, max-age=31536000, immutable` |
| `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer` | edge-Caddy, як зараз | edge-Caddy | edge-Caddy |

**`Permissions-Policy`:**
- Без `clipboard-write=()`: кнопки «Скопіювати…» на ньому працюють.
- Лише назви, які Chromium знає. Невідомі назви дають console-warning, а `watchConsole`
  (`tests/e2e/helpers.ts`) рахує попередження як провал.
- У WebKit — `[unverified]`, перевірити в локальному проєкті `iphone-webkit`.

### 10.3 `web-client/deploy/Caddyfile`

```
:8080 {
	root * /srv
	encode zstd gzip

	# Три matcher-и, що не перетинаються: no-store для /chat/ не залежить від порядку директив.
	@assets path /assets/*
	@chat   path /chat /chat/ /chat/index.html
	@other  not path /assets/* /chat /chat/ /chat/index.html
	header @assets Cache-Control "public, max-age=31536000, immutable"
	header @chat   Cache-Control "no-store"
	header @other  Cache-Control "no-cache"

	header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"

	file_server
}
```

- `/chat` без косої риски `file_server` перенаправляє на `/chat/`, і редирект теж отримує `no-store`.
- Перевірити `[unverified]`:
  - `caddy validate`;
  - `curl -sI http://localhost:8088/chat/`, `…/chat`, `…/`, `…/assets/<file>` на локальному стеку.
- Edge-Caddy (`devops/caddy/Caddyfile`) не змінюється (ADR-007).

### 10.4 `vite.config.ts`: preview дзеркалить прод

```ts
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // На проді цей заголовок ставить edge-Caddy. Без нього CI перевіряв би Origin не в тих умовах, що прод.
  'Referrer-Policy': 'no-referrer',
}
export default defineConfig({
  preview: { port: 4173, strictPort: true, headers: SECURITY_HEADERS },
  plugins: [{
    name: 'liora-preview-no-store',
    configurePreviewServer(server) {
      // Викликано напряму (без return) → middleware стоїть ПЕРЕД вбудованими.
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? '').split(/\?(.*)/s)
        if (path === '/chat') {                         // як Caddy file_server: канонічний редирект
          res.statusCode = 308
          res.setHeader('Location', '/chat/' + (query ? '?' + query : ''))
          res.setHeader('Cache-Control', 'no-store')
          res.end()
          return
        }
        if (path === '/chat/' || path === '/chat/index.html') {
          res.setHeader('Cache-Control', 'no-store')
          req.url = '/chat/index.html' + (query ? '?' + query : '')   // файл віддає sirv, а не send()
        }
        next()
      })
    },
  }],
  // …build з §9.5
})
```

**Чому не просто `setHeader` і `next()`.** У Vite 8.3.3 preview адресу `/chat/` віддає не sirv, а ланцюжок
`htmlFallbackMiddleware → indexHtmlMiddleware → send()`, і `send()` **безумовно** ставить
`Cache-Control: no-cache` поверх нашого заголовка. `/chat` без косої preview віддав би лендінг через
spa-fallback, тоді як Caddy на проді робить редирект. Переписаний `req.url` на `/chat/index.html` іде
через sirv, який уже виставлених заголовків не перезаписує.
- `send()` у Vite: `[verified: sed -n 17672,17690p node_modules/vite/dist/node/chunks/node.js → «cacheControl = "no-cache"», «res.setHeader("Cache-Control", cacheControl);»]`.
- Увесь ланцюжок на мінімальному MPA з цим самим Vite і обома варіантами плагіна:
  `[verified: node phase2/vite-preview-check/run.mjs → old: «/chat/ 200 cache-control=no-cache … chat», «/chat 200 cache-control=no-cache … landing», «/chat/index.html 200 cache-control=no-store»; new: «/chat/ 200 cache-control=no-store … chat», «/chat/?auth_error=expired 200 cache-control=no-store … chat», «/chat 308 cache-control=no-store location=/chat/», «/ 200 cache-control=no-cache … landing»]`.
  На 308 немає CSP (у редиректу немає вмісту, і `preview.headers` до нього не доходять) — тест #49 CSP
  на `/chat` не перевіряє.
- `preview.headers` — це `CommonServerOptions.headers` у типах Vite 8.3.3 `[verified: grep]`.
- **У `server.headers` (dev) CSP не ставимо:** dev-сервер Vite вставляє стилі через JS (`<style>` HMR),
  і CSP зламала б розробку.

### 10.5 Правила коду, які тримають CSP

Перевіряє `chat-core.spec.ts` (grep по файлах через `fs`).

**`src/**`:** немає
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`;
- `document.write`, `eval(`, `new Function`;
- `setAttribute('style'`, `.cssText`.

**`src/chat/**`:**
- немає `mode:` (§5.1);
- немає прямих звернень до `localStorage`.

**Хто пише в `localStorage`:** `liora:motion` — лише `src/ui/motion.ts`, `liora:sky` — лише
`src/ui/sky.ts`.

**`src/chat/core/**`:** немає `document`, `window`, `navigator`, `HTMLElement`, `localStorage`,
`sessionStorage`, `indexedDB`, `three`, `../ui`.

**`chat/index.html` та `index.html`:**
- немає `<script>` без `src`;
- немає `style=` і `<style>`;
- немає `<form>`;
- кожна `<button>` має `type="button"`.

**Динамічні значення** — лише через `style.setProperty('--x', …)`, класи й `data-*`.

**У кожному тесті** `addInitScript` вішає слухача `securitypolicyviolation` → `window.__csp`. В
`afterEach` масив має бути порожнім — і на `/`, і на `/chat/`.

---

## 11. План тестів

### 11.1 Файли і як запускати

| Файл | Що тестує | Де ганяємо |
|---|---|---|
| `tests/e2e/chat.spec.ts` | Сторінку проти моків API: `page.route` і синтетичний SSE | CI: проєкти `desktop` і `mobile`, той самий job і `--grep-invert "@gpu\|@stack"`. Локально — ще й `iphone-webkit`. |
| `tests/e2e/chat-core.spec.ts` | Чисте ядро, без фікстури `page` | Лише `desktop`: `test.skip(testInfo.project.name !== 'desktop')`. |
| `tests/e2e/chat.stack.spec.ts` | Справжній стек | Лише локально. Кожен тест має тег `@stack`, а `test.skip` спрацьовує, якщо `process.env.E2E_STACK !== '1'` або `baseURL` не `http://localhost:8088`. Тому в CI і проти проду ці тести не йдуть ніколи. |
| `tests/e2e/chat-fixtures.ts` | Обвʼязка: `mockApi`, `sse()`, fetch-shim, аудит сховищ, спільний stop-list | — |

**Рішення:** тести ядра лежать у `tests/e2e/chat-core.spec.ts`, а не в `tests/unit/` [E].
- `playwright.config.ts` має `testDir: 'tests/e2e'`, тож `tests/unit` вимагав би зміни конфігу.
- CI-логіку тут не міняємо (`web-client/CLAUDE.md`).
- Playwright сам транспілює TS-імпорти з `src/chat/core`.

```
npm run build
npx tsc --noEmit -p tsconfig.json
# як у CI
npx playwright test tests/e2e/chat.spec.ts tests/e2e/chat-core.spec.ts --project=desktop --project=mobile --grep-invert "@gpu|@stack"
# локально: Origin у WebKit (§5.1)
npx playwright test tests/e2e/chat.spec.ts --project=iphone-webkit
# @stack, PowerShell
$env:E2E_BASE_URL='http://localhost:8088'; $env:E2E_STACK='1'; npx playwright test tests/e2e/chat.stack.spec.ts --project=desktop --workers=1 --grep "@stack" --grep-invert "@gpu"
# @stack, bash
E2E_BASE_URL=http://localhost:8088 E2E_STACK=1 npx playwright test tests/e2e/chat.stack.spec.ts --project=desktop --workers=1 --grep @stack --grep-invert @gpu
```

З `E2E_BASE_URL` `playwright.config.ts` вже не піднімає `webServer`. Цей шлях є в конфігу зараз.

### 11.2 Обвʼязка (`chat-fixtures.ts`)

**Моки API:**
- `mockApi(page, table)` ставить `page.route('**/api/v1/**')` з таблицею відповідей.
- Будь-який запит до `/api/`, якого немає в таблиці → `route.abort()` і провал тесту.

**Моки за замовчуванням:**

| Запит | Відповідь |
|---|---|
| `/me` | 200, `consents_ok: true` |
| `/consents` | `llm_provider` `{name: "Ollama Cloud (Ollama Inc.)", country: "US"}`, `current_policy_version: "2026-10-06"` |
| `/scenarios` | 4 сценарії з текстами контракту. `situation.description` **з** «КПТ» — щоб довести, що ми його не показуємо. |
| `/summaries` | Порожньо або 2 записи |
| `/helplines` | **Сирий** `helplines.json` разом з `notes` («…7333…») |

**SSE цілим тілом:**
```ts
route.fulfill({
  status: 200,
  headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'req-1' },
  body,
})
```
`body` будують хелпери:
- `sse(frames)` — кадри `event: x\ndata: {…}\n\n`;
- `ping()` — `: ping\n\n`.

**SSE потоком** [E]. `route.fulfill` віддає тіло одним шматком, тож кадри на межі чанків, «Зупинити»,
`aria-busy` і watchdog так не перевірити. Для цього — shim:
- `addInitScript` підміняє `window.fetch` лише для `/api/v1/chat/turn`;
- підміна повертає `new Response(new ReadableStream({ start(c) { window.__sse.push(c) } }), { headers })`
  і записує `init` (`mode`, `credentials`), `signal.aborted` і `signal.reason`;
- тест пише чанки через `page.evaluate`.

**Таймери:** `page.clock.install()` і `runFor()` — для `Retry-After`, 45 с тиші, анонсу на 700 мс і
підказки через 10 с.

**`afterEach`:**
- `window.__csp` порожній — слухача `securitypolicyviolation` вішає `addInitScript`;
- `watchConsole` (наявний хелпер) порожній;
- `document.documentElement.outerHTML` **не містить «7333»** — його читає тест, а не застосунок;
- origin кожного запиту дорівнює origin `baseURL`, тобто сторонніх запитів нуль.

### 11.3 Ядро (`chat-core.spec.ts`)

**`sse`:**
- Канонічний стрім (`meta`, 5 токенів кирилицею й емодзі, `done`) ріжемо **на кожній позиції байта**.
  Список подій має виходити ідентичним.
- Розрізи `\r\n` і `\r` | `\n` між чанками.
- `: ping` перед `meta`, між токенами і склеєний з кадром в одному чанку.
- Кілька рядків `data:`, поле без двокрапки; `id:` і `retry:` ігноруються.
- Невідомий тип, `type ≠ event`, зламаний JSON → кадр пропущено.
- Хвіст без `\n\n` → `truncated`.
- Незавершений кадр понад 256 КБ → `ProtocolError`.
- Один чанк із кількох валідних кадрів, сумарно > 256 КБ (кожен кадр < 256 КБ) → усі події, без помилки.
- Подія після `done` ігнорується, а `reader.cancel()` викликано.

**`turn`** (фейкові `fetch` і годинник):
- Обрив → рівно один повтор, тіло deep-equal.
- Другий обрив → `failed`.
- 503 з `Retry-After: 3` → 2 повтори з паузою 3 с.
- `abort` під час очікування → `aborted`, без повтору.
- `HEADERS_TIMEOUT` спрацьовує → `headersTimeout`, без автоповтору; `IDLE_TIMEOUT` скидає ping.
- **Довгий стрім:** заголовки одразу, токени йдуть 40 с (з проміжками < 45 с) → `done`. Таймер заголовків
  знято після resolve `fetch` і тіла не обриває.
- Причини abort: `'user'` і `'pagehide'` → `aborted`; `'idle'` → `truncated` з одним повтором;
  `'headers-timeout'` → `headersTimeout`. Ручне звʼязування без `AbortSignal.any` передає ту саму причину.
- 200 з `text/html` → `internal`.

**`api`:**
- `init.mode === undefined`, `credentials: 'same-origin'`, `referrerPolicy: 'same-origin'`.
- `Content-Type: application/json` на кожному тілі.
- У тілі ходу немає `timezone`.
- `revisit_summary_ids` є лише для `revisit`.
- `llm_provider` з порожньою (після `trim`) чи задовгою (> 64) `country` → `null`, як і без назви (§3.5).

**`errors`:**
- Порожній 502, тіло HTML.
- `Retry-After`: HTTP-дата, `"abc"`, `"0"` → 1 с, `"999"` → 60 с.
- `error.message` не потрапляє в `UiError`.

**`helplines`.** Фікстура з «7333» у `notes`, `message`, `lines[].phone` (`"7333"`, `"0 800 7 333 00"`),
`lines[].name` і `abroad.text`. Плюс `abroad.url = "https://evil.example"` і `lines` як рядок, `null` чи
`{}`. Очікуємо:
- `JSON.stringify(sanitize(x))` не містить `7333`;
- посилання на howareu — константа;
- `free: null` → немає слова «безкоштовно»;
- текст із bidi-керівними символами (`\u202A–\u202E`, `\u2066–\u2069`, `\u200E`, `\u200F`, `\u061C`) відкидається:
  «\u202E3337» проходить перевірку цифр, але на екрані малює паузований номер навпаки. У фікстурі —
  лише escape-послідовності, без самих невидимих символів.

**`limits`:**
- `codePoints('😀'.repeat(4000)) === 4000` → можна надіслати; 4001 → не можна.
- `canSend` на 197, 198, 199.
- Текст лише з пробілів не надсилається.

**`country`:** `US` → «США», `DE` → «Німеччина» (через `Intl`), `XX` → «XX».

**`state`:**
- кожен рядок таблиці §2.4;
- I3: `crisis` після токенів → у `messages` немає часткового тексту;
- I4, зокрема через згоду: `Resume.turn.request` deep-equal тілу першої спроби;
- 401 / 403 на ході → `pending` є в `session-expired`, `not-invited` і `consent`;
- `consent(resume)` + свіжий `missing = []` → без POST, одразу повтор;
- 409 у `resume` → `mode` і `resume` ті самі, `policyChanged = true`;
- I5: з `crisis` не виводить жодна дія, крім нової розмови;
- одна операція акаунта за раз: поки revoke у дорозі (його confirm закрито Esc), «Так, видалити все»,
  «Вийти» й інший revoke не дають ефектів; «Завершити» йде — і замок переживає зміну екрана
  (`summarizing`, `review`): `reduce()` забуває лише операцію, що вже не `busy`; `signedOut()` і
  `accountDeleted()` знімають `op` самі, а відповідь revoke чіпає `op` лише з назвою `revoke`;
- пізня відповідь revoke після `account-deleted`, `signed-out` чи `session-expired` екрана не міняє, лише
  знімає `op`;
- `pagehide` під час завантаження (`me/fail` і `consents/fail` з `aborted`) лишає `booting`, і `page/show`
  завантажує сторінку наново; `timeout` і далі веде у `fatal`.

**`copy`:** «Пробуємо ще раз через {n} …» узгоджене з числом (1 секунду, 3 секунди, 5 секунд, 21 секунду).

**Інструменти** (`state: the self-help tools`, `self-help: the minute, the words`): накладки відкриваються без
ефектів, стають над `help` і над `shelter` (три рівні), не відкриваються в `crisis` і `booting`; криза
закриває кожен стек і забуває чек-ін; 401 під інструментом → `session-expired` без накладок; `mood/pick`
бере лише слово словника, перше слово лишається, `after` — лише на `review`/`saved`/`ended` з `before`;
жоден ефект і тіло `POST /summaries` не несуть слова; скидання з новою розмовою, revisit, виходом і
видаленням акаунта, а щоденник із «До розмови» його лишає; `presenceOf` → `breathing`; `breathAt` 4/6 ×6 і
2+1+6 ×7, лічба 4 3 2 1, наступний тик; словник 4 × 6 без стоп-слів; токени «В укритті» = темна сторона
`light-dark()`. I5 доповнено діями інструментів.

**«→ У тези», пауза, мʼякий кінець** (`state: «→ У тези», the reminder to pause, the soft end`, фаза C3):
`chat/mark` — лише відповідь AI в `chat`, не перша репліка, перемикач, не більше `MAX_MARKS`; позначки не йдуть
у тіла `/chat/turn` і `/chat/summarize`; `markText` маскує номер на паузі й ріже по слову до 500;
`markCandidates` без уже взятих; `review/take` не шосту і не під час збереження; `review/unmark`; `saved.keep`
лише з тези `m…`; `pauseDue` — 40 хв від першого повідомлення або 60 реплік, раз на розмову; `pause-due` під
час відповіді нічого не міняє, `done` після строку приносить рядок; `pause-collect` → `confirm(end)`;
криза — без рядка. Тест `theme-init` перевіряє порядок `charset` → `theme-color` → скрипт і що його кольори =
`--color-bg` обох тем: світлий — літерал паперу, темний — hex `theme-color` кожної сторінки (= темний бік
`--color-bg` у `tokens.css` для чату й у `landing.css` для `/`).

**Щоденник** (`api: the diary`, `journal helpers`, `state: the diary`): шлях `GET /summaries` (порядок
`limit, cursor, q, tag`, порожній `q` не йде), `GET /reviews/weekly`, тіло PATCH поле за полем; `shiftDay`
через межу місяця й року; `searchQuery`; `formOf` маскує номер на паузі; `tagsFromText` зберігає `source`
наявного тегу; `patchOf` без змін → без PATCH; редʼюсер: лінивий вхід, «До розмови», застарілі `req`,
`invalid_timezone` → один повтор, PATCH після згоди тим самим тілом, 404 на PATCH і DELETE, «Повернутися до
цього» з підтвердженням над розмовою; I5 — дії щоденника з кризи нікуди не ведуть.

**Чистота коду:** grep-правила §10.5. Плюс: кожен `<textarea>` і `<input>` типу `text`/`search` у
`chat/index.html` має `autocomplete="off"` — Firefox зберігає на диск (sessionstore) текст полів без нього, а
екран згоди обіцяє, що браузер тримає лише cookie сесії й два вибори.

### 11.4 E2E з моками (`chat.spec.ts`)

★ — обовʼязкові за постановкою задачі.

| # | Тест | Мок | Перевірки |
|---|---|---|---|
| 1 ★ | Звичайний хід | `meta`, 3 `token`, `done` | • Текст AI дорівнює склеєним токенам.<br>• `aria-busy` true → false; live-регіон отримує текст один раз.<br>• Тіло: `scenario`; `messages[0]` = `opening_message` з `assistant`; останнє — `user`; немає `timezone`.<br>• `request.allHeaders()`: `origin` дорівнює origin `baseURL`, `content-type: application/json`.<br>• На desktop фокус лишається в полі. |
| 2 ★ | Ping | `: ping` перед `meta`, між токенами і перед `done` | Слова «ping» у DOM немає, результат той самий, що в #1. |
| 3 ★ | Кадри, розрізані між чанками (shim) | Розрізи посеред `event:`, посеред JSON, посеред кириличного символу UTF-8, розрізаний `\r\n` | Текст той самий, що в #1. |
| 4 ★ | Стрім закінчився без фінальної події | 1-й: `meta`, `token`, кінець; 2-й: норма | • Рівно 2 запити з **ідентичним** тілом.<br>• Частковий текст першого зник. |
| 4b | Двічі без фінальної події | Обидва обриваються | 2 запити, «Зʼєднання обірвалося…» і «-> Надіслати ще раз». |
| 5 ★ | Криза, `keyword` | `meta`, `crisis`. Сирі helplines: `notes` з 7333, лінія з 7333, `message` з 7333 (→ фолбек), `abroad.url` evil. | • `textarea` немає в DOM; фокус на `h1`.<br>• Посилання `tel:112`, `tel:103` і `https://howareu.com/hot-lines` точні.<br>• **«7333» у DOM немає.**<br>• Транскрипт у `<details>`.<br>• У проєкті `mobile` (412 × 839) 112 і 103 у viewport без скролу.<br>• `data-presence="quiet"`, `data-sound` не `on`.<br>• I5: жодного нового `POST /chat/turn`, навіть після спроби надіслати через `page.evaluate`. |
| 6 ★ | Криза, `model` після токенів | `meta`, 4 `token`, `crisis` | Тексту 4 токенів у DOM немає. Решта перевірок — як у #5. |
| 6b | Відкладений flush на фіналі (shim + `page.clock`) | `token` ×3 і `crisis` в **одному** чанку, далі `clock.runFor(1000)` | Тексту токенів немає ніде в DOM, зокрема в `<details>` з транскриптом. Те саме для `token` ×3 + `error` і для «Зупинити» одразу після токенів. |
| 7 ★ | `error` після токенів | `meta`, 3 `token`, `error llm_failed` | • Частковий текст зник.<br>• «AI не зміг відповісти…» і дві дії.<br>• Автоповтору немає: один запит. |
| 8 ★ | 401 посеред розмови | `turn` → 401 | • Блок `session-expired`, транскрипт видно, `textarea` немає.<br>• «Увійти знову» відкриває confirm; `href` = `/api/v1/auth/google/start?next=/chat/`. |
| 8b | 401 на **першому** ході: неподане повідомлення не зникає | `turn` → 401 | • Текст повідомлення людини є в транскрипті з міткою «Не надіслано».<br>• «Скопіювати текст розмови» → буфер обміну (`context.grantPermissions(['clipboard-read'])`) містить «Ви (не надіслано): {текст}».<br>• Те саме для 403 `not_invited`: текст є в `<details>` і в копії. |
| 9 ★ | 403 `not_invited` | `turn` → 403 | • Екран з сесією.<br>• Посилання експорту мають атрибут `download`.<br>• Транскрипт у `<details>`, є кнопка копіювання. |
| 10 ★ | 403 `consent_required` | `turn` → 403, згода → 200, `turn` → 200 | • Банер `resume`.<br>• На вході в `consent(resume)` — другий `GET /consents`.<br>• Після `POST /consents` хід іде знову сам, з ідентичним тілом.<br>• Транскрипт той самий. |
| 10b | Нова версія умов посеред сесії | Boot: `/consents` з версією A, `missing: []`. `turn` → 403 `consent_required`, `details: {missing: [3 види], policy_version: B}`. Другий `GET /consents` → версія B, `missing` — 3 види. `POST /consents` → 200, `turn` → 200 | • Банери «Умови щойно оновилися…» і `resume`.<br>• Тіло POST: `{policy_version: B, kinds: [3 види]}` — не `[]` і не A.<br>• Після згоди той самий хід повторюється сам, тіло deep-equal першому.<br>• Окремо: POST → 409 → `GET /consents` → банер, режим лишається `resume`, після згоди хід повторюється. |
| 11 ★ | 403 `csrf_failed` | `turn` → 403 двічі | Перший раз — рядок з повтором. Удруге — текст «оновіть сторінку» і кнопка «Скопіювати…». |
| 12 ★ | 409 `policy_outdated` | `POST /consents` → 409 | • Другий `GET /consents`.<br>• Галочки зняті, банер «Умови щойно оновилися…». |
| 13 ★ | 409 `crisis_stop` | `summarize` → 409 з `details.helplines` (сирі, з 7333) | Кризовий екран; «7333» у DOM немає. |
| 13b | Чернетка в полі пережила тези, далі криза | Текст у полі → «Підсумувати» → 409 `crisis_stop` → «Почати нову» | У новій розмові поле порожнє (`toHaveValue('')`: `outerHTML` значення поля не містить). |
| 14 ★ | 413 на ході | `turn` → 413 JSON | Блок межі з «Підсумувати» і «Завершити без тез»; композера немає. |
| 15 ★ | 422 | `turn` → 422; `POST /summaries` → 422, `details: [{field:"bullets.2"}]` | • Хід: рядок і «-> Змінити».<br>• Тези: помилка на тезі 3, фокус на ній. |
| 15b | 422 на тезах після «Прибрати» | Теза 1 прибрана; `POST /summaries` → 422, `details: [{field:"bullets.1"}]` | Помилка й фокус — на **третьому** видимому полі тези (а не на другому). Для `tags.N.name` — на тій пілюлі тегу, з якої взято `tags[N]` тіла: пунктирна рамка 2 px, рядок ««#{тег}»: Тег: до 40 символів.», фокус на «×» цього тегу, описаному цим рядком; наступна правка прибирає і позначку, і рядок. |
| 16 ★ | 429 з `Retry-After: 12` | `turn` → 429 | • `cooldown`, кнопка `aria-disabled`.<br>• Анонс на старті — з секундами («…Надіслати знову можна через 12 с.»), «Можна надіслати ще раз» до кінця відліку не звучить.<br>• `clock.runFor(12 s)` → кнопка активна, анонс «Можна надіслати ще раз».<br>• Автоматичного запиту немає.<br>• 16b: у новій розмові поле з текстом одразу дає активну «Надіслати», і кінець старого відліку там не звучить. |
| 17 ★ | 503 `llm_busy` з `Retry-After: 5` | 503, 503, 200; окремо 503 ×3; окремо SSE `error llm_busy` | • 3 запити й відлік.<br>• При 503 ×3 після трьох запитів — ручна кнопка. |
| 18 ★ | 502 з порожнім тілом (Caddy) | `turn` → 502, тіло `''`; так само 504; `/me` → 502 | • «Сервер зараз не відповідає…», без JS-винятків.<br>• На старті — `fatal`. |
| 19 | 200 з `text/html` на ході | — | Загальний текст. |
| 20 | «Зупинити» (shim) | — | • Один `abort` (`signal.aborted`).<br>• «Відповідь зупинено», частковий текст зник, повтору немає. |
| 21 | `pagehide` посеред стріму (shim) | — | `signal.aborted === true` |
| 22 | 45 с тиші (shim і годинник) | — | • Другий запит після `runFor(45 s)`.<br>• Ping кожні 15 с скидає таймер. |
| 22b | Довга відповідь (shim і годинник) | Заголовки й `meta` одразу, далі токен кожні 2 с протягом 40 с, потім `done` | Один запит, результат `done`, текст повний: таймер заголовків (35 с) тіла не обриває. |
| 23 | Подвійне надсилання; IME | — | • Enter і клік → 1 запит (I2).<br>• Enter під час `compositionstart` не надсилає. |
| 24 | Межа 4000 | — | • 4001 емодзі → блок і текст.<br>• 4000 емодзі → надсилається.<br>• Вставка 10 000 символів не обрізається мовчки. |
| 25 | Межа 200 повідомлень | Стан на 197 | Після відповіді — блок межі. |
| 26 | `?auth_error` | `/me` → 401 | • Кожен із 6 кодів і невідомий → свій текст або екран.<br>• Після завантаження в URL немає `auth_error`.<br>• `not-invited` без сесії: «Новий акаунт не створено, і під час цього входу вашої адреси ми не записали.» (§3.4). |
| 26b | `?auth_error`, але сесія жива | `/me` → 200; `?auth_error=not_invited` і окремо `=expired` | Банер «Новий вхід не відбувся…» з email з `/me` над тегом нового екрана, фокус на ньому; для `not_invited` — з реченням про список тестувальників. |
| 27 | Переадресація з лендінгу | — | `/?auth_error=expired` → `/chat/` з банером. |
| 28 | Згода | — | • У тексті назва постачальника і «США»; «6 жовтня 2026 р.».<br>• Без усіх трьох галочок → `alert`, POST немає.<br>• Тіло POST: `kinds` == `missing`.<br>• Блок «Не зараз».<br>• Без `llm_provider` галочок немає. |
| 29 | Сценарії | — | • `free` обрано наперед; зміна сценарію замінює першу репліку.<br>• Опис `situation` — клієнтський; «КПТ» у DOM немає.<br>• `revisit` з порожнім щоденником → пояснення, композера немає. |
| 29b | `GET /scenarios` не вдався | `/scenarios` → 502 з порожнім тілом; `/consents` приходить раніше | • Екран нової розмови зʼявляється лише після відповіді `/scenarios`.<br>• Перша репліка «Про що вам хочеться поговорити сьогодні?», сценарій `free`, перемикача немає, є «Інші сценарії зараз не завантажилися.» і «-> Спробувати ще раз».<br>• Хід іде з `scenario: 'free'`. |
| 30 | «Повернення до теми» | — | • Вибір radio `revisit` (клавіатурою, стрілками) **не** відкриває накладку; її відкриває «-> Обрати записи».<br>• Можна обрати 1–5, шостий чекбокс `disabled`.<br>• Esc на `revisit-pick` без обраних записів → сценарій повертається на попередній; `POST /chat/turn` з `revisit` і порожніми id не йде ніколи.<br>• Тіло має `revisit_summary_ids`.<br>• 404 → вибір відкривається знову з банером; після нового вибору хід іде знову. Esc після 404 → сценарій лишається `revisit`, повідомлення «Не надіслано».<br>• 404, а `GET /summaries` → `items: []` → блок «Записів, до яких ви поверталися…» з «Завершити без тез».<br>• 30c: закрита накладка не тримає списку записів; після «Вийти» в розмітці немає ні назв обраних записів, ні email закритого меню. |
| 31 | Тези → правка → збереження | `summarize` 200, `summaries` 201 | • Тіло `POST /summaries` обрізане, теги мають `source` `ai` / `user`.<br>• Екран `saved`.<br>• Транскрипту в DOM немає, `beforeunload` знято. |
| 32 | Тези: 502 і «Скасувати» | — | • Повтор.<br>• «Скасувати» під час очікування → назад у розмову з тим самим транскриптом. |
| 32b | Тіло й 422 на `summarize` | `summarize` → 200; окремо → 422 | • Тіло рівно `{scenario, messages}`: без `revisit_summary_ids` навіть у `revisit`, `messages.length ≤ 200`.<br>• 422 → «Не вдалося скласти тези з цієї розмови.», «Скласти ще раз» немає, другого запиту немає. |
| 33 | «Видалити тези» | — | Confirm; `POST /summaries` немає; екран `ended`. |
| 34 | «Не зберігати» | — | Кнопки «Зберегти» немає; «Готово» → `ended`; POST немає. |
| 35 | Збереження: мережа впала, але запис є | 1-й POST → abort; `GET /summaries?limit=1` → запис з тим самим вмістом, заголовок `Date` = `created_at` + 30 с | `saved` без другого POST. Окремо: запис з тією самою назвою, але іншими тезами → другий POST іде. |
| 36 | Меню акаунта | — | • Email, посилання експорту з `download`, згоди з датами.<br>• Esc повертає фокус на «Акаунт».<br>• «Вийти» → `confirm(logout)` поверх меню → «Скасувати» → фокус на «Вийти» **всередині відкритого** `account`; те саме для «Видалити акаунт…» і «Відкликати».<br>• axe з відкритим меню і з відкритим стеком меню + confirm. |
| 37 | Вийти посеред розмови | — | Confirm → `POST /auth/logout` → «Ви вийшли…» |
| 38 | Видалити акаунт | `DELETE /me` | • Стартовий фокус на «Скасувати».<br>• 204 → `account-deleted`.<br>• Мережа → повтор → **401** → `account-deleted` з текстом «Схоже, акаунт уже видалено…», банера «Увійдіть, щоб видалити акаунт» немає.<br>• 401 з першої спроби → `signed-out` з банером «Вхід завершився. Увійдіть, щоб видалити акаунт.» |
| 39 | Відкликати `data_processing` | `DELETE /consents/data_processing` | Текст про видалення щоденника → `consent(first)`. Після нової згоди «Повернення до теми» показує порожній щоденник, без старих записів. |
| 40 | `beforeunload` | — | Немає в новій розмові; є після першого повідомлення; немає після `saved`, `ended` і `crisis` (`page.on('dialog')`). |
| 40b | `tel:` без «Покинути сайт?» (Chromium) | Є повідомлення людини | • Відкрити `help`, клік по `tel:112` → `page.on('dialog')` не спрацьовує.<br>• Те саме з `not-invited` з транскриптом.<br>• Після `focus` вікна `beforeunload` знову є (I7). Android Chrome — на пристрої, `[unverified]`. |
| 41 | bfcache | `pageshow` з `persisted` + `/me` → 401 | Транскрипт стерто, `[data-announcer]` порожній. |
| 41c | «Піти» з тез | Текст у полі → `review` → «Піти» → `pagehide` / `pageshow` | Нова розмова з порожнім полем. |
| 41d | Порада в `confirm(leave)` | `chat`, `review`, те саме в «не зберігати» | «Хочете залишити тези — спершу підсумуйте» лише поруч із «Підсумувати»; на `review` — «…збережіть їх у щоденник»; у «не зберігати» — жодної. |
| 42 | Live-регіон | 50 токенів | • `MutationObserver` на `[data-announcer]` бачить ≤ 2 **непорожні** записи за хід (очищення не рахуємо).<br>• Після `saved`, `ended`, виходу й `account-deleted` `[data-announcer]` порожній; через `clock.runFor(5 s)` після анонсу — теж. |
| 43 | Розкладка | — | • 1440 і Pixel 7: композер у viewport.<br>• 1024 × 768 і 1100 × 800: bbox канваса й `.orb` не перетинає текстову колонку.<br>• `cutOffAtEdges` порожній на `chat`, `consent`, `crisis`, `review` при 320 px і масштабі 200 %.<br>• Tab до кожної дії в транскрипті («-> Надіслати ще раз», «-> Змінити», «↓ До кінця»), до перемикача й пілюль: bbox фокусу не перетинає шапку, рядок сесії й композер (SC 2.4.11). |
| 43 (доп.) | Композер, висота, перемикач | 1440 × 900 і Pixel 7 | • «Надіслати» посередині однорядкового поля (зверху й знизу однаково).<br>• Desktop: нова розмова рівно на екран (`scrollHeight − innerHeight ≤ 1`), `scrollY = 0` після фокуса в полі.<br>• Pixel 7: низ перемикача «Не зберігати» ≤ верх композера − 32 px. |
| 43d | Довгі слова на 320 px | Тег 40 символів, теза й назва з одним довгим словом | `cutOffAtEdges` порожній на `saved` і з обраними назвами; `revisit-pick` не прокручується вбік (`scrollWidth ≤ clientWidth`). |
| 43e | Рядок сесії | 375 і 412 px, «Розбір дня», «не зберігати», видно «Завершити» | «Не зберігати», «Не людина», «не терапія» — кожне в одному рядку. |
| 43b | Шапка `/chat/` на 320 px | `page.goto('/chat/')` | Той самий тест, що `header.spec.ts:92`, але для `/chat/`: `.brand`, `.help-link`, `.media`, «Акаунт» у межах 320 px. |
| 43c | Landscape з клавіатурою | Viewport 839 × 200 (проєкт `mobile`) | Поле вводу й остання репліка видимі; шапка й рядок сесії не липкі; під полем лише моно-рядок. |
| 44 | `forced-colors` і межі полів | `emulateMedia` | • У кнопок і поля є рамка (обчислений стиль).<br>• Без `forced-colors`: обчислений `border-color` композера, полів тез, назви, нового тегу й пошуку = `--color-text-dim` (`rgb(132, 145, 141)`); у перемикача — видимий текст стану. |
| 45 | Пауза | — | `data-motion="off"` → без `transition`; `data-gl="off"`. |
| 46 ★ | Ключі сховища (наприкінці #1, #5, #31, #38) | — | Аудит §11.5 |
| 47 ★ | Немає «7333» у DOM | `afterEach` у всіх тестах; окремо #5, #6, #13 і діалог `help` із сирим `GET /helplines` | — |
| 48 | Немає форм | — | На `/chat/` 0 елементів `<form>`; усі `<button>` мають `type="button"`. |
| 49 | Заголовки в preview | — | • Відповідь саме на `/chat/` (не на `/chat/index.html`): CSP — точний рядок, `Permissions-Policy`, `Cache-Control: no-store`.<br>• `/chat/?auth_error=expired` → `no-store`.<br>• `/chat` (`maxRedirects: 0`) → `308`, `Location: /chat/`, `no-store`.<br>• На `/` та сама CSP.<br>• Порушень CSP немає на жодній сторінці. |
| 50 | Stop-list на `/chat/` | — | §11.6 |
| 51 | Діалог `help` | — | • Відкривається, не обриваючи стрім.<br>• Звук мовчить.<br>• Лінії — з санітизованого `GET /helplines`; «7333» немає. |
| 53 | Live-рядки в дереві доступності | Нова розмова, розмова, `summarizing` (502), `review` | `composer-status`, `chat-line`, `sum-status`, `review-tag-error` відрендерені (`getClientRects`, без `[hidden]` вище), поки порожні (§5.7). |
| 51b | Діалог відкритий, а екран змінився (shim) | Відкрити `help` під час стріму, shim шле `crisis`; окремо `account` + `turn` → 401 | `dialog[open]` немає, `document.activeElement` — `h1` нового екрана. |
| 63 ★ | Щоденник: лінивий вхід, тиждень, записи, «До розмови» | `timezoneId: Europe/Berlin`; `/tags`, `/reviews/weekly` — не серед типових | • До входу 0 запитів `/tags` і `/reviews/weekly`; на вході по одному, `tz=Europe/Berlin`, без `week_start`.<br>• «Цей тиждень», «2 збережені записи», «Теми: робота, сон»; дата, тези «01», теги.<br>• У `data-*` списку — лише id і гачки.<br>• `beforeunload` = 1, «До розмови» повертає розмову й текст у полі; записи зникають з DOM; аудит сховищ. |
| 63b | Немає входу під час стріму; з `ended` | shim | Під час відповіді в меню немає «Відкрити щоденник»; з `ended` — щоденник без `beforeunload`, кнопка «Нова розмова». |
| 64 | Тиждень | 422 `invalid_timezone`, далі 500 на 4-му запиті | Повтор з `Europe/Kyiv`; «12–18 жовтня» з `week_start=2026-10-12`; рядок помилки й «Спробувати ще раз»; «Наступний тиждень» на поточному — `aria-disabled`, нічого не шле. |
| 65 | Пошук, тема, «Показати ще» | `page.clock` | 299 мс — нічого, 300 — один запит `q`; тема додає `tag` (AND); «Показати ще» — `cursor` + `q` + `tag`; Enter — одразу; «За запитом «кава» нічого не знайшлося.» |
| 66 ★ | Правка запису | `PATCH` → запис із `edited_at` | Без змін, «Скасувати» і Esc — 0 PATCH; тіло: назва, тези, теми з `source: 'ai'` для наявного тегу; «· змінено»; фокус на «Редагувати»; знову `/tags`, тиждень, `/summaries`. |
| 67 | 403 `consent_required` на PATCH | `/consents` → усі відсутні | Банер `consent-resume-patch`; після згоди той самий PATCH (`raw` однаковий) і щоденник. |
| 68 | Видалення | `DELETE` → 204 | Підтвердження з фокусом на «Залишити»; DELETE лише після «Видалити»; «Запис видалено.»; фокус на «Редагувати» наступного запису. |
| 69 | Копія запису (desktop) | запис із номером на паузі | Markdown із замаскованим номером; «Скопійовано» і live-регіон. |
| 70 | «Повернутися до цього» | `ctx.diary` порожній на старті | Ім'я в «Ви повертаєтеся до:», `revisit_summary_ids: [id]`; над розмовою — `confirm(revisit-restart)`, «Скасувати» лишає щоденник, «Почати нову» — поле порожнє. |
| 71 | Порожній щоденник; збій списку | `[]`; 500 | Один рядок без тижня, пошуку й тем; «Не вдалося завантажити записи.» і повтор. |
| 72 ★ | axe щоденника в обох темах | — | Список, правка з порожньою назвою, підтвердження видалення — темна і світла. |
| 73 | 320 px (mobile) | тема з 40 символів, довга назва | `cutOffAtEdges` порожній для списку й форми; стрілки тижня ≥ 44 px. |
| 75 ★ | Інструменти з клавіатури | — | Кожен пункт «+ Інструменти» відкриває модальний `<dialog>` з назвою; меню закрите; Tab не виходить на сторінку під ним; Esc і «Закрити» повертають фокус на «Інструменти». |
| 76 ★ | «Подихати хвилину» | `page.clock` | Опис діалогу — рядок обраного дихання; «Почати» → фокус на «Стоп»; 4 / 6 с, лічба 4 3 2 1; `role="status"` пише лише зміну кроку; CSS-куля без анімації; через хвилину «Хвилина минула.» і «Ще хвилину»; «Стоп» закриває; `data-presence` `breathing` («Дихальна вправа») → `idle`; зітхання: «Вдих», «Ще трохи», «Видих»; повторне відкриття — з початку; 0 запитів. |
| 77 | Без руху — відлік | «Пауза», `reducedMotion: 'reduce'` | З рухом лічба схована, `transition` має `scale`; без руху лічба видима, `scale: none`, анімацій немає. |
| 78 | «Заземлення 5-4-3-2-1» | — | Полів вводу немає; опис діалогу — крок на екрані; «Крок N з 6»; 5 4 3 2 1; status кроку; фокус на «Далі» / «Готово»; «Ще раз»; рядок про повітряну небезпеку лише на першому кроці. |
| 79 ★ | «Як ви зараз?» | — | Чип нової розмови; 4 клітинки `aria-pressed`, 6 слів; «Додати до розмови» → «Зараз у мене — напруга.» у полі, `POST /chat/turn` немає; Esc нічого не пише; «А зараз?» на `review` і «Збережено» → «Спершу — напруга, зараз — спокій.»; слово «А зараз?» не йде в жоден запит; записів у сховище 0; нова розмова — без рядка. |
| 79b | `ended` | — | Без чек-іну — нічого; з ним — «Спершу — втома.» і «А зараз?». |
| 80 ★ | Криза закриває інструменти (shim) | криза посеред кожного | Хвилина, що йде, заземлення, чек-ін, укриття, укриття → дихання: `dialog[open]` = 0 у той самий таск, що й `data-screen="crisis"`; фокус на `h1`; `quiet`; годинник вправи стоїть; у «Якщо важко» в кризі інструментів немає. |
| 81 | «В укритті» | світла тема | Опис діалогу — рядок про безпеку; слів стоп-листа немає; фон і текст темної теми, `html` і `theme-color` теж (після закриття — знову папір); кнопки ≥ 64 px; звук не `on`; дихання й заземлення над ним темні, Esc повертає в укриття; 0 `GET /helplines`. |
| 81b | Темний острів укриття | обидві теми | Обчислені кольори кожного вузла (і `::before`/`::after`) укриття, дихання над ним (початок з відкритим `<details>` і фокусом, хвилина) і заземлення над ним однакові в темній і світлій темі. |
| 82 ★ | «Аптечка» без розмови | `/me` → 401 | Екран входу: три інструменти, 0 запитів (крім шрифтів), 0 записів у сховище. 82b: «Якщо важко» → інструмент над ним, Esc назад; лише свій `GET /helplines`; сесія не почалася. |
| 83 | axe інструментів | обидві теми | Дихання (початок і хвилина), заземлення, чек-ін зі словом, укриття, дихання в укритті, «Якщо важко» з інструментами. |
| 84 | axe | обидві теми | Екран входу з «Без входу»; `review` з «А зараз?». |
| 85 | 320 px і 839 × 200 (mobile) | — | Нічого не виходить за край діалогу; «Стоп» видно й після прокручування тіла. |
| 86 ★ | Нічого не тікає з-під вказівника | — | «Далі» на тому самому місці на кожному кроці; два кліки миші в одну точку — крок 2, потім 3; у кінці на тому місці «Готово». Чек-ін: натиснута клітинка й «Пропустити» не зсуваються, коли зʼявляються слова. Дихання: «Закрити» → «Стоп» на тому самому місці. |
| 87 | Чек-ін без стартерів; «А зараз?» під час збереження | новий сценарій сервера; `POST /summaries` затримано | Сценарій без власних чипів — лише «Як ви зараз?»; поки тези зберігаються, «А зараз?» `aria-disabled` і нічого не відкриває; на «Збережено» — відкриває. |
| 88 ★ | «→ У тези» від позначки до «Взяти з собою» | — | Назви «У тези / Копіювати відповідь N, HH:MM» унікальні; на desktop дії сховані до наведення, натиснута видна завжди; live-регіон «Додано до тез · 1 з 5» / «Прибрано…»; тіла ходу й підсумку без позначок; на `review` — «Позначене в розмові», axe; «Додати до тез» → пʼята теза з фокусом, шоста `aria-disabled` з описом; «Прибрати» лишає фокус поруч; `POST /summaries` несе текст відповіді; «Збережено» — «Взяти з собою» і рядок про людей, без похвали, axe. |
| 89 | Позначки належать розмові | 6 відповідей, потім криза | Пʼять — максимум, шоста не ставиться й каже чому; тези → «Повернутися до розмови» — пʼять натиснутих; у кризі ні дій, ні рядка паузи. |
| 90 ★ | Нагадування про паузу | `page.clock` | На 39:30 рядка немає, на 40:00 — є, `role="status"`; фокус не зрушив, поле приймає повідомлення; axe; «Сховати» — назавжди (ні з часом, ні з відповіддю). |
| 91 | Таймер і екрани | `page.clock`, щоденник, криза | 30 хв у розмові + 15 у щоденнику → після «До розмови» рядок є; «Зібрати тези» → «Завершити розмову?», рядок зник, Esc → фокус на «Завершити розмову»; у кризі — нічого; нова розмова після неї: на 39:30 від її першого повідомлення нічого, на 40:00 — рядок. |
| 92 | Мʼякий кінець | — | `ended` і `saved` без позначки: рядок про людей, без похвали, без «Взяти з собою»; `tel:112` на `ended`; axe. |
| 93 | Спокій під згасанням, бульбашка, Tab | — | Після кожного з трьох обмінів (сторінка не рухалася 400 мс) жоден рядок тексту не стоїть частково в `--fade-top` (1.75rem); бульбашка має рамку 1 px і фон, відмінний від сторінки; «Інструменти» перед полем у DOM і ліворуч; Shift+Tab із поля — на нього. |
| 93b | Перше повідомлення без руху | `prefers-reduced-motion: reduce` | Повідомлення стоїть рівно на `scroll-padding-top` + `scroll-margin-top`; перша репліка не в згасанні. |
| 94 | «AI, не людина» в рядку сесії | обидва проєкти | Desktop: схований, є мітка під кулею й рядок під полем, `.session__label` = «Вільна розмова»; телефон: видно разом із малою кулею. |
| 95 | `theme-color` до модуля | модуль сторінки підмінено порожнім | Світла система → `rgb(246, 241, 234)`, темна → `rgb(18, 26, 27)` (на `/` — ніч `rgb(4, 7, 8)`, hex із `theme-color` сторінки); вибір `liora:theme` перемагає систему. |
| 96 | Назви неба, примітка входу, жолоб під scrim | обидві теми | Примітка — Onest, без капсу; «Ніч/Сутінки/Світанок» у темній, «День/Вечір/Ранок» у світлій, значення ті самі; `html` під відкритим аркушем — `--color-bg-under-scrim` (де є `data-gutter`; інакше `--color-bg`), після закриття — `--color-bg`; `scrollbar-color` — колір рамки поля. |
| 97 | WCAG 1.4.11 | обидві теми | Жоден елемент керування на розмові, аркуші «Акаунт», тезах із кандидатом і в «Якщо важко» не тримається лише на рамці < 3:1. |
| 98 | axe, світла тема | `page.clock` | Позначена відповідь, рядок паузи, кандидати, «Збережено» з «Взяти з собою», `ended` з рядком про людей. |
| 99 | Смуга браузера після діалогу | тема з «Акаунт»; «В укритті» над «Якщо важко» | Після закриття аркуша `theme-color` = `--color-bg` нової теми (не сірий scrim); над укриттям — темний, після обох діалогів — знову колір сторінки. |
| 100 | Рядок паузи не закриває кінця | 320 × 640, довга відповідь, `page.clock` | Кінець відповіді над полем з тим самим відступом, без пілюлі «↓»; фокус не зрушив. |
| 100b | Прокрутили вгору | те саме | `scrollY` не змінився. |
| 101 | Подвійний клік | `page.clock`, три позначки | «Зібрати тези» → `confirm(end)` лишається «Завершити розмову?»; «Прибрати» — мінус одна позначка; «Додати до тез» — одна теза, фокус у ній. |

**axe** (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) ★ — на кожному стані й накладці:
- `booting`;
- `signed-out`: без банера, з банером, після виходу;
- `not-invited`: без сесії і з сесією;
- `consent`: `first`, `update`, `resume`, з відкритим «Не зараз»;
- нова розмова: `free` і `revisit` з порожнім щоденником;
- `revisit-pick`;
- `chat`: простій, стрім, рядок помилки, `cooldown`, блок межі;
- `session-expired`;
- `crisis`;
- `summarizing`;
- `review`: з помилкою на полі і в режимі «не зберігати»;
- `saved`, `ended`, `account-deleted`, `fatal`;
- діалоги `account`, `help`, `confirm` (кожен `kind`, що має текст);
- пресети неба «Сутінки» і «Світанок» на `chat` і `crisis` (у світлій темі — «Вечір» і «Ранок» на аркуші «Акаунт»);
- фаза C3: позначена відповідь, рядок паузи, «Позначене в розмові», «Збережено» з «Взяти з собою», `ended` — в обох темах (#88, #90, #92, #98).

### 11.5 Аудит сховищ

Код — з [E].

```ts
const audit = await page.evaluate(async () => ({
  local: Object.keys(localStorage),
  session: sessionStorage.length,
  idb: (await indexedDB.databases?.())?.length ?? 0,
  caches: (await caches.keys()).length,
  sw: (await navigator.serviceWorker?.getRegistrations())?.length ?? 0,
  cookie: document.cookie,
}))
expect(audit.local.every((k) => k === 'liora:motion' || k === 'liora:sky')).toBe(true)
expect(audit).toMatchObject({ session: 0, idb: 0, caches: 0, sw: 0, cookie: '' })
```

Додатково: текст першого повідомлення людини не знаходиться ні в `localStorage`, ні в URL, ні в
`document.title`, ні в повідомленнях `console`.

### 11.6 Stop-list для `/chat/`

1. Масив `forbidden` з `landing.spec.ts` виносимо в `chat-fixtures.ts`, і його використовують обидва
   тести. Це:
   - «№ 1», «перший у світі»;
   - «наскрізне шифрування»;
   - «7333»;
   - zero retention і «нульове зберігання»;
   - **«нічого не залиш…»** (`/нічого не залиш/`) — нове: «у Liora нічого не залишиться» — це та сама
     обіцянка нульового зберігання, а сервер пише технічні рядки на кожен запит (§3.7.8). Додаємо в спільний
     масив, тож воно діє й на лендінгу; там цієї фрази зараз немає
     `[verified: grep -rn "нічого не залиш" index.html src tests → порожньо]`;
   - «анонімн»;
   - обіцянки про постачальника: «постачальник … не логує / не зберігає / не бачить», «навіть
     постачальник».
2. Тест знімає `hidden` з кожного `[data-screen]`, відкриває `<details>` і шаблони діалогів. Потім
   збирає:
   - `innerText`;
   - `aria-label`;
   - `title`;
   - `meta description`.
3. Виключення: назви ліній допомоги й транскрипт. Вони мають `[data-no-stoplist]`, бо, наприклад,
   «психологічна підтримка» в `lines[]` спрацювала б на клінічне сито.
4. Клінічне сито — як на лендінгу: слово «терапі…», «психолог…», «лікує», «діагноз…» тощо дозволене лише
   із запереченням у тому самому реченні або в запитанні. Застосовуємо його лише до статичного тексту.
5. Правило «немає 18 у hero» на `/chat/` не діє: там обовʼязкова галочка віку.

### 11.7 Тести лендінгу (правки в наявних файлах)

- **CTA:**
  - на `desktop` — `a[href="/chat/"]` з назвою «Розмова з AI» у шапці;
  - на `mobile` — перший елемент меню.
- **Посилання кулі:** `a.hero__orb-link[href="/chat/"][tabindex="-1"][aria-hidden="true"]`. Axe, як і
  раніше, без порушень.
- **Футер** містить нове речення про cookie.
- **Без змін:**
  - `/` робить 0 запитів до `/api/`;
  - «collects nothing»: без cookie у свіжому контексті, без форм, без сторонніх запитів;
  - тест шапки на 320 px.
- **Нове:**
  - `cutOffAtEdges` на 1024 × 768 з CTA;
  - порушень CSP на `/` немає;
  - `/?auth_error=expired` → `/chat/`.
- **Рух лендінгу (фаза D2, §9.4 п. 8):** `tests/e2e/landing-motion.spec.ts`, без WebGL.

### 11.8 `@stack` (`chat.stack.spec.ts`)

Лише локально, 1 воркер, без `@gpu`, проєкт `desktop`.

**Стек** — команда з контракту, §8 (`devops/docs/runbooks/deploy.md:311-313`):
- `LLM_PROVIDER` має бути `fake`;
- контейнер `web-client` збираємо з поточного коду
  (`docker compose -f compose.yaml -f compose.local.yaml up -d --build --wait`);
- адреса — саме `http://localhost:8088`, не `127.0.0.1`: CSRF звіряє origin дослівно.

**Вхід:**
- `page.request.post('/api/v1/auth/dev', { data: { email } })`, де
  `email = e2e-${testInfo.workerIndex}-${Date.now()}@example.com` — бо ліміт 20 ходів на хвилину й
  LLM-слот один;
- cookie потрапляє в контекст сторінки, бо `page.request` ділить з ним сховище cookie;
- згода — через UI, тож `Origin` ставить сторінка.

| # | Тест | Перевірки |
|---|---|---|
| S1 | Щасливий шлях через UI | 1. Згода показує справжні постачальника й країну з `GET /consents`.<br>2. «Вільна розмова» → повідомлення → у стрімі приходить fake-відповідь «Дякую, що поділилися. Що в цій ситуації зачепило вас найбільше?».<br>3. «Завершити» → «Підсумувати» → назва «Розмова про день» і 3 тези.<br>4. Правимо тезу → «Зберегти в щоденник» → `page.request.get('/api/v1/summaries')` містить виправлений текст. |
| S2 | Keyword-криза наживо | Синтетична фраза «Я не хочу жити.» (з `server/tests/test_crisis.py`) → кризовий екран; «7333» немає; `textarea` немає. |
| S3 | «Повернення до теми» | Після S1 сценарій доступний; хід з обраним записом → 200. |
| S4 | Видалення акаунта через UI | Після нього `GET /api/v1/me` → 401. |
| S5 | Заголовки наживо | • `/chat/`: CSP — константа, `cache-control: no-store`, `Permissions-Policy`.<br>• `/`: та сама CSP.<br>• Порушень CSP немає.<br>• `POST /consents` зі сторінки не отримує `csrf_failed`. |

### 11.9 Ціна в CI

- Моки без мережі; WebGL у CI вимикається сам (немає GPU → `data-gl="off"`).
- Два проєкти в тому самому job, нових job і тригерів немає.
- Приріст часу — `[unverified]`; заміряти після першого прогону. Бюджет хвилин Actions — Free.

---

## 12. Критерії приймання

**A1. Вхід з лендінгу**
- [ ] На `/` від 64em у шапці є «Розмова з AI →» (`href="/chat/"`), на телефоні — перший пункт меню.
- [ ] Клік по кулі hero веде на `/chat/`.
- [ ] `/?auth_error=…` веде на `/chat/?auth_error=…`.
- [ ] `/` не робить запитів до `/api/`.

**A2. Розкриття, що це AI**
- [ ] Мітка «AI» біля кожної репліки.
- [ ] «AI · не людина» біля кулі.
- [ ] Під полем — «AI, не людина · може помилятися · не терапія».
- [ ] Слово «Liora» ніде не підписує репліку.

**A3. Згода**
- [ ] Три окремі галочки; кнопка завжди активна.
- [ ] `{provider}` і `{country}` — з `GET /consents`.
- [ ] Є «повного тексту розмови на сервері Liora немає».
- [ ] Немає обіцянок нульового зберігання («нічого не залишиться»), «постачальник не логує» чи
  «наскрізного шифрування».
- [ ] У режимі `resume` згода береться зі свіжого `GET /consents`; після згоди дія повторюється сама,
  зокрема після зміни версії умов (#10b).
- [ ] Посилання на сторінку політики немає.
- [ ] 409 знімає галочки.
- [ ] «Не зараз» чесно каже, що акаунт уже створено.

**A4. Стрім**
- [ ] `fetch` + `ReadableStream`, без `EventSource` і `mode`.
- [ ] `: ping` ігнорується; кадри, розрізані між чанками, збираються правильно.
- [ ] Обрив → рівно 1 автоповтор з ідентичним тілом.
- [ ] Таймер заголовків знято після resolve `fetch`: відповідь, що стрімиться довше за 35 с, доходить до
  `done` (#22b). Причина abort визначає результат (§5.5).
- [ ] `error` і `crisis` після токенів прибирають частковий текст, зокрема відкладений flush (#6b).

**A5. Помилки**
- [ ] Кожен рядок §4.3 має свій текст, і жоден не показує `error.message`.
- [ ] Порожній 502/504 не кидає виняток.
- [ ] `Retry-After` поважається: 429 — лише вручну, `llm_busy` — авто ×2.

**A6. Приватність у браузері**
- [ ] У сховищі лише `liora:motion` і `liora:sky`.
- [ ] Транскрипт не потрапляє в URL, `title`, `console` чи storage.
- [ ] `beforeunload` — за I7.
- [ ] `pageshow` з `persisted` після виходу стирає розмову.

**A7. Криза**
- [ ] Поле вводу видалене з DOM, фокус на `h1`.
- [ ] 112, 103 і howareu — константи; `abroad.url` з payload не використовується.
- [ ] «7333» у DOM немає за жодного payload.
- [ ] На 412 × 839 обидва номери видно без скролу.
- [ ] Звук мовчить, `data-presence="quiet"`.
- [ ] Вихід лише в нову розмову.

**A8. Тези**
- [ ] Правка на місці, «Повернути» без таймера, хоча б одна теза лишається.
- [ ] Теги з `source` `ai` чи `user`.
- [ ] «Видалити тези» не робить запиту.
- [ ] У режимі «не зберігати» немає «Зберегти».
- [ ] Мережева помилка при збереженні не створює дубля.

**A9. Акаунт**
- [ ] Email, експорт .md і .json.
- [ ] Відкликання кожної згоди з власним текстом; `data_processing` попереджає про видалення щоденника.
- [ ] Вихід.
- [ ] Видалення акаунта з переліком того, що лишається, і застереженням про постачальника; стартовий
  фокус на «Скасувати».
- [ ] 401 на повтор `DELETE /me` після невідомого результату → `account-deleted(presumed)`, а не
  «Увійдіть, щоб видалити акаунт» (#38).

**A10. Доступ за запрошенням**
- [ ] `?auth_error=not_invited` і 403 `not_invited` → спокійний екран з допомогою й виходом, без слова
  «помилка».
- [ ] Транскрипт не стирається, неподане повідомлення — теж (#8b).

**A11. Візуал**
- [ ] Ті самі токени, шрифти й шапка; без карток, glass і градієнтного тексту.
- [ ] Приглушення лише кольором.
- [ ] Канвас лише в слоті; сцена праворуч на desktop.
- [ ] Без WebGL — статична куля, і сторінка повна.

**A12. Доступність**
- [ ] axe без порушень WCAG 2.2 AA на кожному стані й накладці (§11.4).
- [ ] Фокус за I6: після закриття діалогу — на ініціатора (або «Акаунт», або `h1`), ніколи на `body`;
  зміна екрана закриває діалоги.
- [ ] Фокус не ховається під шапкою, рядком сесії чи композером (SC 2.4.11, #43).
- [ ] ≤ 2 непорожні оновлення live-регіону за хід; після стирання розмови регіон порожній.
- [ ] 320 px і масштаб 200 % без горизонтального скролу.
- [ ] Цілі влучання за SC 2.5.8: кожна ≥ 24 × 24 px або з достатнім відступом; основні дії (перелік у §3.1
  «Фокус і рух») ≥ 44 px. Перевіряє bbox у тесті розкладки.
- [ ] Межі текстових полів ≥ 3:1 (SC 1.4.11), стан перемикача — не лише кольором (#44).
- [ ] `forced-colors` працює.

**A13. Безпека**
- [ ] CSP з ADR-007 дослівно на `/` і `/chat/` — у `deploy/Caddyfile` і `preview.headers`.
- [ ] `Permissions-Policy` на обох сторінках.
- [ ] `/chat/` — `no-store`.
- [ ] Порушень CSP немає в жодному тесті.
- [ ] Немає `<form>` та inline script/style.
- [ ] Grep-правила §10.5 зелені.

**A14. Залежності й сховище**
- [ ] `package.json` без нових залежностей.
- [ ] Звук вимкнений за замовчуванням.
- [ ] «Пауза» працює й на `/chat/`.

**A15. Ядро**
- [ ] `src/chat/core` проходить тест чистоти.
- [ ] `chat-core.spec.ts` зелений.

**Команди** (вивід кожної — у PR):
- [ ] `npm run build`;
- [ ] `npx tsc --noEmit -p tsconfig.json`;
- [ ] `npx playwright test --project=desktop --project=mobile --grep-invert "@gpu|@stack"` (як у CI);
- [ ] `npx playwright test --project=iphone-webkit tests/e2e/chat.spec.ts` (локально);
- [ ] `@stack` за §11.8 (локально, 1 воркер).

**Залежності до релізу** (§1.3, стан на 2026-10-07):
- [x] server#5 злитий (`628a571`) і задеплоєний; прод перевірено;
- [x] ADR-007 злитий (`fd0e27d`) з однією CSP на весь сайт; `Permissions-Policy` додаємо без поправки ADR;
- [x] `compose.local.yaml` використовує `:8088`;
- [ ] FAQ: «на зашифрованому диску сервера Liora» з джерелом `devops/docs/runbooks/deploy.md:25`;
  у PR — `[unverified]` щодо стану тому в AWS;
- [x] відповіді на B1–B3: FAQ правимо; постачальника на лендінгу називаємо зараз; Trusted Types — пізніше.

---

## Додаток A. Хто переміг у кожній області

| Область | Переможець | Чому | Щеплено від інших |
|---|---|---|---|
| Архітектура стану | [E] reducer + ефекти, інваріанти I1–I9 | Лише його можна перевірити тестом без браузера; ядро переноситься в мобілку | Назви станів і тексти — [C] |
| Адреса й роутинг | Усі згодні: одна `/chat/`, без `pushState` | — | Аргумент проти хеш-маршрутів — [P] |
| Помилки входу | [C][P]: банер на екрані входу | На один стан менше, кнопка входу поруч | Білий список кодів — [P]; `role="status"` — [C] |
| `not_invited` | [C] (тексти), [C][P] (транскрипт не стирається) | Чесне «нічого не збережено» перевірено в коді; не стирати написане без дії людини | Блок допомоги — [C]; експорт і копія — [P] |
| Згода | Тексти [C] | Найповніший і найчесніший; без «тимчасово» | Мапа країни + `Intl` — [E]; формат версії й «без провайдера — без згоди» — [P]; режими `update`/`resume` — [E]; «Не зараз» — [C] |
| Вибір сценарію | [C]: перемикач над полем вводу | На екран менше | Описи з клієнтського словника — [P]; `GET /summaries` паралельно — [E] |
| «Не зберігати» | [C]: перемикач є | ADR-005 і лендінг визначають цей режим | Спрощення копії в кінці — [P] |
| Бік сцени й сітка | [C][E]: сцена праворуч, колонка 42rem — [C] | Продовження кулі hero | Канвас лише в слоті, маска, `bokeh: 0` — [P] |
| Модель скролу | [C][E]: скрол документа | ADR-006 «скрол нативний», a11y | Якір надсилання й пілюля «↓» — [P] |
| Шрифт реплік AI | [C]: Onest бірюзою | Читання в стресі | Ритм відступів і абзаци — [P] |
| Композер | [P] | Найповніший: стани кнопки, IME, `pointerdown`, плейсхолдери | Кодові точки замість `.length` — [E]; рядок про збереження — [C]; Ctrl+Enter — [C] |
| Очікування | [P]: фазові мітки | Чесно про чергу до LLM-слота | `HEADERS_TIMEOUT` 35 с — [E] |
| «Зупинити» | [C][E]: часткову відповідь прибираємо | Одне правило I3 | «Не надіслано» з діями — [P] |
| SSE-парсер і повтори | [E] | Повний код, бюджети, watchdog-и | Підсумок 150 с — [C]; rAF-флаш і 300 мс без руху — [P] |
| Мапа помилок | [E]: класифікатор; [P]: місця показу | — | Тексти здебільшого — [C]; дедуплікація збереження — [E] |
| Криза: дані | [E]: 112/103/howareu константи, `abroad.url` ніколи, фільтр 7333 | Найменший ризик | Фолбеки й `free === null` — [C] |
| Криза: розкладка | [P]: номери першими, транскрипт у `<details>` | «The numbers come first» + не стирати раптово | Номери поруч на телефоні, без `alert` — [C]; каркас у HTML — [E]; «AI не може викликати допомогу» — [P] |
| Після кризи | Усі згодні: одразу нова розмова | Автономія; сервер перевіряє заново | Рядок «Якщо важко» на новій розмові — [E] |
| Завершення | [C][E]: діалог з «Завершити без тез» | Не передавати текст постачальнику вдруге без потреби | Двокроковий confirm — [E] |
| Перегляд тез | [P]: правка на місці | Один клік на правку | «Повернути» без таймера — [C]; межі кодовими точками — [E] |
| Меню акаунта | [E]: бічний аркуш і відкликання згод | GDPR ст. 7(3), екран згоди на це посилається | Тексти видалення — [C]; без чекбокса — [C][E] |
| `<title>` | [C]: незмінний | Не видає кризу в назві вкладки | — |
| Колір небезпечних дій | [P][E]: `--color-light` | У палітрі немає червоного | — |
| Тести | [E]: матриця, shim, аудит сховищ | — | Перевірки кризи на 412 × 839 — [C]; `auth_error` по кодах — [P]; ядро в `tests/e2e` (а не `tests/unit`) — власне рішення |
| Trusted Types | Відкладено (власне рішення) | Однакова CSP для `/` і `/chat/` за задачею | Пропозиція — [E], питання B3 |

## Додаток B. Питання до власника

Максимум три. У кожному — що беру, якщо відповіді не буде.

- **B1. Видалення окремого запису щоденника у вебі.** Лендінг (FAQ) обіцяє: «Будь-який запис можна
  видалити окремо». У MVP вебу цього немає.
  - (a) **Беру:** поправити відповідь у FAQ (§9.4) і не обіцяти цього на екрані згоди.
  - (b) Додати у фазу 2 мінімальний «Мій щоденник» [C, S14]: список, «Показати ще», «Видалити запис».
    Це ще ~1 день і 2 екрани.
- **B2. Назва постачальника на лендінгу вже у фазі 2,** а не у фазі 3, кроці 4.
  - (a) **Беру:** так. Екран згоди вже називає Ollama Cloud (США), тож «ще обираємо» стало б неправдою.
  - (b) Лишити до фази 3 і прийняти розбіжність для запрошених тестувальників.
- **B3. Trusted Types** (`require-trusted-types-for 'script'; trusted-types 'none'`).
  - (a) **Беру:** окремий PR на обидві сторінки після поправки ADR-007 і прогону `@stack` без порушень.
  - (b) Не вмикати; лишити grep-правило.

**Припущення.** Кожне — з відкинутою альтернативою; якщо не так, скажіть.

| Беру | Замість | Чому |
|---|---|---|
| Надсилати `opening_message` першою реплікою `assistant` | Не надсилати | Модель має бачити запитання, на яке відповідає людина. Ціна — одне місце з 200. Реакцію моделі — `[unverified]`, перевірити на стеку. |
| Не повторювати автоматично помилки мережі (`TypeError`) | Один автоповтор [E] | Людина контролює повтор; кнопка оживає на подію `online`. |
| Сторінку щоденника не робити в MVP | Робити | План фази 2 її не містить. Збережене видно в експорті й на екрані `saved`. Див. B1. |
| Незмінний `<title>` | Заголовок під кожен екран | Не видає стан у назві вкладки. |
| Слот кулі `min(100%, 30vw, 26rem, 52svh)` на desktop | Дві колонки лише від ~75em | Одна властивість, без нової точки зламу; на 1024 px куля ≈ 219 px, але не заходить на текст (§3.1). |
| Фолбек «лише `free`», якщо `GET /scenarios` упав | Рядок помилки без композера | Людина може говорити одразу; перша репліка — текст із контракту (§3.6). |
| Стек `account` → `confirm` | Закривати `account` перед `confirm` | Фокус після «Скасувати» має куди повернутися (I6, WCAG 2.4.3). |
| Цілі влучання за SC 2.5.8 (основні дії ≥ 44 px) | Підняти шапку й пілюлі до 44 px | Шапка `/chat/` лишається ідентичною лендінгу (40 px); основні дії й так ≥ 44 px (§3.1, A12). |

## Додаток C. Що перевірено в цій сесії

| Факт | Команда | Вивід |
|---|---|---|
| Same-origin `fetch` POST під `Referrer-Policy: no-referrer` | `node phase2/origin-check/check.cjs` (локальний http-сервер + Playwright Chromium і WebKit) | Chromium: усі три варіанти → `Origin: http://localhost:47123`. WebKit: без `mode` → справжній; з `referrerPolicy: 'same-origin'` → справжній; з `mode: 'same-origin'` → `Origin: null`. |
| Назви країн | `node -e "…new Intl.DisplayNames(['uk'],{type:'region'})…"` | `US=Сполучені Штати DE=Німеччина XX=XX` |
| Формат версії умов | `node -e "…Intl.DateTimeFormat('uk',{day:'numeric',month:'long',year:'numeric'})…"` | `6 жовтня 2026 р.` |
| Кодові точки проти UTF-16 | `node -e "…[...'😀'.repeat(3)].length, '😀'.repeat(3).length"` | `3 6` |
| Ключ multi-page у Vite 8 | `grep -n "rolldownOptions\|rollupOptions" node_modules/vite/dist/node/index.d.ts` | `rollupOptions … @deprecated Use rolldownOptions instead`; версія `8.3.3` |
| `preview.headers` | `grep … CommonServerOptions … headers` | `headers?: OutgoingHttpHeaders` |
| `not_invited` не створює акаунт | `grep -n "ensure_allowed\|_sign_in" server/app/api/auth.py` | `162: ensure_allowed(...)`, `163: signed_in = await _sign_in(...)` |
| Серверна гілка з whitelist helplines і редиректом `auth_unavailable` | `git -C server log` / `git branch -a --contains 4bedbe0` | `4bedbe0 fix(api): serve one public helplines projection; redirect unconfigured Google start` на `fix/4-crisis-helplines-auth-start` (є на origin; `main` = `64b768b`) |
| CSSOM-запис стилю в `src/` | `grep -rn "setAttribute('style'\|cssText\|innerHTML\|insertAdjacentHTML" src` | Лише `src/gl/scene.ts:503: probe.style.cssText = …` |
| Inline script/style у збірці лендінгу | `grep` по `index.html`, `dist/index.html`, `dist/assets/*.css` | Один `<script type="module" src>`, `<style>` — 0, `style=` — 0, `data:` — 0 |
| Опис `situation` з «КПТ» | `grep -n "КПТ" server/app/chat/prompts.py` | `46: description="Тригер → реакція → альтернативний погляд (техніка з КПТ).",` |
| Сирий `helplines.json` містить 7333 у `notes` | `cat server/app/safety/helplines.json` | `"notes": "Lifeline Ukraine 7333 is excluded: …"` |
| `DELETE /me` вимагає живої сесії; 204 на повтор — лише паралельному запиту | `sed -n 35,70p server/app/api/account.py`; `grep -n … server/tests/test_hardening.py` | `async def delete_me(user: CurrentUserDep, …)`; коментар «A second request (double tap, client retry) that waited on the lock…»; `430: test_a_double_tapped_account_deletion_answers_204_twice` |
| `granted` у `GET /consents` — лише поточна версія умов | `sed -n 58,100p server/app/api/account.py` | `.where(Consent.user_id == user_id, Consent.policy_version == settings.policy_version, Consent.revoked_at.is_(None))` |
| Сервер логує метадані кожного запиту | `sed -n 1,10p server/app/logging.py`; `sed -n 115,140p …` | «What is logged: method, route template, status, latency, request id, a pseudonymous user hash and LLM token counts»; поля `method`, `route`, `status`, `ms`, `user`, `llm_tokens` |
| Порядок `GET /summaries` | `sed -n 240,256p server/app/summary/journal.py` | `order_by(Summary.created_at.desc(), Summary.id.desc())` |
| `send()` у Vite preview ставить `no-cache` безумовно | `sed -n 17672,17690p node_modules/vite/dist/node/chunks/node.js` | `cacheControl = "no-cache"` … `res.setHeader("Cache-Control", cacheControl);` |
| Плагін `no-store` у preview: старий і новий | `node phase2/vite-preview-check/run.mjs` (мінімальний MPA, Vite 8.3.3 з `web-client/node_modules`) | old: `/chat/` → `no-cache`, `/chat` → лендінг; new: `/chat/` і `/chat/?auth_error=expired` → `no-store`, `/chat` → `308 Location: /chat/ no-store` |
| `AbortSignal.timeout` у `AbortSignal.any` рве тіло; знятий `setTimeout` — ні; причина доходить до `signal.reason` | `node phase2/abort-check/check.mjs` (Node 24.15, undici) | `body failed after 502 ms: TimeoutError`; `done after 1207 ms`; `body failed after 301 ms: idle \| signal.reason = idle` |
| Контраст меж полів | `node -e "…WCAG relative luminance…"` | `line-strong` на bg 2.05, на `#0d2226` 2.21, на фоні поля 2.13; `--color-text-dim` 6.17 / 5.04 / 5.99 |
| Колонка сцени проти слота кулі | `node -e "…gutter, gap, 42rem…"` | 1024: 219 / 307; 1100: 285 / 330; 1180: 355 / 354; 1440: 592 / 416 |
| `.help__number` на 412 px | `node -e "…clamp(3.5rem, 2.4rem + 4.5vw, 7rem)…"` | `56.94` |
| Тест шапки 320 px ганяє лише `/` | `sed -n 80,105p tests/e2e/header.spec.ts` | `await page.goto('/')` |

| `tel:` запускає `beforeunload` у Chromium; capture-слухач, що знімає його, прибирає діалог | `node phase2/tel-check/check.cjs` (Playwright `chromium` channel і `webkit`, локальна сторінка зі слухачем `beforeunload`) | chromium plain: 1 подія, діалог `beforeunload`; chromium guard: 0, діалогів немає; webkit plain і guard: 0; console порожній |

**Не перевірено (`[unverified]`), і як перевірити:**
- `tel:` і `beforeunload` на Android Chrome — на пристрої (desktop Chromium перевірено вище).
- `--kb` і `html[data-kb]` (§3.1 «Екранна клавіатура») — на справжньому iPhone (Safari ігнорує
  `interactive-widget`) і Pixel 7.
- Очищення `[data-announcer]` через 5 с не обриває читання — NVDA/VoiceOver вручну.
- `interactive-widget=resizes-content` і фолбек через `visualViewport` — на справжніх Pixel 7 та iPhone.
- `field-sizing: content` у Safari — у локальному проєкті WebKit.
- Caddy `not path` з кількома значеннями і `no-store` на `/chat` — `caddy validate` і `curl -sI` на
  локальному стеку.
- Попередження в консолі WebKit — проєкт `iphone-webkit`, `watchConsole`. WebKit може попереджати про
  ключ `interactive-widget` у viewport-meta або про назви функцій у `Permissions-Policy`, а
  `watchConsole` рахує попередження як провал. Якщо зʼявляться саме ці повідомлення, додати їх у
  allowlist `afterEach` чату — точним текстом, без регулярок «на все».
- Чи вміщується CTA в шапку на 1024 px — тест `cutOffAtEdges`.
- «Зашифроване сховище» у FAQ лендінгу — звірити з `devops`.
- Реакція моделі на `opening_message` в історії — один хід на стеку з fake і з реальною моделлю.
- Приріст часу CI — після першого прогону.
