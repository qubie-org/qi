/**
 * The banner, as a turn actually happens.
 *
 * Not three screenshots at an angle. A screenshot of a text river is the one
 * thing that cannot show what a text river is: the whole idea is that the
 * answer arrives *in the line you typed into*, and a still frame shows a line
 * with text in it, which is what every app looks like. The behaviour is the
 * product, so the banner has to move.
 *
 * So this rebuilds the interface rather than photographing it — same paper,
 * same measure, same display serif, same keycap — and plays one turn through:
 * the picker on `/`, the question committing to the right, the answer arriving
 * in serif on the left, a source landing under it. Everything is driven by
 * `useCurrentFrame`, so it renders deterministically and loops.
 */
import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'

const PAPER = '#ffffff'
const INK = '#0d0d0f'
const SOFT = '#84848d'
const HINT = '#a8a8b0'
const RULE = 'rgba(13,13,15,0.11)'

const SERIF = "'Iowan Old Style','New York',Charter,Georgia,'Times New Roman',serif"
const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif"
const MONO = "'SF Mono',Menlo,Consolas,monospace"

/** The column, matching the app: centred, with room. */
const MEASURE = 1120

// ── the script ───────────────────────────────────────────────────────────────
// Beats in frames at 30fps. Written as a table because the timing is the
// design here, and reading it off scattered `interpolate` calls is how the
// timing stops being editable.
const B = {
  slashIn: 14, //   the `/` is typed, picker opens
  wordDone: 62, //  "research" finished being typed
  commit: 74, //    return pressed
  askSettled: 92, //the question has taken its place on the right
  answerFrom: 104, //serif begins arriving
  answerTo: 250, // and finishes
  sourceIn: 244, // the source chip lands
  hold: 296,
  out: 320,
}

const TYPED = '/research'
const ASK = '/research  why paper feels warmer than glass'
const ANSWER =
  'Paper feels warmer because it draws heat from your skin far more slowly than glass does — both sit at room temperature, so what your hand reports is not temperature but the rate it is losing heat.'

/** Characters revealed by slicing, never by per-character opacity. */
const typed = (text: string, frame: number, from: number, to: number) => {
  const n = Math.round(interpolate(frame, [from, to], [0, text.length], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }))
  return text.slice(0, n)
}

/** The soft chromatic wash the app derives from a conversation. */
const Wash: React.FC = () => (
  <AbsoluteFill
    style={{
      background: [
        'radial-gradient(40% 42% at 6% 96%, rgba(184,205,242,0.42), transparent 68%)',
        'radial-gradient(38% 38% at 40% 112%, rgba(244,228,174,0.40), transparent 68%)',
        'radial-gradient(40% 40% at 84% 104%, rgba(240,201,194,0.34), transparent 68%)',
        'radial-gradient(46% 34% at 102% 8%, rgba(220,206,240,0.26), transparent 70%)',
      ].join(','),
    }}
  />
)

/** The divided keycap: new thread, and the thread list. */
const Keys: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      top: 46,
      left: 72,
      display: 'inline-flex',
      alignItems: 'stretch',
      border: `1px solid ${RULE}`,
      borderRadius: 10,
      background: 'rgba(255,255,255,0.72)',
      overflow: 'hidden',
    }}
  >
    <div style={{ padding: '9px 15px', display: 'grid', placeItems: 'center' }}>
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round">
        <path d="M8 3.4v9.2M3.4 8h9.2" />
      </svg>
    </div>
    <div style={{ padding: '9px 15px', display: 'grid', placeItems: 'center', borderLeft: `1px solid ${RULE}` }}>
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round">
        <path d="M3 4.6h10M3 8h7.4M3 11.4h4.6" />
      </svg>
    </div>
  </div>
)

/** `ready`, and the meter that shows the model is alive. */
const Status: React.FC<{ frame: number; busy: boolean }> = ({ frame, busy }) => {
  const bars = [0, 1, 2].map((i) => {
    const t = frame / 5 + i * 1.7
    const h = busy ? 5 + (Math.sin(t) * 0.5 + 0.5) * 11 : 6 + i * 3
    return h
  })
  return (
    <div
      style={{
        position: 'absolute',
        top: 50,
        right: 72,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: SANS,
        fontSize: 17,
        color: SOFT,
        letterSpacing: '0.01em',
      }}
    >
      <span>{busy ? 'thinking' : 'ready'}</span>
      <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2.5, height: 16 }}>
        {bars.map((h, i) => (
          <span key={i} style={{ width: 2.5, height: h, background: SOFT, borderRadius: 2 }} />
        ))}
      </span>
    </div>
  )
}

