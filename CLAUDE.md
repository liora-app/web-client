# liora-app / web-client — правила для AI-асистентів

Web frontend. Частина організації `liora-app` (ADR-003).

- **Спільні правила, рішення й процес — у репо `devops`**: `CLAUDE.md`, `CONTRIBUTING.md`,
  `docs/adr/`. Прочитай їх перед пропозиціями; ADR пишемо там.
- Стек не обраний: не вводь мову, фреймворк чи залежність без ADR у `devops/docs/adr`.
- Гілки `<type>/<issue>-<slug>`, Conventional Commits англійською, squash-merge, без комітів у `main`.
- CI-логіку тут не міняй — вона в `devops/.github/workflows/reusable-*.yml`.
- Хвилини Actions обмежені (Free): не додавай jobs і тригерів без потреби.
- Жодних реальних діалогів, імен чи контактів користувачів — тільки синтетичні дані. Секрети — тільки в `.env`.
