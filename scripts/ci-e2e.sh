#!/usr/bin/env bash
# E2E in CI (called by liora-app/devops reusable-checks.yml with `e2e-tests: true`).
# Runners have no GPU: the tests that need a WebGL2 context are tagged @gpu and run locally only.
# The chat's @stack tests need the local compose stack (ADR-007) and never run here; each of them also
# skips itself without E2E_STACK=1. Chromium only — WebKit adds minutes, not coverage, without a GPU.
set -euo pipefail

npm ci --no-audit --no-fund
npx playwright install --with-deps chromium
npx playwright test --project=desktop --project=mobile --grep-invert "@gpu|@stack" --reporter=line
