/**
 * Types for Strudel, which ships none.
 *
 * Only the surface qi actually calls is declared, and it is declared
 * honestly: `superdough` takes a bag of synth parameters whose keys are open
 * (superdough reads dozens, and which ones apply depends on the voice), so the
 * value is `Record<string, unknown>` rather than a fiction of an exact shape
 * that would go stale the first time the library adds a parameter.
 *
 * Declaring a narrow interface for a library you do not control is a trap: it
 * type-checks against your idea of the library rather than the library. This
 * is deliberately the thin version — enough that call sites are checked for
 * arity and obvious mistakes, and no more.
 */

declare module 'superdough' {
  /**
   * Play one voice.
   *
   * @param value  synth parameters — `s`, `freq`/`note`, `gain`, envelope, filters
   * @param deadline  AudioContext time to start at, in seconds
   * @param duration  seconds the voice is held
   */
  export function superdough(
    value: Record<string, unknown>,
    deadline: number,
    duration: number,
  ): Promise<void> | void

  export function registerSynthSounds(): void
  export function registerWorklet(url: string): void
  export function initAudio(options?: Record<string, unknown>): Promise<void>
  export function getAudioContext(): AudioContext

  /**
   * Every sound name Strudel will answer to, right now.
   *
   * A store, not a constant, and the distinction is the whole reason a
   * generated pattern has to be checked late: synths register eagerly, sample
   * banks only once their network fetch lands. Read at startup it holds 19
   * names and no drums at all.
   */
  export const soundMap: { get(): Record<string, unknown> }

  /**
   * The output graph superdough is really playing into.
   *
   * Declared for one reason: measuring. An analyser on the final gain reads the
   * mix the speakers get, which is the only way to tell "the set is playing"
   * apart from "the set thinks it is playing" — and those two diverged for most
   * of a day.
   *
   * `output` is a wrapper, not a node, and this was first declared as
   * `AudioNode` because that is what the name suggests. It type-checked and
   * `output.connect` threw at runtime. That is this file's own warning landing
   * on the person who wrote it: a narrow interface for a library you do not
   * control checks against your idea of the library. The shape below was read
   * off the running object.
   *
   * The controller has more on it (`duck`, `getOrbit`, `getBus`) and so does
   * the output (`channelMerger`, `connectToDestination`); per the note above,
   * what qi calls is what gets declared.
   */
  export function getSuperdoughAudioController(): {
    audioContext: AudioContext
    output: { destinationGain: GainNode; audioContext: AudioContext }
    reset(): void
  }
}

declare module '@strudel/webaudio' {
  export function initAudio(options?: Record<string, unknown>): Promise<void>
  export function getAudioContext(): AudioContext
  export const webaudioOutput: unknown
  export function webaudioRepl(options?: Record<string, unknown>): {
    scheduler: {
      setPattern(pattern: unknown, autostart?: boolean): void
      start(): void
      stop(): void
    }
    evaluate(code: string): Promise<unknown>
  }
  export function samples(...args: unknown[]): Promise<void>
}

declare module '@strudel/core' {
  /** A Strudel pattern. Opaque here — qi builds them and hands them back. */
  export interface Pattern {
    [method: string]: any
  }
  export function note(value: unknown): Pattern
  export function sound(value: unknown): Pattern
  export function s(value: unknown): Pattern
  export function stack(...patterns: unknown[]): Pattern
  export function sequence(...values: unknown[]): Pattern
  export const silence: Pattern
  /** Continuous signals, for slow modulation. `.range(lo, hi)` scales them. */
  export const sine: Pattern
  export const saw: Pattern
  export const tri: Pattern
  export const perlin: Pattern
  export function pure(value: unknown): Pattern
  export function noteToMidi(note: string): number
  export function midi2note(midi: number): string
  /** Registers a parser for bare strings — mini-notation, in practice. */
  export function setStringParser(parser: unknown): void
  export function repl(options: Record<string, unknown>): {
    scheduler: {
      setPattern(pattern: unknown, autostart?: boolean): void
      start(): void
      stop(): void
    }
  }
}

declare module '@strudel/mini' {
  export function mini(...strings: string[]): import('@strudel/core').Pattern
}
