#include "bench.h"
#include "hdc.h"
#include "potion.h"
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>

#define MAXTOK 65536

size_t bench_tokenize(const char *text, uint32_t *out, size_t cap)
{
	size_t n = 0;
	const char *p = text;
	char buf[128];
	while (*p && n < cap) {
		while (*p && !isalnum((unsigned char)*p))
			p++;
		if (!*p)
			break;
		size_t len = 0;
		while (*p && isalnum((unsigned char)*p) && len < sizeof(buf) - 1)
			buf[len++] = (char)tolower((unsigned char)*p++);
		while (*p && isalnum((unsigned char)*p))
			p++; /* overlong token: consume the tail */
		if (len)
			out[n++] = hdc_fnv1a(buf, len);
	}
	return n;
}

static int cmp_u32(const void *a, const void *b)
{
	uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
	return x < y ? -1 : (x > y ? 1 : 0);
}

size_t bench_dedup(uint32_t *a, size_t n)
{
	if (n == 0)
		return 0;
	qsort(a, n, sizeof(uint32_t), cmp_u32);
	size_t w = 1;
	for (size_t i = 1; i < n; i++)
		if (a[i] != a[w - 1])
			a[w++] = a[i];
	return w;
}

/* ---- holdout -------------------------------------------------------- */

static size_t count_words(const char *s, size_t len)
{
	size_t n = 0;
	int in = 0;
	for (size_t i = 0; i < len; i++) {
		if (isalnum((unsigned char)s[i])) {
			if (!in) { n++; in = 1; }
		} else {
			in = 0;
		}
	}
	return n;
}

static char *dup_range(const char *s, size_t len)
{
	char *o = malloc(len + 1);
	if (!o)
		return NULL;
	memcpy(o, s, len);
	o[len] = 0;
	return o;
}

size_t bench_build_trials(const doc_t *docs, size_t ndocs, trial_t *out,
                          size_t min_words)
{
	size_t n = 0;
	for (size_t d = 0; d < ndocs; d++) {
		const char *t = docs[d].text;
		size_t tlen = strlen(t);

		/* paragraph offsets, split on blank lines */
		size_t starts[4096], ends[4096], np = 0;
		size_t i = 0;
		while (i < tlen && np < 4096) {
			while (i < tlen && isspace((unsigned char)t[i]))
				i++;
			if (i >= tlen)
				break;
			size_t s = i;
			while (i < tlen) {
				if (t[i] == '\n') {
					size_t j = i + 1;
					while (j < tlen && (t[j] == ' ' || t[j] == '\t' || t[j] == '\r'))
						j++;
					if (j < tlen && t[j] == '\n')
						break;
				}
				i++;
			}
			starts[np] = s;
			ends[np] = i;
			np++;
		}
		if (np < 3)
			continue;

		size_t best = 0, bestn = 0;
		for (size_t k = 0; k < np; k++) {
			size_t w = count_words(t + starts[k], ends[k] - starts[k]);
			if (w > bestn) { bestn = w; best = k; }
		}
		if (bestn < min_words)
			continue;

		char *q = dup_range(t + starts[best], ends[best] - starts[best]);
		/* +2 per paragraph: paragraphs must stay separated by a BLANK line so
		 * the per-paragraph encoder can split the body again. Joining with a
		 * single '\n' silently collapses the body to one paragraph. */
		char *body = malloc(tlen + 2 * np + 1);
		if (!q || !body) { free(q); free(body); continue; }
		size_t bl = 0;
		for (size_t k = 0; k < np; k++) {
			if (k == best)
				continue;
			size_t len = ends[k] - starts[k];
			memcpy(body + bl, t + starts[k], len);
			bl += len;
			body[bl++] = '\n';
			body[bl++] = '\n';
		}
		body[bl] = 0;

		out[n].path = dup_range(docs[d].path, strlen(docs[d].path));
		out[n].query = q;
		out[n].body = body;
		n++;
	}
	return n;
}

void bench_free_trials(trial_t *t, size_t n)
{
	for (size_t i = 0; i < n; i++) {
		free(t[i].path);
		free(t[i].query);
		free(t[i].body);
	}
}

/* ---- run ------------------------------------------------------------ */

/* Build query seeds under a condition. nopath drops every token that appears
 * in the document's own path; qwords truncates. */
