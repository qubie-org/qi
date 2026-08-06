/**
 * Telemetry, as OpenTelemetry, for everything the model and the agent do.
 *
 * There were two reasons to reach for a standard here rather than a bespoke
 * log, and only one of them is the obvious one.
 *
 * The obvious one: OTLP means any collector works. Point
 * `OTEL_EXPORTER_OTLP_ENDPOINT` at Jaeger, Grafana, Honeycomb, or nothing at
 * all, and the same spans arrive. Nothing in qi has to know which.
 *
 * The one that actually decided it: **a trace is the training corpus.** A span
 * for a turn, with child spans for every model call and every tool the agent
 * chose, carrying token counts and durations and outcomes — that is exactly the
 * record an adapter would need to learn how this person uses this qi. So the
 * observability format and the corpus format are the same thing, and there is
 * no second pipeline to keep honest. Training itself is a later problem; the
 * data it will want is being written correctly from today.
 *
 * The attribute names are the GenAI semantic conventions. They are pinned as
 * string constants below rather than imported: @opentelemetry/semantic-conventions
 * at 1.43 does not export the gen_ai.* group yet, and inventing our own names
 * would give up the only thing the standard is for.
 *
 * One rule, everywhere: telemetry never breaks a turn. Every helper here
 * swallows its own failures. A span that cannot be recorded is worth strictly
 * less than the reply it was recording.
 */
import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

/**
 * GenAI semantic conventions.
 *
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/ — these are the names a
 * collector, a dashboard and every other tool in this ecosystem already
 * understand. Anything qi-specific gets a `qi.` prefix so the two are never
 * confused.
 */
export const GEN_AI = {
  SYSTEM: 'gen_ai.system',
  OPERATION: 'gen_ai.operation.name',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  REQUEST_TOP_P: 'gen_ai.request.top_p',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  AGENT_NAME: 'gen_ai.agent.name',
} as const

/** Ours. Anything the conventions have no word for. */
export const QI = {
  /** The pack a span belongs to, when it is not the core. */
  PACK: 'qi.pack',
  /** The adapter applied to this request, if any. */
  ADAPTER: 'qi.adapter',
  /** How deep into the agent loop this step was. */
  DEPTH: 'qi.depth',
  /** Whether a tool found anything. Empty results are the useful negatives. */
  EMPTY: 'qi.empty',
  /** Cache hits and misses on the vector path. */
  CACHE_HITS: 'qi.cache.hits',
  CACHE_MISSES: 'qi.cache.misses',
  /** What became of a reply: kept, edited, abandoned, retried, unsupported. */
  SIGNAL: 'qi.signal',
}

export type Operation =
  | 'chat'
  | 'text_completion'
  | 'embeddings'
  | 'execute_tool'
  | 'invoke_agent'
  | 'install_pack'

const NAME = 'qi'
let tracer = trace.getTracer(NAME)
let started = false

/**
 * One id for the whole conversation, so a session's spans join up.
 *
 * Random per page load rather than persisted: a conversation is what happened
 * in one sitting, and stitching two of them together because they share a
 * machine would be a claim nobody made.
 */
export const conversationId = crypto.randomUUID()

export function startTelemetry(endpoint = '/otel/v1/traces'): void {
  if (started) return
  try {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        'service.name': NAME,
        'service.version': '0',
        // Which brain answered matters more than which build did, so it is on
        // the resource rather than repeated on every span.
        'gen_ai.system': 'granite',
      }),
      spanProcessors: [
        // Batched: a turn makes several spans and a reply should never wait on
        // a POST. The queue is dropped on unload rather than blocking it.
        new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }), {
          maxQueueSize: 512,
          scheduledDelayMillis: 2000,
        }),
      ],
    })
    provider.register()
    tracer = provider.getTracer(NAME)
    started = true
  } catch (err) {
    console.warn('telemetry: not started —', err)
  }
}

/**
 * Run `fn` inside a span, and record what happened to it.
 *
 * The span name follows the convention `{operation} {target}` — "chat
 * granite-4.1-3b", "execute_tool look" — because that is what every GenAI-aware
 * UI groups by.
 */
export async function observe<T>(
  operation: Operation,
  target: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!started) return fn(noopSpan)
  const span = tracer.startSpan(`${operation} ${target}`.trim(), {
    attributes: {
      [GEN_AI.OPERATION]: operation,
      [GEN_AI.CONVERSATION_ID]: conversationId,
      ...attributes,
    },
  })
  try {
    const out = await context.with(trace.setSpan(context.active(), span), () => fn(span))
    span.setStatus({ code: SpanStatusCode.OK })
    return out
  } catch (err) {
    // Recorded, then rethrown: an error worth tracing is still an error the
    // caller has to deal with.
    span.recordException(err as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
    span.setAttribute('error.type', (err as Error)?.name ?? 'Error')
    throw err
  } finally {
    span.end()
  }
}

/**
 * Attach a fact to the turn currently in flight.
 *
 * Used for the outcome signals, which arrive long after the span that produced
 * the reply has closed — so they are events on whatever is active, not on the
 * original. What matters is that they share a conversation id.
 */
export function note(name: string, attributes: Attributes = {}): void {
  if (!started) return
  try {
    const span = tracer.startSpan(name, {
      attributes: { [GEN_AI.CONVERSATION_ID]: conversationId, ...attributes },
    })
    span.end()
  } catch {
    /* never at the cost of the thing being noted */
  }
}

/** A span that does nothing, for when telemetry is off. */
const noopSpan = {
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  setStatus: () => noopSpan,
  recordException: () => {},
  end: () => {},
  isRecording: () => false,
} as unknown as Span
