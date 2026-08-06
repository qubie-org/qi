/* potion.h — model2vec static embedding table. PURE: takes buffers, never
 * opens a file. main.c does the reading.
 *
 * Why this is the decisive comparison: model2vec is THE SAME ALGORITHM as
 * TinyOS's `tvec` — bag of words, pooled, no forward pass. A token's vector is
 * a row lookup. The only difference is the ATOM:
 *
 *   tvec    atom = expand(fnv1a(word))  — random, orthogonal to every other
 *   potion  atom = a learned row        — near its synonyms
 *
 * So this isolates exactly what learned atoms buy. HDC can only match tokens
 * EXACTLY; `database` and `sqlite` are as unrelated to it as `database` and
 * `banana`. If that blindness is the real ceiling, it shows up here.
 *
 * Both sides are given the SAME whole-word tokenization, so the comparison is
 * about the atom and nothing else. That mildly handicaps potion — its own
 * WordPiece tokenizer would recover OOV words through subword pieces — so
 * coverage is reported alongside the result.
 */
#ifndef POTION_H
#define POTION_H

#include <stddef.h>
#include <stdint.h>

typedef struct potion potion_t;

/* bin: contents of potion.bin. vocab_json: contents of potion.vocab.json.
 * Neither buffer is retained. Returns NULL on bad magic or a vocab mismatch. */
potion_t *potion_load(const uint8_t *bin, size_t binlen,
                      const char *vocab_json, size_t vlen);

void potion_free(potion_t *p);

int potion_dim(const potion_t *p);

/* Row index for a whole word, or -1 if absent. */
int potion_lookup(const potion_t *p, const char *word, size_t len);

/* Mean-pool the rows of every whole word found in `text`, L2-normalised.
 * `hits`/`total` report vocabulary coverage. Returns 0 if nothing was found. */
int potion_encode(const potion_t *p, const char *text, float *out,
                  size_t *hits, size_t *total);

/* Rows are L2-normalised, so cosine collapses to a dot. */
float potion_dot(const float *a, const float *b, int dim);

#endif /* POTION_H */
