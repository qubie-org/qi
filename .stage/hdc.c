#include "hdc.h"
#include <stdlib.h>
#include <string.h>

uint32_t hdc_fnv1a(const char *s, size_t n)
{
	uint32_t h = 2166136261u;
	for (size_t i = 0; i < n; i++) {
		h ^= (unsigned char)s[i];
		h *= 16777619u;
	}
	return h;
}

static inline uint32_t xs32(uint32_t x)
{
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	return x;
}

void hdc_expand(uint32_t seed, uint64_t *out)
{
	uint32_t x = seed ? seed : 1u;
	for (int i = 0; i < HDC_W; i++) {
		uint32_t lo = (x = xs32(x));
		uint32_t hi = (x = xs32(x));
		out[i] = ((uint64_t)hi << 32) | lo;
	}
}

/* Tie-break vector, computed once. Deterministic, so this stays pure in
 * effect: same bits on every run and every platform. */
static const uint64_t *tie_vec(void)
{
	static uint64_t tie[HDC_W];
	static int done = 0;
	if (!done) {
		hdc_expand(hdc_fnv1a("toki:tie", 8), tie);
		done = 1;
	}
	return tie;
}

void hdc_bind(const uint64_t *a, const uint64_t *b, uint64_t *out)
{
	for (int i = 0; i < HDC_W; i++)
		out[i] = a[i] ^ b[i];
}

void hdc_permute(int n, const uint64_t *v, uint64_t *out)
{
	int s = ((n % HDC_D) + HDC_D) % HDC_D;
	memset(out, 0, HDC_W * sizeof(uint64_t));
	for (int bit = 0; bit < HDC_D; bit++) {
		int src = (bit + s) % HDC_D;
		if ((v[src >> 6] >> (src & 63)) & 1ull)
			out[bit >> 6] |= 1ull << (bit & 63);
	}
}

void hdc_counts(const uint32_t *seeds, size_t n, uint16_t *counts)
{
	memset(counts, 0, HDC_D * sizeof(uint16_t));
	uint64_t v[HDC_W];
	for (size_t k = 0; k < n; k++) {
		hdc_expand(seeds[k], v);
		for (int i = 0; i < HDC_W; i++) {
			uint64_t w = v[i];
			int base = i << 6;
			while (w) {
				int b = __builtin_ctzll(w);
				counts[base + b]++;
				w &= w - 1;
			}
		}
	}
}

void hdc_seal(const uint16_t *counts, size_t n, uint64_t *out)
{
	const uint64_t *tie = tie_vec();
	memset(out, 0, HDC_W * sizeof(uint64_t));
	for (int i = 0; i < HDC_D; i++) {
		size_t m = (size_t)counts[i] * 2;
		int bit = m > n ? 1 : (m == n ? (int)((tie[i >> 6] >> (i & 63)) & 1ull) : 0);
		if (bit)
			out[i >> 6] |= 1ull << (i & 63);
	}
}

void hdc_bundle(const uint32_t *seeds, size_t n, uint64_t *out)
{
	if (n == 0) {
		memcpy(out, tie_vec(), HDC_W * sizeof(uint64_t));
		return;
	}
	static _Thread_local uint16_t counts[HDC_D];
	hdc_counts(seeds, n, counts);
	hdc_seal(counts, n, out);
}

double hdc_sim(const uint64_t *a, const uint64_t *b)
{
	int h = 0;
	for (int i = 0; i < HDC_W; i++)
		h += __builtin_popcountll(a[i] ^ b[i]);
	return 1.0 - (double)h / (double)HDC_D;
}

double hdc_sim_masked(const uint64_t *a, const uint64_t *b, const uint64_t *mask)
{
	int agree = 0, total = 0;
	for (int i = 0; i < HDC_W; i++) {
		uint64_t m = mask[i];
		total += __builtin_popcountll(m);
		agree += __builtin_popcountll(~(a[i] ^ b[i]) & m);
	}
	return total == 0 ? 0.5 : (double)agree / (double)total;
}

struct bitscore {
	float score;
	int idx;
};

static int cmp_bitscore(const void *x, const void *y)
{
	const struct bitscore *a = x, *b = y;
	if (a->score > b->score) return -1;
	if (a->score < b->score) return 1;
	return a->idx - b->idx; /* deterministic tie-break */
}

void hdc_idf_mask(const uint64_t *docs, size_t n, size_t keep,
                  uint16_t *scratch, uint64_t *mask)
{
	memset(scratch, 0, HDC_D * sizeof(uint16_t));
	for (size_t d = 0; d < n; d++) {
		const uint64_t *v = docs + d * HDC_W;
		for (int i = 0; i < HDC_W; i++) {
			uint64_t w = v[i];
			int base = i << 6;
			while (w) {
				int b = __builtin_ctzll(w);
				scratch[base + b]++;
				w &= w - 1;
			}
		}
	}

	struct bitscore *bs = malloc(HDC_D * sizeof(*bs));
	if (!bs) {
		memset(mask, 0xff, HDC_W * sizeof(uint64_t));
		return;
	}
	for (int i = 0; i < HDC_D; i++) {
		double p = n ? (double)scratch[i] / (double)n : 0.5;
		/* Bernoulli entropy proxy: 1 at p=0.5, 0 at p=0 or 1. */
		bs[i].score = (float)(1.0 - 2.0 * (p < 0.5 ? 0.5 - p : p - 0.5));
		bs[i].idx = i;
	}
	qsort(bs, HDC_D, sizeof(*bs), cmp_bitscore);

	memset(mask, 0, HDC_W * sizeof(uint64_t));
	size_t k = keep < 1 ? 1 : (keep > HDC_D ? HDC_D : keep);
	for (size_t j = 0; j < k; j++) {
		int i = bs[j].idx;
		mask[i >> 6] |= 1ull << (i & 63);
	}
	free(bs);
}
