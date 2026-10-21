# web-client — liora-app

> Лендінг Liora (`/`) і веб-чат з AI (`/chat/`): дві сторінки однієї збірки Vite з процедурною WebGL-сценою.

Частина організації [`liora-app`](https://github.com/liora-app). Карта всіх репо, процес і рішення —
у [devops](https://github.com/liora-app/devops).

## Статус

Лендінг — [ADR-006](https://github.com/liora-app/devops/blob/main/docs/adr/ADR-006-web-landing.md) (Proposed):
Vite 8 + TypeScript 6 + three.js, без UI-фреймворку. Веб-чат з AI —
[ADR-007](https://github.com/liora-app/devops/blob/main/docs/adr/ADR-007-web-chat-in-web-client.md) (Proposed):
друга сторінка тієї ж збірки, той самий стек, без нових залежностей. Специфікація чату —
[`docs/chat/spec.md`](docs/chat/spec.md), контракт API — [`docs/chat/api-contract.md`](docs/chat/api-contract.md).

| Сторінка | Що це | Звернення до API, cookies |
|---|---|---|
| `/` (`index.html`) | Лендінг: hero і глави 01–07. CTA «Розмова з AI →» і клік по кулі ведуть на `/chat/`. | Жодних. Сама cookies не ставить і не читає; `/?auth_error=…` переводить на `/chat/?auth_error=…` без запиту. |
| `/chat/` (`chat/index.html`) | Розмова з AI: вхід, згода, сценарії, стрім відповіді (SSE), кризовий режим, тези, меню акаунта. | Лише same-origin `/api/v1` через `fetch`. Сесійний cookie (httpOnly) ставить сервер після входу. Транскрипт — лише в памʼяті вкладки. |

Шлях `/api/*` належить `server`. У сховищі браузера можуть бути лише ключі `liora:motion`, `liora:sky` і `liora:theme` (`light` | `dark`; без ключа — як у системі). Тему ще до першого кадру ставить `public/theme-init.js` (лише читає), пише її тільки `src/ui/theme.ts`.

## Швидкий старт

Потрібно: Node `^20.19 || >=22.12` (`.nvmrc` — 24), `pre-commit`.

```bash
gh repo clone liora-app/web-client
cd web-client
pre-commit install
npm ci
npm run dev          # http://localhost:5173
```

| Команда | Що робить |
|---|---|
| `npm run dev` | Dev-сервер Vite (5173): `/` і `/chat/`, без CSP (Vite вставляє стилі через JS) |
| `npm run build` | `tsc` (перевірка типів) + збірка обох сторінок у `dist/` (`dist/index.html`, `dist/chat/index.html`) |
| `npm run preview` | Віддає `dist/` на 4173 з тими самими CSP, `Permissions-Policy` і `Referrer-Policy`, що на проді, і `no-store` на `/chat/` |
| `npm run test:e2e:install` | Один раз: Chromium і WebKit для Playwright |
| `npm run test:e2e` | Збирає, піднімає preview і проганяє весь Playwright (desktop, mobile, iPhone/WebKit). **Лише з дозволу власника:** кожен воркер — браузер з WebGL, і ПК власника від цього зависав. Локально 1 воркер, у CI — 2 |
| `E2E_BASE_URL=<url> npx playwright test` | Той самий набір проти вже запущеного сайту (контейнер, прод), без збірки й preview |

Специфікації лендінгу (`landing`, `header`, `landing-theme`) локально — лише з WebGL, вимкненим у самому
браузері: `E2E_NO_WEBGL=1` додає Chromium-проєктам `--disable-webgl --disable-webgl2 --disable-3d-apis`
(сторінка бере статичний фон, `data-gl-reason="no-webgl2"`; без змінної нічого не змінюється, CI так само):

```bash
E2E_NO_WEBGL=1 npx playwright test tests/e2e/landing.spec.ts tests/e2e/header.spec.ts tests/e2e/landing-theme.spec.ts --project=desktop --workers=1 --grep-invert @gpu
```

Тести ядра чату (`tests/e2e/chat-core.spec.ts`) — чистий TypeScript без браузера і без сервера. Адреса
`127.0.0.1:9` лише вимикає `webServer` у `playwright.config.ts`, жодна сторінка не відкривається:

```bash
E2E_BASE_URL=http://127.0.0.1:9 npx playwright test tests/e2e/chat-core.spec.ts --project=desktop --workers=1
```

Тести з тегом `@stack` ганяються лише локально, проти compose-стеку з `devops` на `http://localhost:8088`
(саме `localhost`: CSRF звіряє origin дослівно), з `LLM_PROVIDER=fake`, 1 воркером і без `@gpu`. Без
`E2E_STACK=1` кожен такий тест пропускає себе сам, а CI відкидає тег (ADR-007):

```bash
E2E_STACK=1 E2E_BASE_URL=http://localhost:8088 npx playwright test --grep @stack --grep-invert @gpu --workers=1
```

## Як влаштовано

```
index.html            весь текст лендінгу (DOM, SEO, доступність): hero і глави 01–07
src/main.ts           вхід лендінгу: /?auth_error= → /chat/, навігація, поява, «розшифровування» міток,
                      пауза, запуск сцени
chat/index.html       весь статичний текст /chat/: екрани, діалоги, <template> для реплік
src/chat/core/        логіка чату без DOM, window і three.js (ADR-007; її можна перенести в мобілку):
                      api.ts (same-origin /api/v1), sse.ts (кадри SSE з тіла POST), turn.ts (хід:
                      watchdog-и й повтори), state.ts (машина станів, чиста), errors.ts (помилки за
                      error.code), helplines.ts (whitelist кризових контактів), limits.ts, country.ts,
                      types.ts (DTO з server/openapi.json)
src/chat/ui/          екрани чату: main.ts (вхід сторінки), store.ts → render.ts → effects.ts, screens/,
                      transcript.ts, composer.ts, dialogs.ts, announcer.ts (live-регіон), presence.ts
                      (куля в слоті персонажа), leave-guard.ts, keyboard.ts, scroll-anchor.ts, copy.ts
                      (динамічні тексти), dom.ts (лише textContent)
src/ui/               motion.ts (пауза / reduced motion), nav.ts (aria-current, HUD глави),
                      menu.ts (меню глав < 64em, нативний <dialog>), sound.ts + sound-engine.ts
                      («Звук»: генеративний пад, вимкнений за замовчуванням, лінивий чанк),
                      reveal.ts, steps.ts (приклад сесії йде за кроком), decode.ts,
                      hero-light.ts (де стоїть світло hero — спільне для CSS і сцени),
                      sky.ts (пресети неба /chat/, ключ liora:sky),
                      theme.ts (світла / темна / як у системі, ключ liora:theme, обидві сторінки;
                      подія liora:theme для WebGL), theme-picker.ts (кнопка «Вигляд» у шапці / і
                      /chat/ — меню з трьох <button>; у чаті ще радіо в «Акаунті»)
src/gl/               WebGL-шар — окремий лінивий чанк з three.js
  core/               спільне для кожної сцени (лендінг, згодом чат):
    boot.ts           чи запускати сцену; стан у <html data-gl="loading|on|off" data-gl-reason>;
                      bootGL(canvas, { load, onReady?, tier?, dprCap?, sizeTo? }): яку сцену вантажити, вирішує
                      сторінка; повертає { handle(), setActive(active) } — handle сцени (null до старту й
                      після відмови) і пауза, яку не скасують наступні sync (лендінг це ігнорує);
                      лежить у вхідному чанку, без three.js
    renderer.ts       createRenderer(canvas, { msaa }): єдине місце, де створюється WebGLRenderer
    quality.ts        тири (частинки, боке, DPR, msaa / charLod / envSize; pickTier({ force }) → ?tier=low|medium|high
                      → пристрій) і губернатор кадрів
    palette.ts        кольори WebGL на тему (дзеркало tokens.css): GL_PALETTES.dark / .light — куля чату
                      і сцена лендінгу (ScenePalette: вночі світло додається, вдень — чорнило на папері)
  scene.ts            сцена лендінгу: прозорий канвас; світлові нитки, пил і ореол (luminous-field.ts),
                      контурний портрет (contour-portrait.ts), малюнок розмови (conversation-flow.ts);
                      тема — uniforms і blending за подією liora:theme, без перебудови; цикл, пауза,
                      втрата контексту
  scroll.ts           скрол → стан сцени; «тихі» зони (data-gl-quiet)
  neural.ts           мережі нейронів: соми, аксони, дендрити, хвиля сигналу
  shapes.ts           місце кожної частинки в кожному стані (ядро, ланцюг, тези, граф щоденника)
  shaders/            GLSL
src/styles/           токени, база, небо й шари (stage.css; кольори неба — --sky-* на :root), шапка,
                      компоненти, глави; landing.css — артнапрям лендінгу і його токени (ніч у темній)
tests/e2e/            Playwright: контент, стоп-лист, шари, клавіатура, axe, сцена, фолбеки;
                      chat-core.spec.ts — ядро чату без браузера; chat.spec.ts — /chat/ проти моків
                      API (page.route, синтетичний SSE, fetch-shim для стріму по чанках, page.clock);
                      chat-fixtures.ts — обвʼязка: моки, аудит CSP/консолі/сховищ, спільний стоп-лист;
                      chat.stack.spec.ts — @stack проти локального compose-стеку;
                      landing-theme.spec.ts — теми лендінгу без WebGL (меню з клавіатури, ключ, ранній
                      скрипт, CSS-мистецтво замість темних PNG, axe у світлій)
scripts/ci-e2e.sh     e2e у CI: Chromium, без тестів з тегами @gpu і @stack
Dockerfile, deploy/   образ для хоста: збірка на node:24-alpine → статика на caddy:2, порт 8080;
                      deploy/Caddyfile ставить CSP і Permissions-Policy на все, no-store на /chat/
docs/chat/            специфікація /chat/ і контракт API
public/og.jpg         картинка для прев'ю посилань (1200×630, кадр hero)
```

- **Шари (знизу вгору):** CSS-небо `.stage` → заголовок hero → прозорий WebGL-канвас `.scene` →
  віньєтка → увесь текст для читання → шапка. Без сцени лишається те саме небо і статичне світло
  `.hero__orb`, тож перемикання не стрибає. Світло hero стоїть поруч із заголовком, а не під ним:
  `hero-light.ts` міряє рядки заголовка й пише `--light-x/-y/-d` на `.hero`, ці ж числа бере сцена.
- **Сцена декоративна.** `<canvas aria-hidden="true">`, текст тільки в DOM. Сцена не стартує або
  зупиняється без WebGL2, на програмному рендері (за назвою або за трьома повільними стартовими кадрами),
  з `prefers-reduced-motion`, після паузи кнопкою, у режимі високої контрастності, з Save-Data,
  при втраті контексту чи стабільно повільних кадрах. Причину видно в `data-gl-reason`:
  `reduced-motion` · `user` (кнопка «Пауза») · `forced-colors` · `save-data` · `no-webgl2` ·
  `software` (програмний рендер за назвою) · `slow` (повільні стартові або стабільно повільні кадри) ·
  `context-lost` · `error`.
- **Скрол нативний.** Секції мають `data-gl-state="<n>"`, сцена плавно переходить між станами;
  `data-gl-quiet` приглушує її, поки секція посередині екрана (кризові контакти). Стани:
  0 ядро AI в склі (hero) · 1 розрізнені нейрони · 2 ланцюг, по якому біжить сигнал · 3 тези ·
  4 граф щоденника · 5 скло (приватність) · 6 тихий пил без сигналу (кризові контакти, запитання) ·
  7 схід (фінал). Крок 4 «Рішення за вами» (`data-gl-decide`) гасить дві з пʼяти тез. Граф
  щоденника має ті самі вузли, що й статичне SVG `.diary__sky`. Розкладка (колонка чи широка) — від `64em`.
- **Теми (ADR-012):** «Як у системі» / «Світла» / «Темна» на обох сторінках. Світла — «ранковий папір»
  (ті самі токени, що в чаті), темна на лендінгу — його ніч (`landing.css` перевизначає темний бік токенів
  `tokens.css`; тест у `chat-core.spec.ts` тримає обидва боки рівними джерелу). Без WebGL світла тема
  малює мистецтво CSS-градієнтами (кільця чорнилом і теракотою); темні `public/*-still.png` — лише вночі.
- **Шрифти:** Martian Mono (заголовки й мітки) і Onest (текст), обидва з `@fontsource-variable`.
- **Жодних сторонніх запитів:** шрифти локальні (`@fontsource-variable`), аналітики немає. Лендінг сам
  cookies не ставить і в API не ходить; сесійний cookie зʼявляється лише після входу в чат. Це перевіряють тести.
- **CSP одна на весь сайт** (ADR-007): `default-src 'self'`, без inline-скриптів і стилів, без `data:`.
  Тому в коді немає `innerHTML`, `cssText` і `setAttribute('style')`, динамічні значення йдуть лише через
  `style.setProperty('--x', …)`, класи й `data-*`, а текст моделі — лише через `textContent`.
- Діагностика для тестів і ручної перевірки: `window.__lioraScene.stats()` у консолі (тир, частинки,
  стан, сигнал `fire`, draw calls).

## Як ми працюємо

- Процес (гілки `type/<issue>-slug`, Conventional Commits, PR, squash-merge) —
  [devops/CONTRIBUTING.md](https://github.com/liora-app/devops/blob/main/CONTRIBUTING.md).
- Задачі — Issues цього репо + дошка організації «Liora».
- CI — спільний: [`devops/.github/workflows/reusable-checks.yml`](https://github.com/liora-app/devops/blob/main/.github/workflows/reusable-checks.yml).
  У CI e2e йдуть без GPU: Chromium (desktop і mobile), без тестів з тегом `@gpu` — їм потрібен
  робочий WebGL2-контекст — і без `@stack` (`scripts/ci-e2e.sh`). CI запускається на кожен PR, зокрема
  стекований. Повний набір локально — `npm run test:e2e`, лише з дозволу власника (див. вище).
- **Деплой:** merge у `main` → `deploy-dispatch.yml` → деплой у [devops](https://github.com/liora-app/devops) ([ADR-004](https://github.com/liora-app/devops/blob/main/docs/adr/ADR-004-deploy-via-devops-dispatch.md)).
  На хості `docker compose up -d --build web-client` збирає `Dockerfile` цього репо; edge-Caddy віддає
  лендінг на `/` і чат на `/chat/`, `/api/*` іде на `server` (ADR-006, ADR-007). Ручний передеплой `main`:
  `gh workflow run deploy-dispatch.yml -R liora-app/web-client`. Після деплою —
  `E2E_BASE_URL=https://tryliora.duckdns.org npx playwright test --project=desktop --project=mobile`.
