/* symbols.h — geometry -> discrete symbols. PURE: no I/O.
 *
 * The gate: how much of an embedding's neighbourhood structure survives being
 * turned into a set of discrete symbols? Everything algebraic downstream
 * (Datalog, FCA, lint, ablate) runs on symbols, so whatever is lost here is
 * lost permanently — no algebra above can recover it.
 *
 * Three symbolisers, at a MATCHED BUDGET so the comparison is about assignment
 * and nothing else: every item gets M symbols drawn from the same vocabulary.
 *
 *   PQ       PARTITION. Split dims into M subspaces, k-means each. Exactly one
 *            symbol per subspace, so a small move across a Voronoi boundary
 *            flips a symbol completely. This is VQ done fairly — plain VQ gives
 *            one symbol per item and cannot rank at all.
 *   RANDTOPK SPARSE, zero learning. Random overcomplete dictionary, keep the M
 *            largest projections. If this beats PQ, sparsity alone wins the
 *            argument without any fitting at all.
 *   DICTTOPK SPARSE, learned. Same encoder, dictionary fitted by alternating
 *            top-k encode / least-squares atom update.
 *
 * DICTTOPK's encoder is exactly a TopK sparse autoencoder's: h = TopK(D'x).
 * The dictionary is fitted by alternation rather than Adam, so there is no
 * autodiff and no backprop here. A real SAE (L1/Adam, learned bias, tied or
 * untied decoder) goes to cuda-box — this measures whether the SPARSE-vs-
 * PARTITION principle holds before anything is worth training.
 */
#ifndef SYMBOLS_H
#define SYMBOLS_H

#include <stddef.h>
#include <stdint.h>

/* PCA-whiten in place: centre, decorrelate, equalise variance, renormalise.
 * Measured on this corpus: anisotropy (mean cosine of random pairs) 0.5815
 * before, 0.0001 after. Unfitted symbolisers should be the ones that care —
 * a random direction is only informative if the data actually varies along it.
 * Returns the anisotropy before whitening. */
double sym_whiten(float *X, size_t n, int dim);
double sym_anisotropy_now(const float *X, size_t n, int dim);

/* Product quantiser: M subspaces, each with `centroids` clusters.
 * codes[i*M + m] is item i's symbol in subspace m, offset so symbol ids are
 * globally unique across subspaces. */
void sym_pq(const float *X, size_t n, int dim, int M, int centroids,
            int iters, uint32_t seed, int32_t *codes);

/* Random overcomplete dictionary, `natoms` unit columns of length dim. */
void sym_rand_dict(int dim, int natoms, uint32_t seed, float *D);

/* Fit a dictionary by alternating TopK encode / atom update. */
void sym_learn_dict(const float *X, size_t n, int dim, int natoms, int M,
                    int iters, uint32_t seed, float *D);

/* h = TopK(D'x): the M largest projections. Writes M atom indices per item. */
void sym_topk_encode(const float *X, size_t n, int dim, const float *D,
                     int natoms, int M, int32_t *codes);

/* Recall of the true neighbours using ONLY symbol-set overlap to rank.
 * `truth` is nq x K global item indices from full-precision cosine.
 * Ties are broken by item index, so a degenerate symboliser that scores
 * everything equally scores near chance rather than accidentally well. */
double sym_recall(const int32_t *codes, size_t n, int M,
                  const int32_t *queries, size_t nq,
                  const int32_t *truth, int K, int at);

#endif /* SYMBOLS_H */
