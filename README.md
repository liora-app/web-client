# web-client — liora-app

> Головна сторінка Liora: статичний лендінг з процедурною WebGL-сценою.

Частина організації [`liora-app`](https://github.com/liora-app). Карта всіх репо, процес і рішення —
у [devops](https://github.com/liora-app/devops).

## Статус

Лендінг — [ADR-006](https://github.com/liora-app/devops/blob/main/docs/adr/ADR-006-web-landing.md) (Proposed):
Vite 8 + TypeScript 6 + three.js, без UI-фреймворку. Веб-версія самого застосунку (Expo for web) —
окреме рішення. Лендінг не звертається до API і не займає шлях `/api/*`.

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
| `npm run dev` | Dev-сервер Vite (5173) |
| `npm run build` | `tsc` (перевірка типів) + збірка в `dist/` |
| `npm run preview` | Віддає `dist/` на 4173 |
| `npm run test:e2e:install` | Один раз: Chromium і WebKit для Playwright |
| `npm run test:e2e` | Збирає, піднімає preview і проганяє Playwright (desktop, mobile, iPhone/WebKit), 3 воркери; WebKit — один |

## Як влаштовано

```
index.html            весь текст сторінки (DOM, SEO, доступність): hero і глави 01–07
src/main.ts           вхід: навігація, поява, «розшифровування» міток, пауза, запуск сцени
src/ui/               motion.ts (пауза / reduced motion), nav.ts (aria-current, HUD глави),
                      reveal.ts, steps.ts (приклад сесії йде за кроком), decode.ts,
                      hero-light.ts (де стоїть світло hero — спільне для CSS і сцени)
src/gl/               WebGL-шар — окремий лінивий чанк з three.js
  boot.ts             чи запускати сцену; стан у <html data-gl="loading|on|off" data-gl-reason>
  scene.ts            прозорий канвас: частинки, скляна сфера, ореол, боке; 8 станів; цикл, пауза, втрата контексту
  quality.ts          тири (частинки, боке, DPR) і губернатор кадрів зі стартовою перевіркою
  scroll.ts           скрол → стан сцени; «тихі» зони (data-gl-quiet)
  shapes.ts           процедурні форми частинок (світло, шум, нитки, тези, сузірʼя)
  shaders/            GLSL
src/styles/           токени, база, небо й шари (stage.css), шапка, компоненти, глави
tests/e2e/            Playwright: контент, стоп-лист, шари, клавіатура, axe, сцена, фолбеки
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
  0 світло (hero) · 1 шум · 2 нитки · 3 тези · 4 сузірʼя (щоденник) · 5 скло (приватність) ·
  6 тихий пил (кризові контакти, запитання) · 7 схід (фінал). Крок 4 «Рішення за вами»
  (`data-gl-decide`) гасить дві з пʼяти тез. Розкладка (колонка чи широка) — від `64em`.
- **Шрифти:** Martian Mono (заголовки й мітки) і Onest (текст), обидва з `@fontsource-variable`.
- **Жодних сторонніх запитів:** шрифти локальні (`@fontsource-variable`), аналітики й cookies немає.
  Це перевіряє тест.
- Діагностика для тестів і ручної перевірки: `window.__lioraScene.stats()` у консолі.

## Як ми працюємо

- Процес (гілки `type/<issue>-slug`, Conventional Commits, PR, squash-merge) —
  [devops/CONTRIBUTING.md](https://github.com/liora-app/devops/blob/main/CONTRIBUTING.md).
- Задачі — Issues цього репо + дошка організації «Liora».
- CI — спільний: [`devops/.github/workflows/reusable-checks.yml`](https://github.com/liora-app/devops/blob/main/.github/workflows/reusable-checks.yml).
  E2E у CI не запускаються (хвилини Actions) — проганяй `npm run test:e2e` локально перед PR.
- **Деплой:** merge у `main` → `deploy-dispatch.yml` → деплой у [devops](https://github.com/liora-app/devops) ([ADR-004](https://github.com/liora-app/devops/blob/main/docs/adr/ADR-004-deploy-via-devops-dispatch.md)). Спить, поки `DEPLOY_ENABLED` ≠ `true`;
  віддачу `dist/` через Caddy ще не підключено (ADR-006).
