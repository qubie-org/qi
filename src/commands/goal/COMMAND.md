---
id: goal
name: goal
needs: what should be achieved?
gives: work, until a second opinion says it is done
tone: 3
controls: ⏹ stop stop after this round
---

Keeps working until something else agrees it is finished.

A turn in the river answers once. This runs the same agent repeatedly, and
between rounds a second call — same weights, its own system prompt, none of the
working context — reads the goal and the latest result and decides whether it is
enough. If it is not, what it says is missing becomes part of the next round's
instructions.

The separation is the whole design. A model asked whether its own answer was
good enough is not evaluating the answer, it is continuing it: it has just spent
its context arguing for what it produced. The judge sees the goal and the work
and nothing else — not the reasoning, not the tool calls, not what the last
round intended to do next.

It stops when the judge says so, when six rounds have passed, or when you press
stop. The middle case is reported as what it is — six rounds and not finished —
rather than dressed up as success, because a goal that quietly gave up and
claimed completion is worse than one that says it ran out of road.

Stopping takes effect at the end of the current round. Killing a round halfway
through leaves the work unwritten and the tool calls already done.
