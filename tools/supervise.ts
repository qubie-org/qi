import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Children that outlive the thing that spawned them.
 *
 * Four `lightpanda fetch` processes were found with PPID 1, nineteen hours old,
 * 384 CPU-minutes each, holding four cores and starving the audio scheduler.
 * Their parent was long dead. Each had been given an eighteen-second deadline
 * and each had sailed past it, because the deadline lived in the parent: a
 * `setTimeout` that calls `child.kill()` protects nothing once the process
 * holding the timer is gone.
 *
 * That is the general shape of the bug and it is not specific to lightpanda.
 * Anything spawned per-request inherits it — the renderer today, a model server
 * or an analysis pass tomorrow. So the answer is a place that owns spawning
 * rather than a fix at one call site.
 *
 * ── What actually kills a child on macOS ────────────────────────────────────
 *
 * Not much, automatically. Linux has `PR_SET_PDEATHSIG`, which asks the kernel
 * to signal a child when its parent dies; macOS has no equivalent, and a child
 * whose parent is SIGKILLed is simply reparented to launchd and left running.
 * There is no flag that prevents this.
 *
 * So three things, none of which is sufficient alone:
 *
 *   1  a deadline in the parent, which covers the ordinary case
 *   2  killing every tracked child on the way out, which covers a clean exit
 *      and every signal that can be caught
 *   3  reaping orphans at startup, which is the only thing that covers the
 *      parent being killed outright — and is what would have caught these four
 *
 * The third is the one people leave out, and it is the one that matters, since
 * the case it handles is the case where the other two have already failed.
 */

/** Everything spawned through here and not yet exited. */
const live = new Set<ChildProcess>()

/** Processes we are allowed to reap by name. Anything not ours stays. */
const OURS = ['lightpanda']

export type Supervised = {
  child: ChildProcess
  /** Resolves when it exits, whatever the reason. */
  done: Promise<{ code: number | null; timedOut: boolean }>
}

/**
 * Spawn something, with a deadline that is enforced rather than hoped for.
 *
 * The child is killed with SIGKILL rather than SIGTERM at the deadline. A
 * process that has ignored its own timeout has already demonstrated it is not
 * responding to reason, and the polite signal is one more thing to wait for.
 */
export function supervise(
  file: string,
  args: string[],
  deadlineMs: number,
  options: SpawnOptions = {},
): Supervised {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  live.add(child)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, deadlineMs)

  const done = new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const finish = (code: number | null) => {
      clearTimeout(timer)
      live.delete(child)
      resolve({ code, timedOut })
    }
    child.once('exit', finish)
    child.once('error', () => finish(null))
  })

  return { child, done }
}

/** Kill everything still running. Called on the way out, by every route out. */
export function killAll(): void {
  for (const child of live) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  live.clear()
}

let hooked = false

/**
 * Install the exit handlers, once.
 *
 * `exit` alone is not enough — it does not fire for a signal — and the signal
 * handlers alone are not enough either, because a clean shutdown does not
 * signal. Both, and neither covers SIGKILL, which is what `reapOrphans` is for.
 */
export function hookExit(): void {
  if (hooked) return
  hooked = true
  process.once('exit', killAll)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      killAll()
      process.exit(0)
    })
  }
  process.once('uncaughtException', (err) => {
    console.error('supervise: uncaught —', err)
    killAll()
    process.exit(1)
  })
}

/**
 * Kill children of a previous run that are still going.
 *
 * Only processes we spawn, only ones already orphaned to PID 1, and only ones
 * older than the grace period — so a sibling dev server's healthy child is
 * never touched. Orphaned *and* long-running is a narrow enough signature to
 * act on without asking.
 *
 * The elapsed check is what keeps this safe. A child that is orphaned but three
 * seconds old might belong to something starting up; one that is orphaned and
 * has been running for minutes belongs to nothing.
 */
export async function reapOrphans(olderThanSeconds = 120): Promise<number> {
  let killed = 0
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,etime=,comm='])
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      if (!m) continue
      const [, pid, ppid, etime, comm] = m
      if (ppid !== '1') continue
      if (!OURS.some((name) => comm.includes(name))) continue
      if (elapsed(etime) < olderThanSeconds) continue
      try {
        process.kill(Number(pid), 'SIGKILL')
        killed++
        console.warn(`supervise: reaped orphan ${comm.trim()} (pid ${pid}, up ${etime})`)
      } catch {
        /* gone between listing and killing, which is fine */
      }
    }
  } catch {
    // `ps` is not available, or refused. Reaping is a courtesy; failing to do
    // it must never stop the server starting.
  }
  return killed
}

/** `ps` elapsed time — `MM:SS`, `HH:MM:SS`, or `D-HH:MM:SS` — as seconds. */
function elapsed(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = clock.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
}
