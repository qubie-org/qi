/* bench.h — content-selection benchmark. PURE: no I/O.
 *
 * The question TinyOS S0 left open: can an HDC content vector rank the
 * document a query came from? There it scored 6% top-5 at 948 candidates,
 * because the vectors encoded title+path and never the body.
 *
 * Self-supervised, so it needs no labels and no mined sessions: hold ONE
 * paragraph out of each document, build that document's vector from the
 * remainder, then ask whether the held-out paragraph retrieves its own
 * document out of the whole corpus. Document vectors are built BEFORE the
 * IDF mask is computed, so no query text contributes to the mask it is
 * scored against.
 *
 * Two conditions, keeping TinyOS's point that both obvious framings lie:
 *   raw     the paragraph as written — often contains words from its own
 *           path, so this partly measures matching a name against a name
 *   nopath  every token appearing in the document's path removed. The honest
 *           one, and the condition S0 collapsed on.
 */
#ifndef BENCH_H
#define BENCH_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
	char *path;
	char *text;
} doc_t;

typedef struct {
	char *path;
	char *query;
	char *body;
} trial_t;

typedef struct {
	const char *method;
	const char *cond;
	double top1;
	double top5;
	double mrr;
} row_t;

/* Lowercase [a-z0-9]+ tokens -> FNV seeds. Returns count written. */
size_t bench_tokenize(const char *text, uint32_t *out, size_t cap);

/* Sort + unique in place. Returns new length. */
size_t bench_dedup(uint32_t *a, size_t n);

/* Split each doc into (longest paragraph, remainder). Docs with fewer than 3
 * paragraphs or a short longest paragraph are skipped. Returns trial count. */
size_t bench_build_trials(const doc_t *docs, size_t ndocs, trial_t *out,
                          size_t min_words);

/* Runs 2 encoders x 2 conditions x {plain, masked} = 8 rows.
 * qwords > 0 truncates every query to that many words. */
size_t bench_run(const trial_t *trials, size_t n, size_t keep, size_t qwords,
                 row_t *rows, size_t rowcap);

/* MANY VECTORS PER NODE — S0's option 2, untested there.
 * One vector per paragraph instead of one per document; a document scores as
 * the max over its paragraphs. A short query cannot match a 400-word bag but
 * can match a 30-word paragraph, so this is the intervention aimed squarely at
 * the short-query regime where set-semantics stops helping.
 * Returns rows for 2 encoders x 2 conditions. */
size_t bench_run_multi(const trial_t *trials, size_t n, size_t qwords,
                       size_t pool, row_t *rows, size_t rowcap);

/* SAME algorithm, SAME whole-word tokenization, learned atoms instead of
 * random ones. The one comparison that says whether HDC's semantic blindness
 * is the real ceiling. `coverage` returns the fraction of body tokens found in
 * potion's vocabulary — the handicap of not running its WordPiece tokenizer. */
size_t bench_run_potion(const void *potion, const trial_t *trials, size_t n,
                        size_t qwords, row_t *rows, size_t rowcap,
                        double *coverage);

void bench_free_trials(trial_t *t, size_t n);

#endif /* BENCH_H */
