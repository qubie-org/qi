/* hdc.h — hyperdimensional kernel. PURE: no I/O, no globals, no allocation.
 *
 * Rebuild of TinyOS code/kernel/hdc.k, plus the thing it lacked.
 *
 * TinyOS measured (tests/results/s0-hdc-selection.md) that its node vectors
 * ranked NAMES, not content, and that sending the file body made it worse.
 * It diagnosed "bundle saturation" and tried emphasis — acc/seal, which
 * remembers how often a bit was set. That is TERM FREQUENCY, and TF upweights
 * exactly the least informative words; S5 re-ran with it and went 71% -> 65%.
 *
 * The two interventions tested here go the other way:
 *   set semantics  each distinct term votes once   (remove TF entirely)
 *   idf mask       drop bits set the same way in every document
 *
 * The mask is the binary-HDC analog of whitening — removing the shared
 * common-mode component. Informativeness of a bit is Bernoulli entropy at its
 * corpus frequency: set in every document (or none) separates nothing; set in
 * half carries a full bit.
 *
 * Not bit-identical to the K original (standard xorshift32 vs its bit-vector
 * form), so absolute numbers are not comparable to TinyOS's. Every comparison
 * that matters is internal to this file.
 */
#ifndef HDC_H
#define HDC_H

#include <stdint.h>
#include <stddef.h>

#define HDC_D 16384                  /* bits per vector */
#define HDC_W (HDC_D / 64)           /* 256 uint64 words */

typedef uint64_t hdc_vec[HDC_W];

/* FNV-1a over bytes -> u32 seed. */
uint32_t hdc_fnv1a(const char *s, size_t n);

/* u32 seed -> HDC_D deterministic pseudo-random bits. Stateless; a token
 * vector is just hdc_expand(hdc_fnv1a(tok)), so no cache is needed. */
void hdc_expand(uint32_t seed, uint64_t *out);

/* bind = xor. Self-inverse, similarity-preserving: the ADDRESS operation. */
void hdc_bind(const uint64_t *a, const uint64_t *b, uint64_t *out);

/* permute = rotate left by n bits. Encodes position/order. */
void hdc_permute(int n, const uint64_t *v, uint64_t *out);

/* Per-bit set-counts over `n` seeds. The un-collapsed bundle.
 * `counts` must have HDC_D entries. */
void hdc_counts(const uint32_t *seeds, size_t n, uint16_t *counts);

/* counts + observation count -> vector. Exact ties take the TIE bit. */
void hdc_seal(const uint16_t *counts, size_t n, uint64_t *out);

/* bundle = majority over `n` token seeds. TinyOS `bund`. */
void hdc_bundle(const uint32_t *seeds, size_t n, uint64_t *out);

/* Unmasked similarity in [0,1]. 0.5 == unrelated. */
double hdc_sim(const uint64_t *a, const uint64_t *b);

/* Similarity restricted to set bits of `mask`. */
double hdc_sim_masked(const uint64_t *a, const uint64_t *b, const uint64_t *mask);

/* Bit mask keeping the `keep` most informative bits of a corpus of `n`
 * document vectors. `scratch` must hold HDC_D uint16 counters. */
void hdc_idf_mask(const uint64_t *docs, size_t n, size_t keep,
                  uint16_t *scratch, uint64_t *mask);

#endif /* HDC_H */
