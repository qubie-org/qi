/* symrun.c — rim for the symbolisation gate.
 *
 *   ./symbols [--data=DIR] [--m=16] [--atoms=4096] [--iters=8] [--at=50]
 *
 * Data: raw f32/i32 dumps of the bge-small corpus produced during the Gate 0
 * work (20000 x 384 embeddings, 2000 queries, top-10 cosine ground truth).
 */
#include "symbols.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void *slurp(const char *p, size_t *len)
{
	FILE *f = fopen(p, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	void *b = malloc((size_t)sz);
	if (b && fread(b, 1, (size_t)sz, f) != (size_t)sz) { free(b); b = NULL; }
	fclose(f);
	if (b) *len = (size_t)sz;
	return b;
}

static const char *arg(int argc, char **argv, const char *k, const char *d)
{
	char pat[64];
	snprintf(pat, sizeof(pat), "--%s=", k);
	size_t l = strlen(pat);
	for (int i = 1; i < argc; i++)
		if (!strncmp(argv[i], pat, l)) return argv[i] + l;
	return d;
}

int main(int argc, char **argv)
{
	char base[4096];
	snprintf(base, sizeof(base), "%s", arg(argc, argv, "data",
	         "/Users/shinyobjectz/.cache/semraster"));
	int M = atoi(arg(argc, argv, "m", "16"));
	int atoms = atoi(arg(argc, argv, "atoms", "4096"));
	int iters = atoi(arg(argc, argv, "iters", "8"));
	int at = atoi(arg(argc, argv, "at", "50"));
	int white = atoi(arg(argc, argv, "whiten", "0"));
	const int dim = 384, K = 10;

	char p[4200];
	size_t el = 0, ql = 0, tl = 0;
	snprintf(p, sizeof(p), "%s/emb.f32", base);
	float *X = slurp(p, &el);
	snprintf(p, sizeof(p), "%s/qidx.i32", base);
	int32_t *Q = slurp(p, &ql);
	snprintf(p, sizeof(p), "%s/truenn.i32", base);
	int32_t *T = slurp(p, &tl);
	if (!X || !Q || !T) { fprintf(stderr, "missing data in %s\n", base); return 1; }

	size_t n = el / (sizeof(float) * dim);
	size_t nq = ql / sizeof(int32_t);
	printf("corpus %zu x %d   queries %zu   truth top-%d\n", n, dim, nq, K);
	printf("budget %d symbols/item, vocabulary %d, recall@%d\n", M, atoms, at);
	if (white) {
		double a0 = sym_whiten(X, n, dim);
		printf("whitened: anisotropy %.4f -> %.4f\n", a0, sym_anisotropy_now(X, n, dim));
	}
	putchar('\n');

	int32_t *codes = malloc(n * (size_t)M * sizeof(int32_t));
	float *D = malloc((size_t)atoms * dim * sizeof(float));
	if (!codes || !D) return 1;

	printf("%-22s%10s%10s\n", "symboliser", "recall", "fit(s)");
	puts("------------------------------------------");

	clock_t t0 = clock();
	sym_pq(X, n, dim, M, atoms / M, iters, 12345u, codes);
	double fit = (double)(clock() - t0) / CLOCKS_PER_SEC;
	printf("%-22s%9.1f%%%10.1f\n", "PQ (partition)",
	       sym_recall(codes, n, M, Q, nq, T, K, at) * 100, fit);

	t0 = clock();
	sym_rand_dict(dim, atoms, 999u, D);
	sym_topk_encode(X, n, dim, D, atoms, M, codes);
	fit = (double)(clock() - t0) / CLOCKS_PER_SEC;
	printf("%-22s%9.1f%%%10.1f\n", "random topk (sparse)",
	       sym_recall(codes, n, M, Q, nq, T, K, at) * 100, fit);

	t0 = clock();
	sym_learn_dict(X, n, dim, atoms, M, iters, 999u, D);
	sym_topk_encode(X, n, dim, D, atoms, M, codes);
	fit = (double)(clock() - t0) / CLOCKS_PER_SEC;
	printf("%-22s%9.1f%%%10.1f\n", "learned topk (sparse)",
	       sym_recall(codes, n, M, Q, nq, T, K, at) * 100, fit);

	puts("------------------------------------------");
	printf("ceiling: full-precision cosine defines the truth, so 100%%\n");

	free(codes); free(D); free(X); free(Q); free(T);
	return 0;
}
