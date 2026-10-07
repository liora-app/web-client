// The few Node built-ins chat-core.spec.ts calls for its source checks (spec §10.5). The repo has
// no @types/node and takes no new dependencies, so only these signatures are declared.

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
  /** Node ≥ 20: paths relative to `path`, with the platform separator. */
  export function readdirSync(path: string, options: { recursive: true; encoding: 'utf8' }): string[]
  export function statSync(path: string): { isFile(): boolean }
}

declare module 'node:path' {
  export function resolve(...parts: string[]): string
  export function join(...parts: string[]): string
}