static size_t query_seeds(const trial_t *tr, int nopath, size_t qwords,
                          int dedup, uint32_t *out, size_t cap)
{
	static _Thread_local uint32_t raw[MAXTOK], pathtok[4096];
	size_t nq = bench_tokenize(tr->query, raw, MAXTOK);
	size_t np = 0;
	if (nopath) {
		np = bench_tokenize(tr->path, pathtok, 4096);
		np = bench_dedup(pathtok, np);
	}

	size_t n = 0;
	for (size_t i = 0; i < nq && n < cap; i++) {
		if (nopath && bsearch(&raw[i], pathtok, np, sizeof(uint32_t), cmp_u32))
			continue;
		out[n++] = raw[i];
		if (qwords && n >= qwords)
			break;
	}
	if (dedup)
		n = bench_dedup(out, n);
	return n;
}

static void score(const int *ranks, size_t n, row_t *r)
{
	size_t t1 = 0, t5 = 0;
	double mrr = 0;
	for (size_t i = 0; i < n; i++) {
		if (ranks[i] == 1) t1++;
		if (ranks[i] <= 5) t5++;
		mrr += 1.0 / (double)ranks[i];
	}
	r->top1 = (double)t1 / (double)n;
	r->top5 = (double)t5 / (double)n;
	r->mrr = mrr / (double)n;
}

#define MAXPARA 64

/* Split body into paragraphs and bundle each separately. Returns count. */
static size_t para_vecs(const char *body, int dedup, uint64_t *out, size_t cap)
{
	static _Thread_local uint32_t seeds[MAXTOK];
	size_t np = 0, len = strlen(body), i = 0;
	while (i < len && np < cap) {
		while (i < len && isspace((unsigned char)body[i]))
			i++;
		if (i >= len)
			break;
		size_t s = i;
		while (i < len) {
			if (body[i] == '\n') {
				size_t j = i + 1;
				while (j < len && (body[j] == ' ' || body[j] == '\t' || body[j] == '\r'))
					j++;
				if (j < len && body[j] == '\n')
					break;
			}
			i++;
		}
		char *chunk = dup_range(body + s, i - s);
		if (!chunk)
			continue;
		size_t k = bench_tokenize(chunk, seeds, MAXTOK);
		free(chunk);
		if (k < 5)
			continue; /* skip headings and one-liners */
		if (dedup)
			k = bench_dedup(seeds, k);
		hdc_bundle(seeds, k, out + np * HDC_W);
		np++;
	}
	return np;
}

static void score(const int *ranks, size_t n, row_t *r);

/* Same conditions as query_seeds, but emitting TEXT so a non-HDC encoder can
 * be given exactly the same input. */
static void query_text(const trial_t *tr, int nopath, size_t qwords,
                       char *out, size_t cap)
{
	static _Thread_local uint32_t pathtok[4096];
	size_t np = 0;
	if (nopath) {
		np = bench_tokenize(tr->path, pathtok, 4096);
		np = bench_dedup(pathtok, np);
	}
	size_t o = 0, kept = 0;
	const char *c = tr->query;
	char buf[128];
	while (*c && o + 130 < cap) {
		while (*c && !isalnum((unsigned char)*c))
			c++;
		if (!*c)
			break;
		size_t l = 0;
		while (*c && isalnum((unsigned char)*c) && l < sizeof(buf) - 1)
			buf[l++] = (char)tolower((unsigned char)*c++);
		while (*c && isalnum((unsigned char)*c))
			c++;
		uint32_t h = hdc_fnv1a(buf, l);
		if (nopath && bsearch(&h, pathtok, np, sizeof(uint32_t), cmp_u32))
			continue;
		memcpy(out + o, buf, l);
		o += l;
		out[o++] = ' ';
		if (qwords && ++kept >= qwords)
			break;
	}
	out[o] = 0;
}

/* out = normalize(v - (v.u)u), u a unit vector. Removes one shared direction. */
static void project_out(const float *v, const float *mu, int dim, float *out)
{
	float mn = 0;
	for (int d = 0; d < dim; d++) mn += mu[d] * mu[d];
	mn = mn > 0 ? sqrtf(mn) : 1.0f;
	float proj = 0;
	for (int d = 0; d < dim; d++) proj += v[d] * (mu[d] / mn);
	float norm = 0;
	for (int d = 0; d < dim; d++) {
		out[d] = v[d] - proj * (mu[d] / mn);
		norm += out[d] * out[d];
	}
	norm = norm > 0 ? sqrtf(norm) : 1.0f;
	for (int d = 0; d < dim; d++) out[d] /= norm;
}

