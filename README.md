# web-client — liora-app

> Web frontend.

Частина організації [`liora-app`](https://github.com/liora-app). Карта всіх репо, процес і рішення —
у [devops](https://github.com/liora-app/devops).

## Статус

Стек ще не обраний — коду немає. Вибір стеку — ADR у
[`devops/docs/adr`](https://github.com/liora-app/devops/tree/main/docs/adr).

## Як ми працюємо

- Процес (гілки `type/<issue>-slug`, Conventional Commits, PR, squash-merge) —
  [devops/CONTRIBUTING.md](https://github.com/liora-app/devops/blob/main/CONTRIBUTING.md).
- Задачі — Issues цього репо + дошка організації «Liora».
- CI — спільний: [`devops/.github/workflows/reusable-checks.yml`](https://github.com/liora-app/devops/blob/main/.github/workflows/reusable-checks.yml).
- **Деплой:** merge у `main` → `deploy-dispatch.yml` → деплой у [devops](https://github.com/liora-app/devops) ([ADR-004](https://github.com/liora-app/devops/blob/main/docs/adr/ADR-004-deploy-via-devops-dispatch.md)). Спить, поки `DEPLOY_ENABLED` ≠ `true`.

## Швидкий старт

```bash
gh repo clone liora-app/web-client
cd web-client
pre-commit install
pre-commit run --all-files
```
