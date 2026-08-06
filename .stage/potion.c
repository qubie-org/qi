#include "potion.h"
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>

struct potion {
	int dim;
	int n;
	float scale;
	const int8_t *q;   /* n * dim, borrowed -> copied below */
	int8_t *own;
	char **words;
	int32_t *bucket;   /* open-addressed index into words, -1 empty */
	size_t mask;
};

static uint64_t hash_word(const char *s, size_t n)
{
	uint64_t h = 1469598103934665603ull;
	for (size_t i = 0; i < n; i++) {
		h ^= (unsigned char)s[i];
		h *= 1099511628211ull;
	}
	return h;
}

/* Minimal parser for a flat JSON array of strings. Handles \" \\ \/ \n \t \u.
 * Enough for potion.vocab.json and nothing more. */
static char **parse_vocab(const char *s, size_t len, int *out_n)
{
	size_t cap = 4096, n = 0;
	char **v = malloc(cap * sizeof(char *));
	if (!v)
		return NULL;
	size_t i = 0;
	while (i < len && s[i] != '[')
		i++;
	i++;
	char buf[512];
	while (i < len) {
		while (i < len && (isspace((unsigned char)s[i]) || s[i] == ','))
			i++;
		if (i >= len || s[i] == ']')
			break;
		if (s[i] != '"')
			break;
		i++;
		size_t bl = 0;
		while (i < len && s[i] != '"' && bl < sizeof(buf) - 1) {
			if (s[i] == '\\' && i + 1 < len) {
				i++;
				char c = s[i++];
				switch (c) {
				case 'n': buf[bl++] = '\n'; break;
				case 't': buf[bl++] = '\t'; break;
				case 'r': buf[bl++] = '\r'; break;
				case 'b': buf[bl++] = '\b'; break;
				case 'f': buf[bl++] = '\f'; break;
				case 'u': {
					unsigned cp = 0;
					for (int k = 0; k < 4 && i < len; k++) {
						char h = s[i++];
						cp = cp * 16 + (unsigned)(h <= '9' ? h - '0'
						            : (h | 32) - 'a' + 10);
					}
					/* UTF-8 encode; vocab entries are short so BMP is enough */
					if (cp < 0x80) {
						buf[bl++] = (char)cp;
					} else if (cp < 0x800) {
						buf[bl++] = (char)(0xC0 | (cp >> 6));
						buf[bl++] = (char)(0x80 | (cp & 0x3F));
					} else {
						buf[bl++] = (char)(0xE0 | (cp >> 12));
						buf[bl++] = (char)(0x80 | ((cp >> 6) & 0x3F));
						buf[bl++] = (char)(0x80 | (cp & 0x3F));
					}
					break;
				}
				default: buf[bl++] = c;
				}
			} else {
				buf[bl++] = s[i++];
			}
		}
		i++; /* closing quote */
		buf[bl] = 0;
		if (n == cap) {
			cap *= 2;
			char **nv = realloc(v, cap * sizeof(char *));
			if (!nv) { free(v); return NULL; }
			v = nv;
		}
		v[n] = malloc(bl + 1);
		if (!v[n]) break;
		memcpy(v[n], buf, bl + 1);
		n++;
	}
	*out_n = (int)n;
	return v;
}

potion_t *potion_load(const uint8_t *bin, size_t binlen,
                      const char *vocab_json, size_t vlen)
{
	if (binlen < 16 || memcmp(bin, "PTN1", 4) != 0)
		return NULL;
	uint32_t n, dim;
	float scale;
	memcpy(&n, bin + 4, 4);
	memcpy(&dim, bin + 8, 4);
	memcpy(&scale, bin + 12, 4);
	if (binlen < 16 + (size_t)n * dim)
		return NULL;

	potion_t *p = calloc(1, sizeof(*p));
	if (!p)
		return NULL;
	p->dim = (int)dim;
	p->n = (int)n;
	p->scale = scale;
	p->own = malloc((size_t)n * dim);
	if (!p->own) { free(p); return NULL; }
	memcpy(p->own, bin + 16, (size_t)n * dim);
	p->q = p->own;

	int vn = 0;
	p->words = parse_vocab(vocab_json, vlen, &vn);
	if (!p->words || vn != (int)n) { potion_free(p); return NULL; }

	size_t sz = 1;
	while (sz < (size_t)n * 2)
		sz <<= 1;
	p->mask = sz - 1;
	p->bucket = malloc(sz * sizeof(int32_t));
	if (!p->bucket) { potion_free(p); return NULL; }
	for (size_t i = 0; i < sz; i++)
		p->bucket[i] = -1;
	for (int i = 0; i < (int)n; i++) {
		size_t h = hash_word(p->words[i], strlen(p->words[i])) & p->mask;
		while (p->bucket[h] != -1)
			h = (h + 1) & p->mask;
		p->bucket[h] = i;
	}
	return p;
}

void potion_free(potion_t *p)
{
	if (!p)
		return;
	if (p->words)
		for (int i = 0; i < p->n; i++)
			free(p->words[i]);
	free(p->words);
	free(p->bucket);
	free(p->own);
	free(p);
}

int potion_dim(const potion_t *p) { return p->dim; }

int potion_lookup(const potion_t *p, const char *word, size_t len)
{
	size_t h = hash_word(word, len) & p->mask;
	while (p->bucket[h] != -1) {
		int i = p->bucket[h];
		if (strlen(p->words[i]) == len && !memcmp(p->words[i], word, len))
			return i;
		h = (h + 1) & p->mask;
	}
	return -1;
}

int potion_encode(const potion_t *p, const char *text, float *out,
                  size_t *hits, size_t *total)
{
	memset(out, 0, (size_t)p->dim * sizeof(float));
	size_t found = 0, seen = 0;
	const char *c = text;
	char buf[128];
	while (*c) {
		while (*c && !isalnum((unsigned char)*c))
			c++;
		if (!*c)
			break;
		size_t l = 0;
		while (*c && isalnum((unsigned char)*c) && l < sizeof(buf) - 1)
			buf[l++] = (char)tolower((unsigned char)*c++);
		while (*c && isalnum((unsigned char)*c))
			c++;
		seen++;
		int r = potion_lookup(p, buf, l);
		if (r < 0)
			continue;
		found++;
		const int8_t *row = p->q + (size_t)r * p->dim;
		for (int d = 0; d < p->dim; d++)
			out[d] += (float)row[d];
	}
	if (hits) *hits = found;
	if (total) *total = seen;
	if (!found)
		return 0;
	float norm = 0;
	for (int d = 0; d < p->dim; d++)
		norm += out[d] * out[d];
	norm = sqrtf(norm);
	if (norm > 0)
		for (int d = 0; d < p->dim; d++)
			out[d] /= norm;
	return 1;
}

float potion_dot(const float *a, const float *b, int dim)
{
	float s = 0;
	for (int d = 0; d < dim; d++)
		s += a[d] * b[d];
	return s;
}
