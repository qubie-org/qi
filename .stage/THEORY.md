# The stored-program agent {#theory}

A theory of agent memory, and the system it implies. It stands on its own — no
existing model, stack, or codebase is assumed. Numbers cited were measured in
`.stage/`; assumptions are marked as assumptions.

## the claim {#theory-claim}

> **An agent's memory is a stored-program machine whose instructions are
> content-addressed. The log is source, the slots are the compiled program,
> retrieval is instruction fetch, and a memory's meaning is its measured effect
> on execution.**

Five consequences.

**1. Retrieval is not a bolt-on.** In a von Neumann machine the program counter
names the next instruction by index. Here the current state names it by
similarity. Instruction fetch *is* retrieval. Retrieval-augmentation feels
grafted-on because it fetches documents to *read*; this fetches instructions to
*execute*.

**2. Meaning is operational, not denotational.** A memory that changes no
prediction and no action does not exist. So

    effect(m) = D( P(·| state with m), P(·| state without m) )

is the definition, and it is *measurable*. This is the load-bearing move: it
removes fact extraction from the critical path. We never need to know what a
memory *means*, only what it *does*.

**3. The vector's job is addressing, not meaning.** Meaning is what the machine
does with the fetched value. The representation only has to make the right slot
fire for the right state — a crisp, testable target, where "does this vector
capture meaning" never was.

**4. Turing completeness needs the loop, not just the memory.** Unbounded
storage is not unbounded time. Fixed-depth feedforward computation is roughly
constant-depth circuit complexity. **Memory gives the tape; recurrence gives the
time.** Both are required, so the loop is primary, not an optimisation.

**5. The log is source; the slots are the binary.** Inference reads only
weights. The log is a *build input*, never a query-time dependency.

## the central separation {#theory-split}

> **Parameters do computation. Slots do storage.**

This is the design, and everything else follows from taking it seriously.

A conventional model stores what it knows *in its weights*, which is why it must
be large, why it cannot learn without retraining, and why nothing it knows is
addressable. Move storage into slots and the machine gets small — not because it
is compressed, but because **it no longer has to know anything.**

What the machine must learn is therefore small and specific:

1. encode state into a query (**addressing**)
2. apply a fetched value to state (**execution**)
3. decide to loop or halt (**control**)
4. place a new memory into a slot (**writing**)

That is closer to learning an instruction set than to learning a world. The
floor on size comes from fluent output — a speaking agent needs enough capacity
to *say* things — not from needing to *know* things.

## the architecture {#theory-arch}

```
L0  LOG        append-only mmap'd file — raw artifacts + fixed-stride index
L1  ENCODERS   per-modality, → keys                          [frozen, practical]
L2  MACHINE    looped, memory-native, write-native — trained from scratch
L3  SLOTS      sparse content-addressed KV, product-key O(√N)
L4  INSTRUMENT AABS: attribute / ablate / bisect / probe / refactor
L5  VIEW       the inspection surface. Last, not first.
```

### L0 — the log

Append bytes, get a stable id; id returns bytes; never mutate; time-ordered;
fast sequential scan. **That is a file, not a database.** Five functions, ~300
lines of C, `mmap` so the file *is* the array and record `i` sits at `i*stride`
— no index structure, lookup is multiplication.

Everything above it is derived and disposable. That property is what makes every
mistake above it recoverable.

### L1 — encoders

Frozen per-modality encoders produce keys. This is how text, code, image, video
and audio enter one memory: several key encoders, one slot space.

**This is a practical concession, not a theoretical commitment.** Training
multimodal encoders from scratch is enormous and buys nothing the theory needs.
If better encoders appear, swap them; nothing above depends on which.

### L2/L3 — the machine and its memory, designed together

Looped, so it has time. Memory-native, so it has storage. **Write-native, so it
can learn without retraining.**

The last one is the crux and it is why this must be built from scratch rather
than assembled. If reading and writing are trained *jointly*, the machine learns
to write in a form it can read. Bolt a writer onto a trained model and there is
no reason its writes should mean anything to it.

### L4 — the instrument (AABS)

**Ablation-addressable belief store.** Every belief is *derived* from an
immutable record, *individually addressable*, *causally attributable* by
measured effect, and *removable*. Drop any clause and the rest stop working.

```
append(record)          the only write
derive(state)           records → slots
attribute(output)       which slots fired      O(k), free from sparse access
ablate(memory)          zero it, measure delta
bisect(bad_behavior)    binary search over log prefixes
diff(state_a, state_b)  behavioural delta
refactor(memories)      merge IFF equal measured effect
```

`refactor` is the one to notice: consolidation with an *acceptance test* rather
than a similarity heuristic.

Probes come from the machine's own history — real past queries, real past
inputs. Unsupervised, grounded, continuously growing. **This is also the soft
spot:** a memory that matters only for a question never asked reads as dead
code.

Name it **version control for beliefs, not an IDE.** The VCS frame names the
base of the dependency chain; "IDE" puts the last deliverable first.

## localisation {#theory-local}

Two numbers: support size `|S(m)|` (slots per memory) and polysemanticity
(memories per slot).

- **Attribution needs monosemanticity** — a slot means one thing.
- **Deletion needs private slots OR replay.** No third option.
- **Private slots destroy generalisation** — sharing *is* generalisation; fully
  private memory is a lookup table with extra steps.

So: design for monosemanticity, never privacy. Deletion becomes tombstone +
re-derive at compaction. **Instant deletion was never a requirement**, and
demanding it is what would force private slots and cost the generalisation.

