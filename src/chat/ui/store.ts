// dispatch → reduce → render → effects (spec §9.1 store.ts). Actions dispatched while one is being
// handled (an effect that answers at once) wait their turn, so render always sees a settled model.

import { INITIAL_MODEL, leaveGuard, reduce, type Action, type Effect, type Model } from '../core/state'

export type StoreDeps = Readonly<{
  render(model: Model, prev: Model | null): void
  run(effect: Effect): void
  guard(wanted: boolean): void
}>

export type Store = Readonly<{
  dispatch(action: Action): void
  model(): Model
  /** First paint of the initial model, before the first action. */
  start(): void
}>

export function createStore(deps: () => StoreDeps): Store {
  let model: Model = INITIAL_MODEL
  const queue: Action[] = []
  let busy = false

  const dispatch = (action: Action): void => {
    queue.push(action)
    if (busy) return
    busy = true
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const prev = model
        const [after, effects] = reduce(model, next)
        model = after
        const d = deps()
        if (after !== prev) d.render(after, prev)
        d.guard(leaveGuard(after.state))
        for (const effect of effects) d.run(effect)
      }
    } finally {
      busy = false
      queue.length = 0
    }
  }

  return {
    dispatch,
    model: () => model,
    start: () => deps().render(model, null),
  }
}
