#include "symbols.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <float.h>

static uint32_t xs32(uint32_t x)
{
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	return x ? x : 1u;
}

static float frand(uint32_t *s)
{
	*s = xs32(*s);
	return (float)((*s >> 8) & 0xffffff) / 16777216.0f - 0.5f;
}

/* ---- whitening -------------------------------------------------------- */

/* Cyclic Jacobi eigendecomposition of a symmetric dim x dim matrix.
 * A is overwritten; V holds eigenvectors in columns. dim=384 so this is fine. */
static void jacobi(float *A, float *V, int dim, int sweeps)
{
	for (int i = 0; i < dim; i++)
		for (int j = 0; j < dim; j++)
			V[(size_t)i * dim + j] = (i == j) ? 1.0f : 0.0f;
	for (int s = 0; s < sweeps; s++) {
		double off = 0;
		for (int p = 0; p < dim; p++)
			for (int q = p + 1; q < dim; q++)
				off += (double)A[(size_t)p * dim + q] * A[(size_t)p * dim + q];
		if (off < 1e-12)
			break;
		for (int p = 0; p < dim; p++) {
			for (int q = p + 1; q < dim; q++) {
				float apq = A[(size_t)p * dim + q];
				if (fabsf(apq) < 1e-9f)
					continue;
				float app = A[(size_t)p * dim + p], aqq = A[(size_t)q * dim + q];
				float theta = (aqq - app) / (2.0f * apq);
				float t = (theta >= 0 ? 1.0f : -1.0f) /
				          (fabsf(theta) + sqrtf(theta * theta + 1.0f));
				float c = 1.0f / sqrtf(t * t + 1.0f), sn = t * c;
				for (int k = 0; k < dim; k++) {
					float akp = A[(size_t)k * dim + p], akq = A[(size_t)k * dim + q];
					A[(size_t)k * dim + p] = c * akp - sn * akq;
					A[(size_t)k * dim + q] = sn * akp + c * akq;
				}
				for (int k = 0; k < dim; k++) {
					float apk = A[(size_t)p * dim + k], aqk = A[(size_t)q * dim + k];
					A[(size_t)p * dim + k] = c * apk - sn * aqk;
					A[(size_t)q * dim + k] = sn * apk + c * aqk;
				}
				for (int k = 0; k < dim; k++) {
					float vkp = V[(size_t)k * dim + p], vkq = V[(size_t)k * dim + q];
					V[(size_t)k * dim + p] = c * vkp - sn * vkq;
					V[(size_t)k * dim + q] = sn * vkp + c * vkq;
				}
			}
		}
	}
}

static double anisotropy(const float *X, size_t n, int dim, uint32_t seed)
{
	uint32_t s = seed ? seed : 1u;
	double acc = 0;
	int trials = 20000;
	for (int t = 0; t < trials; t++) {
		s = xs32(s); size_t i = s % n;
		s = xs32(s); size_t j = s % n;
		const float *a = X + i * dim, *b = X + j * dim;
		double d = 0, na = 0, nb = 0;
		for (int k = 0; k < dim; k++) { d += a[k]*b[k]; na += a[k]*a[k]; nb += b[k]*b[k]; }
		if (na > 0 && nb > 0) acc += d / (sqrt(na) * sqrt(nb));
	}
	return acc / trials;
}

double sym_anisotropy_now(const float *X, size_t n, int dim)
{
	return anisotropy(X, n, dim, 4242u);
}