/** The `/` picker. Springs open, and is dismissed by committing. */
const Picker: React.FC<{ frame: number; fps: number; query: string }> = ({ frame, fps, query }) => {
  const open = spring({ frame: frame - B.slashIn, fps, config: { damping: 20, stiffness: 200 } })
  const close = spring({ frame: frame - B.commit, fps, config: { damping: 200 } })
  const shown = open * (1 - close)
  if (shown < 0.002) return null

  const all = [
    ['/research', 'what should I look into?'],
    ['/present', 'what should the deck be about?'],
    ['/goal', 'what should be achieved?'],
    ['/dj', 'what kind of set?'],
    ['/note', 'a place to write'],
  ]
  const q = query.replace(/^\//, '')
  const rows = all.filter(([name]) => name.slice(1).startsWith(q))

  return (
    <div
      style={{
        width: MEASURE,
        marginBottom: 18,
        border: `1px solid ${RULE}`,
        borderRadius: 12,
        background: 'rgba(255,255,255,0.94)',
        boxShadow: '0 18px 44px rgba(30,30,50,0.09), 0 2px 6px rgba(30,30,50,0.04)',
        overflow: 'hidden',
        opacity: shown,
        transform: `translateY(${(1 - shown) * 12}px)`,
        transformOrigin: 'bottom left',
      }}
    >
      {rows.map(([name, need], i) => (
        <div
          key={name}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 14,
            padding: '13px 20px',
            background: i === 0 ? 'rgba(13,13,15,0.045)' : 'transparent',
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 21, color: INK }}>{name}</span>
          <span style={{ fontFamily: SANS, fontSize: 18, color: HINT }}>{need}</span>
        </div>
      ))}
    </div>
  )
}

export const Banner: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const draft = typed(TYPED, frame, B.slashIn, B.wordDone)
  const committed = frame >= B.commit
  const busy = frame >= B.commit && frame < B.answerFrom + 6

  // The question rises into the thread rather than cutting there.
  const settle = spring({ frame: frame - B.commit, fps, config: { damping: 200 } })
  const answer = typed(ANSWER, frame, B.answerFrom, B.answerTo)

  const sourceIn = spring({ frame: frame - B.sourceIn, fps, config: { damping: 200 } })

  // One fade at the end so the loop closes on the empty river it opened on.
  const out = interpolate(frame, [B.hold, B.out], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <Wash />
      <Keys />
      <Status frame={frame} busy={busy} />

      <AbsoluteFill
        style={{
          padding: '150px 72px 108px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: MEASURE, opacity: out, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {/* what you asked, right-aligned, in the smaller sans */}
          {committed ? (
            <div
              style={{
                fontFamily: SANS,
                fontSize: 28,
                lineHeight: 1.45,
                color: SOFT,
                textAlign: 'right',
                marginBottom: 30,
                opacity: settle,
                transform: `translateY(${(1 - settle) * 26}px)`,
              }}
            >
              {ASK}
            </div>
          ) : null}

          {/* the answer, left-aligned, in the display serif */}
          {frame >= B.answerFrom ? (
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 54,
                lineHeight: 1.28,
                letterSpacing: '-0.012em',
                color: INK,
                textAlign: 'left',
              }}
            >
              {answer}
              {frame < B.answerTo ? (
                <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>{'▌'}</span>
              ) : null}
            </div>
          ) : null}

          {/* where it came from — the part the research process will not skip */}
          {sourceIn > 0.002 ? (
            <div
              style={{
                marginTop: 26,
                // `inline-flex` is not enough inside a flex column — the child
                // still stretches to the cross axis. `alignSelf` is the one
                // that stops the chip becoming a full-width bar.
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 14px',
                border: `1px solid ${RULE}`,
                borderRadius: 999,
                background: 'rgba(255,255,255,0.7)',
                fontFamily: SANS,
                fontSize: 16,
                color: SOFT,
                opacity: sourceIn,
                transform: `translateY(${(1 - sourceIn) * 8}px)`,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: '#7a9ad6' }} />
              thermal effusivity · verified quote
            </div>
          ) : null}
        </div>

        {/* the picker sits above the line it is completing */}
        <div style={{ width: MEASURE }}>
          <Picker frame={frame} fps={fps} query={draft} />
          <div
            style={{
              fontFamily: draft && !committed ? MONO : SANS,
              fontSize: 29,
              color: draft && !committed ? INK : HINT,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {committed ? 'say something' : draft || 'say something'}
            {!committed ? (
              <span style={{ opacity: frame % 16 < 8 ? 1 : 0, color: INK }}>{'▌'}</span>
            ) : null}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