size_t bench_run_potion(const void *pv, const trial_t *trials, size_t n,
                        size_t qwords, row_t *rows, size_t rowcap,
                        double *coverage)
{
	const potion_t *p = (const potion_t *)pv;
	int dim = potion_dim(p);
	float *dv = malloc(n * (size_t)dim * sizeof(float));
	float *qv = malloc(n * (size_t)dim * sizeof(float));
	char *qbuf = malloc(1 << 16);
	int *ranks = malloc(n * sizeof(int));
	size_t nrows = 0, hits = 0, total = 0;
	if (!dv || !qv || !qbuf || !ranks)
		goto done;

	for (size_t i = 0; i < n; i++) {
		size_t h = 0, t = 0;
		potion_encode(p, trials[i].body, dv + i * dim, &h, &t);
		hits += h;
		total += t;
	}
	if (coverage)
		*coverage = total ? (double)hits / (double)total : 0.0;

	/* Corpus mean of the document vectors == the anisotropic common component
	 * every document shares. Mean-pooling hundreds of dense vectors is
	 * superposition far past their measured capacity, so this direction
	 * dominates and documents collapse toward each other. Removing it is the
	 * dense analog of whitening. */
	float *mu = calloc((size_t)dim, sizeof(float));
	for (size_t i = 0; i < n; i++)
		for (int d = 0; d < dim; d++)
			mu[d] += dv[i * dim + d];
	for (int d = 0; d < dim; d++)
		mu[d] /= (float)n;

	for (int cc = 0; cc < 2; cc++) {
		float *dvv = dv;
		if (cc) {
			dvv = malloc(n * (size_t)dim * sizeof(float));
			for (size_t i = 0; i < n; i++)
				project_out(dv + i * dim, mu, dim, dvv + i * dim);
		}
		for (int c = 0; c < 2; c++) {
			for (size_t i = 0; i < n; i++) {
				query_text(&trials[i], c == 1, qwords, qbuf, 1 << 16);
				potion_encode(p, qbuf, qv + i * dim, NULL, NULL);
				if (cc)
					project_out(qv + i * dim, mu, dim, qv + i * dim);
			}
			for (size_t i = 0; i < n; i++) {
				float self = potion_dot(qv + i * dim, dvv + i * dim, dim);
				int better = 1;
				for (size_t j = 0; j < n; j++)
					if (j != i && potion_dot(qv + i * dim, dvv + j * dim, dim) > self)
						better++;
				ranks[i] = better;
			}
			if (nrows < rowcap) {
				rows[nrows].method = cc ? "potion-cc" : "potion";
				rows[nrows].cond = c ? "nopath" : "raw";
				score(ranks, n, &rows[nrows]);
				nrows++;
			}
		}
		if (cc)
			free(dvv);
	}
	free(mu);
done:
	free(dv); free(qv); free(qbuf); free(ranks);
	return nrows;
}

static int cmp_desc(const void *a, const void *b)
{
	double x = *(const double *)a, y = *(const double *)b;
	return x < y ? 1 : (x > y ? -1 : 0);
}

/* pool == 0 -> max. pool == k -> mean of the top k paragraph similarities.
 *
 * Plain max is biased by paragraph COUNT: the max of many noisy samples grows
 * with how many you draw, so documents with more paragraphs score higher for
 * reasons unrelated to relevance. Averaging the top k damps that, and
 * comparing the two says whether any observed effect is the representation or
 * just extreme-value statistics. */
static double pool_score(const uint64_t *q, const uint64_t *paras, size_t np,
                         size_t pool)
{
	if (np == 0)
		return 0.0;
	if (pool == 0) {
		double best = -1;
		for (size_t p = 0; p < np; p++) {
			double s = hdc_sim(q, paras + p * HDC_W);
			if (s > best) best = s;
		}
		return best;
	}
	double buf[MAXPARA];
	for (size_t p = 0; p < np; p++)
		buf[p] = hdc_sim(q, paras + p * HDC_W);
	qsort(buf, np, sizeof(double), cmp_desc);
	size_t k = pool < np ? pool : np;
	double sum = 0;
	for (size_t p = 0; p < k; p++)
		sum += buf[p];
	return sum / (double)k;
}

