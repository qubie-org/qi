/**
 * A way to hear what is actually coming out.
 *
 * Not app code — nothing imports this. It exists so an `/eval` against the
 * running app can reach the app's *own* superdough instance and put an analyser
 * on the real output node.
 *
 * The reason that matters is the bug it was written for. A set can be
 * scheduling correctly, reporting itself as playing, and producing silence:
 * patterns evaluate, the transport advances, every log line is what you want,
 * and the graph is either not connected or connected downstream of a gain that
 * is zero. Nothing in the code path knows. Measuring peak RMS at the output is
 * the only check that distinguishes playing from believing it is playing, and
 * it is how stop was confirmed too — 0.174 with the set running, 0.009 after.
 *
 * Importing `superdough` from an eval would not do: a second import gives a
 * second module instance with its own controller and its own silent output.
 * It has to be the one the app is holding.
 */
export { getAudioContext, getSuperdoughAudioController, superdough } from 'superdough'