double sym_whiten(float *X, size_t n, int dim)
{
	double before = anisotropy(X, n, dim, 4242u);

	double *mu = calloc((size_t)dim, sizeof(double));
	for (size_t i = 0; i < n; i++)
		for (int k = 0; k < dim; k++) mu[k] += X[i * dim + k];
	for (int k = 0; k < dim; k++) mu[k] /= (double)n;
	for (size_t i = 0; i < n; i++)
		for (int k = 0; k < dim; k++) X[i * dim + k] -= (float)mu[k];

	float *C = calloc((size_t)dim * dim, sizeof(float));
	for (size_t i = 0; i < n; i++) {
		const float *x = X + i * dim;
		for (int a = 0; a < dim; a++)
			for (int b = a; b < dim; b++)
				C[(size_t)a * dim + b] += x[a] * x[b];
	}
	for (int a = 0; a < dim; a++)
		for (int b = a; b < dim; b++) {
			C[(size_t)a * dim + b] /= (float)(n - 1);
			C[(size_t)b * dim + a] = C[(size_t)a * dim + b];
		}

	float *V = malloc((size_t)dim * dim * sizeof(float));
	jacobi(C, V, dim, 30);
	float *isq = malloc((size_t)dim * sizeof(float));
	for (int k = 0; k < dim; k++) {
		float ev = C[(size_t)k * dim + k];
		isq[k] = ev > 1e-8f ? 1.0f / sqrtf(ev) : 0.0f;
	}

	float *tmp = malloc((size_t)dim * sizeof(float));
	for (size_t i = 0; i < n; i++) {
		float *x = X + i * dim;
		for (int k = 0; k < dim; k++) {
			float s = 0;
			for (int a = 0; a < dim; a++) s += x[a] * V[(size_t)a * dim + k];
			tmp[k] = s * isq[k];
		}
		float nrm = 0;
		for (int k = 0; k < dim; k++) nrm += tmp[k] * tmp[k];
		nrm = nrm > 0 ? sqrtf(nrm) : 1.0f;
		for (int k = 0; k < dim; k++) x[k] = tmp[k] / nrm;
	}
	free(mu); free(C); free(V); free(isq); free(tmp);
	return before;
}

/* ---- PQ: partition ---------------------------------------------------- */

void sym_pq(const float *X, size_t n, int dim, int M, int centroids,
            int iters, uint32_t seed, int32_t *codes)
{
	int sub = dim / M;
	float *C = malloc((size_t)centroids * sub * sizeof(float));
	float *sum = malloc((size_t)centroids * sub * sizeof(float));
	int *cnt = malloc((size_t)centroids * sizeof(int));
	int32_t *a = malloc(n * sizeof(int32_t));
	if (!C || !sum || !cnt || !a) goto out;

	for (int m = 0; m < M; m++) {
		uint32_t s = seed + (uint32_t)m * 7919u;
		/* init from data samples */
		for (int c = 0; c < centroids; c++) {
			s = xs32(s);
			size_t pick = s % n;
			memcpy(C + (size_t)c * sub, X + pick * dim + (size_t)m * sub,
			       (size_t)sub * sizeof(float));
		}
		for (int it = 0; it < iters; it++) {
			memset(sum, 0, (size_t)centroids * sub * sizeof(float));
			memset(cnt, 0, (size_t)centroids * sizeof(int));
			for (size_t i = 0; i < n; i++) {
				const float *x = X + i * dim + (size_t)m * sub;
				int best = 0;
				float bd = FLT_MAX;
				for (int c = 0; c < centroids; c++) {
					const float *cc = C + (size_t)c * sub;
					float d = 0;
					for (int k = 0; k < sub; k++) {
						float t = x[k] - cc[k];
						d += t * t;
					}
					if (d < bd) { bd = d; best = c; }
				}
				a[i] = best;
				float *sp = sum + (size_t)best * sub;
				for (int k = 0; k < sub; k++) sp[k] += x[k];
				cnt[best]++;
			}
			for (int c = 0; c < centroids; c++) {
				if (!cnt[c]) continue;
				float *cc = C + (size_t)c * sub, *sp = sum + (size_t)c * sub;
				for (int k = 0; k < sub; k++) cc[k] = sp[k] / (float)cnt[c];
			}
		}
		/* global symbol ids: subspace m owns [m*centroids, (m+1)*centroids) */
		for (size_t i = 0; i < n; i++)
			codes[i * M + m] = a[i] + m * centroids;
	}
out:
	free(C); free(sum); free(cnt); free(a);
}

/* ---- sparse: dictionaries --------------------------------------------- */

void sym_rand_dict(int dim, int natoms, uint32_t seed, float *D)
{
	uint32_t s = seed ? seed : 1u;
	for (int j = 0; j < natoms; j++) {
		float *d = D + (size_t)j * dim, nrm = 0;
		for (int k = 0; k < dim; k++) { d[k] = frand(&s); nrm += d[k] * d[k]; }
		nrm = nrm > 0 ? sqrtf(nrm) : 1.0f;
		for (int k = 0; k < dim; k++) d[k] /= nrm;
	}
}

/* Top-M by |projection|, descending. */
static void topk(const float *proj, int natoms, int M, int32_t *out)
{
	for (int m = 0; m < M; m++) out[m] = -1;
	float best[64];
	for (int m = 0; m < M; m++) best[m] = -FLT_MAX;
	for (int j = 0; j < natoms; j++) {
		float v = fabsf(proj[j]);
		if (v <= best[M - 1]) continue;
		int p = M - 1;
		while (p > 0 && best[p - 1] < v) { best[p] = best[p - 1]; out[p] = out[p - 1]; p--; }
		best[p] = v; out[p] = j;
	}
}