`bisect` works even fully distributed, since it ablates *records* by replay. The
fast path needs localisation; the correct path never does.

## realtime vs background {#theory-timing}

| realtime (per turn, ms) | background (compaction) |
|---|---|
| encode → fetch → execute → emit | write new slots |
| attribute (free with fetch) | re-derive after deletions |
| | run probe suite, catch regressions |
| | refactor / merge / coarsen / tier |

The expensive layer is never on the interaction path.

## honest lineage {#theory-lineage}

Two research lines, each with the half the other lacks:

**NTM / DNC** (Graves et al.) trained read *and* write jointly — exactly what is
needed — and died on **dense addressing**: soft attention over all memory, O(N)
per step, unstable to train.

**Product-key memory** (Lample 2019) and **memory layers at scale** (Berges
2024) solved addressing — sparse, O(√N), trains at scale — but have **no
inference-time write.** Slot values are learned by gradient during pretraining.

> **This design is DNC's write with product-key's addressing.** The thing that
> killed DNC is solved; the thing that made it interesting is the thing needed.

Also drawn on: surprise-gated test-time memory (Titans), activation patching and
circuit tracing (the ablation and blame machinery), online dictionary learning
(Mairal 2009).

## what is proven {#theory-proven}

Measured in `.stage/`, 2026-08-05, on 20k text embeddings and 494 documents:

| | |
|---|---|
| intrinsic dim of text embeddings | **10.06** (ambient 384) |
| anisotropy (random-pair cosine) | **0.5815**; 0.0001 whitened |
| superposition capacity, real embeddings | **2** raw, **6** whitened, **32+** orthogonal |
| multi-view addressing, cost-matched | **+20.2** pts; 90.2% cross-file |
| set semantics over term-frequency bundling | **+22.7** |
| IDF masking / many-vectors-per-node | **both rejected** |
| cost of discretising to symbols | **~23% of structure lost** |
| dictionary size bound | **atoms ≲ N** |

The last two matter most here: **discretisation is expensive, and this design
never does it.** Operational semantics keeps everything in the vector space,
which is why the symbol layer — and its 23% toll — is absent from the
architecture above.

## two claims, not one {#theory-two-claims}

These are separate and only the first is settled. Conflating them is the easiest
way to oversell this whole design.

| | status |
|---|---|
| **A. Slots scale capacity** — storage split from computation | **proven** (memory layers at scale, Berges 2024) |
| **B. Slots enable runtime learning** — write a slot, use it immediately | **the bet** |

Memory layers learn slot values *by gradient during pretraining*; they have no
inference-time write. NTM/DNC pursued B for a decade and largely failed to
scale. B does not inherit A's credibility.

### the spectrum B actually lives on {#theory-spectrum}

| | gives | proven |
|---|---|---|
| kNN-LM interpolation (Khandelwal 2019) | memorise a fact, instantly | **yes** |
| fast weights / Hebbian outer product | associative recall, instantly | yes (fixed capacity) |
| **slot write used mid-network** | *reason with* the new memory | **no — the bet** |
| gradient / fine-tune | full integration | yes, but batch and forgets |

**Memorisation is cheap and solved. Integration needs gradient.** kNN-LM is the
existence proof for the bottom rung: add an entry, it changes behaviour
immediately, no training, and it measurably memorises what the model never saw.

## the design that follows {#theory-two-speed}

Do not bet everything on the hardest rung. Run two speeds:

```
fast   slot write / kNN-style      immediate, memorisation-grade
slow   periodic gradient           background, integration-grade
```

That is **complementary learning systems** (McClelland et al. 1995) —
hippocampal fast encoding, cortical slow consolidation — and it is the same
two-tier shape as the compaction sweep already specified. Consolidation runs
regardless; make it the integration path.

Most of what an agent accumulates sits on the cheap rung. *"The deploy failed
Tuesday"* is memorisation. *"He prefers terse answers"* is memorisation plus
weighting. Only *"here is a new procedure"* needs real integration. So the
proven rung carries most of the product and the bet gates only the ambitious
part.

## the bet {#theory-bet}

**Does joint read/write training produce writes the machine can use *mid-network*
at inference, without retraining?**

Yes → the machine reasons with what it just learned. No → it still remembers via
the cheap rung, and integration stays on the background gradient path. **The
theory survives either way** — only the ambition changes.

Designing for it from the start makes the bet better, not merely different: the
failure mode people hit is bolting a writer onto a model that never learned to
read its own writes. This is the smallest thing worth building, and it should be
built **before** L0–L5.

Secondary unknowns: monosemanticity at small scale; slot capacity versus recall;
whether appending slots degrades gracefully or eventually demands a refit.

## what is genuinely novel {#theory-novel}

1. **Operational semantics as the basis of a memory system.** Effect instead of
   extraction — this dodges the hardest problem in the field rather than solving
   it.
2. **Interpretability as a product surface.** Ablation and blame pointed at an
   agent's accumulated experience rather than at a model under study.
3. **The compile model** — log as source, slots as binary, derive as build,
   making every index disposable and every mistake recoverable.

## what this is not {#theory-not}

- **Not a truth system.** It says what is believed and why, never whether that
  is correct. Correctness comes only from contact with the world — a validation
  signal is trustworthy exactly when it asserts state the machine cannot fake,
  and worthless when it merely counts the machine's own output.
- **Not a fix for the machine.** Beliefs become accountable, not better.
- **Not storage-free.** There is a store. It is a build input, not a query-time
  dependency. Say that precisely rather than denying it.
