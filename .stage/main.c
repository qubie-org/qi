/* main.c — rim: the ONLY translation unit that touches the outside world.
 *
 * TinyOS enforced this split with a lint rule ("kernel dialect: I/O only in
 * rim.k") and it is worth keeping. hdc.c and bench.c allocate and compute but
 * never read a file, so retargeting to wasm, or linking the kernel into Swift,
 * means replacing this file and nothing else.
 *
 *   ./stage [--root=DIR] [--docs=N] [--keep=BITS] [--qwords=N]
 */
#include "bench.h"
#include "hdc.h"
#include "potion.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>
#include <time.h>

static const char *SKIP[] = {
	"node_modules", ".git", "dist", "build", "target", ".venv", "venv",
	"__pycache__", ".next", "out", ".cache", "vendor", "_archive", ".stage", NULL
};

static int skipped(const char *name)
{
	if (name[0] == '.')
		return 1;
	for (int i = 0; SKIP[i]; i++)
		if (!strcmp(name, SKIP[i]))
			return 1;
	return 0;
}

static void walk(const char *dir, char **paths, size_t *n, size_t cap)
{
	if (*n >= cap)
		return;
	DIR *d = opendir(dir);
	if (!d)
		return;
	struct dirent *e;
	while ((e = readdir(d)) && *n < cap) {
		if (skipped(e->d_name))
			continue;
		char p[4096];
		snprintf(p, sizeof(p), "%s/%s", dir, e->d_name);
		struct stat st;
		if (stat(p, &st))
			continue;
		if (S_ISDIR(st.st_mode)) {
			walk(p, paths, n, cap);
		} else {
			size_t l = strlen(e->d_name);
			if (l > 3 && !strcmp(e->d_name + l - 3, ".md"))
				paths[(*n)++] = strdup(p);
		}
	}
	closedir(d);
}

static int cmp_str(const void *a, const void *b)
{
	return strcmp(*(const char **)a, *(const char **)b);
}

static char *slurp(const char *path, size_t *len)
{
	FILE *f = fopen(path, "rb");
	if (!f)
		return NULL;
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (sz <= 0) { fclose(f); return NULL; }
	char *b = malloc((size_t)sz + 1);
	if (!b) { fclose(f); return NULL; }
	size_t got = fread(b, 1, (size_t)sz, f);
	fclose(f);
	b[got] = 0;
	*len = got;
	return b;
}

static const char *argval(int argc, char **argv, const char *key, const char *dflt)
{
	char pat[64];
	snprintf(pat, sizeof(pat), "--%s=", key);
	size_t l = strlen(pat);
	for (int i = 1; i < argc; i++)
		if (!strncmp(argv[i], pat, l))
			return argv[i] + l;
	return dflt;
}