void sym_topk_encode(const float *X, size_t n, int dim, const float *D,
                     int natoms, int M, int32_t *codes)
{
	float *proj = malloc((size_t)natoms * sizeof(float));
	if (!proj) return;
	for (size_t i = 0; i < n; i++) {
		const float *x = X + i * dim;
		for (int j = 0; j < natoms; j++) {
			const float *d = D + (size_t)j * dim;
			float s = 0;
			for (int k = 0; k < dim; k++) s += x[k] * d[k];
			proj[j] = s;
		}
		topk(proj, natoms, M, codes + i * M);
	}
	free(proj);
}

void sym_learn_dict(const float *X, size_t n, int dim, int natoms, int M,
                    int iters, uint32_t seed, float *D)
{
	sym_rand_dict(dim, natoms, seed, D);
	float *acc = malloc((size_t)natoms * dim * sizeof(float));
	int *cnt = malloc((size_t)natoms * sizeof(int));
	float *proj = malloc((size_t)natoms * sizeof(float));
	int32_t code[64];
	if (!acc || !cnt || !proj) goto out;

	for (int it = 0; it < iters; it++) {
		memset(acc, 0, (size_t)natoms * dim * sizeof(float));
		memset(cnt, 0, (size_t)natoms * sizeof(int));
		for (size_t i = 0; i < n; i++) {
			const float *x = X + i * dim;
			for (int j = 0; j < natoms; j++) {
				const float *d = D + (size_t)j * dim;
				float s = 0;
				for (int k = 0; k < dim; k++) s += x[k] * d[k];
				proj[j] = s;
			}
			topk(proj, natoms, M, code);
			/* pull each selected atom toward this item, signed by its
			 * projection so atoms do not fight over direction */
			for (int m = 0; m < M; m++) {
				int j = code[m];
				if (j < 0) continue;
				float sgn = proj[j] < 0 ? -1.0f : 1.0f;
				float *ap = acc + (size_t)j * dim;
				for (int k = 0; k < dim; k++) ap[k] += sgn * x[k];
				cnt[j]++;
			}
		}
		uint32_t s = seed + 104729u + (uint32_t)it;
		for (int j = 0; j < natoms; j++) {
			float *d = D + (size_t)j * dim;
			if (cnt[j] < 2) { /* dead atom: re-seed off a random item */
				s = xs32(s);
				memcpy(d, X + (size_t)(s % n) * dim, (size_t)dim * sizeof(float));
			} else {
				memcpy(d, acc + (size_t)j * dim, (size_t)dim * sizeof(float));
			}
			float nrm = 0;
			for (int k = 0; k < dim; k++) nrm += d[k] * d[k];
			nrm = nrm > 0 ? sqrtf(nrm) : 1.0f;
			for (int k = 0; k < dim; k++) d[k] /= nrm;
		}
	}
out:
	free(acc); free(cnt); free(proj);
}

/* ---- metric ----------------------------------------------------------- */

struct cand { int32_t idx; int32_t score; };

static int cmp_cand(const void *a, const void *b)
{
	const struct cand *x = a, *y = b;
	if (x->score != y->score) return y->score - x->score;
	return x->idx - y->idx;
}

double sym_recall(const int32_t *codes, size_t n, int M,
                  const int32_t *queries, size_t nq,
                  const int32_t *truth, int K, int at)
{
	struct cand *c = malloc(n * sizeof(struct cand));
	if (!c) return 0.0;
	double hit = 0, tot = 0;
	for (size_t t = 0; t < nq; t++) {
		int32_t qi = queries[t];
		const int32_t *qc = codes + (size_t)qi * M;
		for (size_t j = 0; j < n; j++) {
			const int32_t *jc = codes + j * M;
			int s = 0;
			for (int a = 0; a < M; a++)
				for (int b = 0; b < M; b++)
					if (qc[a] == jc[b]) { s++; break; }
			c[j].idx = (int32_t)j;
			c[j].score = s;
		}
		c[qi].score = -1; /* exclude self */
		qsort(c, n, sizeof(struct cand), cmp_cand);
		for (int k = 0; k < K; k++) {
			int32_t want = truth[t * K + k];
			tot++;
			for (int r = 0; r < at; r++)
				if (c[r].idx == want) { hit++; break; }
		}
	}
	free(c);
	return tot ? hit / tot : 0.0;
}