size_t bench_run_multi(const trial_t *trials, size_t n, size_t qwords,
                       size_t pool, row_t *rows, size_t rowcap)
{
	static const char *name_max[2] = { "tvec/pMax", "tvecSet/pMax" };
	static const char *name_top[2] = { "tvec/pTop3", "tvecSet/pTop3" };
	const char **name = pool == 0 ? name_max : name_top;
	uint64_t *pv = malloc(n * MAXPARA * HDC_W * sizeof(uint64_t));
	size_t *pn = malloc(n * sizeof(size_t));
	uint64_t *qv = malloc(n * HDC_W * sizeof(uint64_t));
	uint32_t *seeds = malloc(MAXTOK * sizeof(uint32_t));
	int *ranks = malloc(n * sizeof(int));
	size_t nrows = 0;
	if (!pv || !pn || !qv || !seeds || !ranks)
		goto done;

	for (int e = 0; e < 2; e++) {
		int dedup = (e == 1);
		for (size_t i = 0; i < n; i++)
			pn[i] = para_vecs(trials[i].body, dedup,
			                  pv + i * MAXPARA * HDC_W, MAXPARA);

		for (int c = 0; c < 2; c++) {
			for (size_t i = 0; i < n; i++) {
				size_t k = query_seeds(&trials[i], c == 1, qwords, dedup,
				                       seeds, MAXTOK);
				hdc_bundle(seeds, k, qv + i * HDC_W);
			}
			for (size_t i = 0; i < n; i++) {
				const uint64_t *q = qv + i * HDC_W;
				double self = pool_score(q, pv + i * MAXPARA * HDC_W, pn[i], pool);
				int better = 1;
				for (size_t j = 0; j < n; j++) {
					if (j == i)
						continue;
					if (pool_score(q, pv + j * MAXPARA * HDC_W, pn[j], pool) > self)
						better++;
				}
				ranks[i] = better;
			}
			if (nrows < rowcap) {
				rows[nrows].method = name[e];
				rows[nrows].cond = c ? "nopath" : "raw";
				score(ranks, n, &rows[nrows]);
				nrows++;
			}
		}
	}
done:
	free(pv); free(pn); free(qv); free(seeds); free(ranks);
	return nrows;
}

size_t bench_run(const trial_t *trials, size_t n, size_t keep, size_t qwords,
                 row_t *rows, size_t rowcap)
{
	static const char *enc_name[2] = { "tvec", "tvecSet" };
	static const char *cond_name[2] = { "raw", "nopath" };

	uint64_t *dv = malloc(n * HDC_W * sizeof(uint64_t));
	uint64_t *qv = malloc(n * HDC_W * sizeof(uint64_t));
	uint16_t *scratch = malloc(HDC_D * sizeof(uint16_t));
	uint32_t *seeds = malloc(MAXTOK * sizeof(uint32_t));
	int *ranks = malloc(n * sizeof(int));
	uint64_t mask[HDC_W];
	size_t nrows = 0;

	if (!dv || !qv || !scratch || !seeds || !ranks)
		goto done;

	for (int e = 0; e < 2; e++) {
		int dedup = (e == 1);
		for (size_t i = 0; i < n; i++) {
			size_t k = bench_tokenize(trials[i].body, seeds, MAXTOK);
			if (dedup)
				k = bench_dedup(seeds, k);
			hdc_bundle(seeds, k, dv + i * HDC_W);
		}
		hdc_idf_mask(dv, n, keep, scratch, mask);

		for (int c = 0; c < 2; c++) {
			for (size_t i = 0; i < n; i++) {
				size_t k = query_seeds(&trials[i], c == 1, qwords, dedup,
				                       seeds, MAXTOK);
				hdc_bundle(seeds, k, qv + i * HDC_W);
			}
			for (int m = 0; m < 2; m++) {
				for (size_t i = 0; i < n; i++) {
					const uint64_t *q = qv + i * HDC_W;
					double s = m ? hdc_sim_masked(q, dv + i * HDC_W, mask)
					             : hdc_sim(q, dv + i * HDC_W);
					int better = 1;
					for (size_t j = 0; j < n; j++) {
						if (j == i)
							continue;
						double sj = m ? hdc_sim_masked(q, dv + j * HDC_W, mask)
						              : hdc_sim(q, dv + j * HDC_W);
						if (sj > s)
							better++;
					}
					ranks[i] = better;
				}
				if (nrows < rowcap) {
					rows[nrows].method = m ? (e ? "tvecSet+idf" : "tvec+idf")
					                       : enc_name[e];
					rows[nrows].cond = cond_name[c];
					score(ranks, n, &rows[nrows]);
					nrows++;
				}
			}
		}
	}

done:
	free(dv); free(qv); free(scratch); free(seeds); free(ranks);
	return nrows;
}