int main(int argc, char **argv)
{
	char defroot[4096];
	snprintf(defroot, sizeof(defroot), "%s/Apps", getenv("HOME") ? getenv("HOME") : ".");

	const char *root = argval(argc, argv, "root", defroot);
	size_t want = (size_t)atol(argval(argc, argv, "docs", "500"));
	size_t keep = (size_t)atol(argval(argc, argv, "keep", "4096"));
	size_t qwords = (size_t)atol(argval(argc, argv, "qwords", "0"));

	clock_t t0 = clock();

	size_t cap = want * 12, npaths = 0;
	char **paths = malloc(cap * sizeof(char *));
	walk(root, paths, &npaths, cap);
	qsort(paths, npaths, sizeof(char *), cmp_str);

	/* Fixed stride, so the corpus is not one subtree's worth of near-copies. */
	doc_t *docs = malloc(want * sizeof(doc_t));
	size_t ndocs = 0;
	size_t stride = npaths / (want * 2) ? npaths / (want * 2) : 1;
	for (size_t i = 0; i < npaths && ndocs < want; i += stride) {
		size_t len = 0;
		char *text = slurp(paths[i], &len);
		if (!text) continue;
		if (len < 1200) { free(text); continue; }
		docs[ndocs].path = paths[i];
		docs[ndocs].text = text;
		ndocs++;
	}

	trial_t *trials = malloc(ndocs * sizeof(trial_t));
	size_t n = bench_build_trials(docs, ndocs, trials, 25);

	printf("corpus   %zu docs from %s\n", n, root);
	printf("mask     keeping %zu/%d bits (%.0f%%)\n", keep, HDC_D,
	       100.0 * (double)keep / (double)HDC_D);
	if (qwords)
		printf("query    truncated to %zu words\n", qwords);
	printf("loaded in %.1fs — ranking...\n\n", (double)(clock() - t0) / CLOCKS_PER_SEC);

	row_t rows[16];
	size_t nrows = bench_run(trials, n, keep, qwords, rows, 16);

	printf("%-14s%-9s%7s%7s%7s\n", "method", "cond", "top1", "top5", "mrr");
	for (int c = 0; c < 2; c++) {
		const char *want_c = c ? "nopath" : "raw";
		puts("--------------------------------------------");
		for (size_t i = 0; i < nrows; i++)
			if (!strcmp(rows[i].cond, want_c))
				printf("%-14s%-9s%6.1f%%%6.1f%%%6.1f%%\n", rows[i].method,
				       rows[i].cond, rows[i].top1 * 100, rows[i].top5 * 100,
				       rows[i].mrr * 100);
	}
	row_t mrows[8];
	size_t nm = bench_run_multi(trials, n, qwords, 0, mrows, 4);
	nm += bench_run_multi(trials, n, qwords, 3, mrows + nm, 4);
	for (int c = 0; c < 2; c++) {
		const char *want_c = c ? "nopath" : "raw";
		puts("--------------------------------------------");
		for (size_t i = 0; i < nm; i++)
			if (!strcmp(mrows[i].cond, want_c))
				printf("%-14s%-9s%6.1f%%%6.1f%%%6.1f%%\n", mrows[i].method,
				       mrows[i].cond, mrows[i].top1 * 100, mrows[i].top5 * 100,
				       mrows[i].mrr * 100);
	}

	/* potion: same algorithm, same tokenization, learned atoms */
	row_t prows[8];
	size_t npr = 0;
	double cover = 0;
	size_t blen = 0, vlen = 0;
	char pbase[4096];
	snprintf(pbase, sizeof(pbase), "%s/public/models/potion", argval(argc, argv, "toki", "."));
	char pb[4200], pvp[4200];
	snprintf(pb, sizeof(pb), "%s/potion.bin", pbase);
	snprintf(pvp, sizeof(pvp), "%s/potion.vocab.json", pbase);
	char *bin = slurp(pb, &blen), *voc = slurp(pvp, &vlen);
	potion_t *pot = (bin && voc) ? potion_load((const uint8_t *)bin, blen, voc, vlen) : NULL;
	if (pot) {
		npr = bench_run_potion(pot, trials, n, qwords, prows, 8, &cover);
		for (int c = 0; c < 2; c++) {
			const char *want_c = c ? "nopath" : "raw";
			puts("--------------------------------------------");
			for (size_t i = 0; i < npr; i++)
				if (!strcmp(prows[i].cond, want_c))
					printf("%-14s%-9s%6.1f%%%6.1f%%%6.1f%%\n", prows[i].method,
					       prows[i].cond, prows[i].top1 * 100, prows[i].top5 * 100,
					       prows[i].mrr * 100);
		}
	} else {
		puts("\n(potion not loaded — pass --toki=/path/to/toki)");
	}

	puts("--------------------------------------------");
	printf("%-14s%-9s%6.1f%%%6.1f%%\n", "chance", "",
	       100.0 / (double)n, n < 5 ? 100.0 : 500.0 / (double)n);
	if (pot)
		printf("\npotion vocab coverage: %.1f%% of body tokens\n", cover * 100);
	printf("total %.1fs\n", (double)(clock() - t0) / CLOCKS_PER_SEC);
	potion_free(pot); free(bin); free(voc);

	bench_free_trials(trials, n);
	free(trials);
	for (size_t i = 0; i < ndocs; i++) free(docs[i].text);
	free(docs);
	for (size_t i = 0; i < npaths; i++) free(paths[i]);
	free(paths);
	return 0;
}
