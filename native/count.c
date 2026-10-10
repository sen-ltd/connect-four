// Counts the positions that can occur in a game of Connect Four on a W x H board.
//
//   count total  W H threads [play-on]   every reachable position, by number of stones
//                                        (env C4_LIMIT: refuse bitmaps above that many bytes)
//   count levels W H maxply              breadth first, ply by ply, up to maxply
//
// "Reachable" means: stones alternate, first player first, gravity holds, and nobody moves
// after four in a row. With play-on, the game goes on after a win (only the board filling
// up ends it) — the convention that does not reproduce the published counts.
//
// total marks positions in a bitmap. The index uses the fact that the colours are not free:
// with k stones down, the first player owns exactly ceil(k/2) of them. So a position is
// (column heights, which ceil(k/2) of the k stones are the first player's), and the index is
// an offset per height vector plus the rank of that subset in the combinatorial number
// system — 6.0x to 6.7x smaller than giving every column all 2^(H+1) - 1 contents, which
// is what lets 4 x 8 and 6 x 5 fit in about 1.3 GB. Threads run depth-first searches from a
// shared frontier and claim positions with an atomic OR; whoever claims one expands it.
// levels keeps one hash set per ply instead (7 x 6), keyed by the plain mixed-radix rank:
// a column with k stones is 2^k + (first player's stones, bottom = bit 0).

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <time.h>

static int W, H, CELLS, PLAY_ON;
static uint64_t BASE, POW[16], BOARD, BOTTOM;
static uint64_t *bitmap;
static uint64_t BINOM[65][66];
static uint64_t *OFFSET;  // per height vector (base H + 1, column 0 most significant)

typedef struct { uint64_t a, m; } Pos;  // first player's stones, all stones

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

static inline uint64_t col_bits(int c) { return ((UINT64_C(1) << H) - 1) << (c * (H + 1)); }

static inline int four(uint64_t p) {
  const int s[4] = { 1, H + 1, H, H + 2 };
  for (int i = 0; i < 4; i++) {
    uint64_t t = p & (p >> s[i]);
    if (t & (t >> 2 * s[i])) return 1;
  }
  return 0;
}

static inline uint64_t rank_of(Pos p) {
  uint64_t r = 0;
  for (int c = 0; c < W; c++) {
    int sh = c * (H + 1);
    uint64_t col = (p.m >> sh) & ((UINT64_C(1) << H) - 1);
    int k = __builtin_popcountll(col);
    uint64_t code = (UINT64_C(1) << k) | ((p.a >> sh) & ((UINT64_C(1) << k) - 1));
    r += (code - 1) * POW[c];
  }
  return r;
}

// Bitmap index (see the top of the file).
static inline uint64_t index_of(Pos p) {
  uint64_t hv = 0, cr = 0;
  int bit = 0, ones = 0;
  for (int c = 0; c < W; c++) {
    int sh = c * (H + 1);
    int k = __builtin_popcountll((p.m >> sh) & ((UINT64_C(1) << H) - 1));
    hv = hv * (H + 1) + k;
    uint64_t a = p.a >> sh;
    for (int r = 0; r < k; r++, bit++)
      if ((a >> r) & 1) cr += BINOM[bit][++ones];
  }
  return OFFSET[hv] + cr;
}

static uint64_t index_init(void) {
  for (int n = 0; n <= 64; n++) {
    BINOM[n][0] = 1;
    for (int k = 1; k <= n + 1; k++) BINOM[n][k] = n ? BINOM[n - 1][k - 1] + (k <= n - 1 ? BINOM[n - 1][k] : 0) : 0;
  }
  uint64_t nhv = 1;
  for (int c = 0; c < W; c++) nhv *= H + 1;
  OFFSET = malloc(nhv * 8);
  uint64_t off = 0;
  for (uint64_t v = 0; v < nhv; v++) {
    int k = 0;
    for (uint64_t x = v; x; x /= H + 1) k += x % (H + 1);
    OFFSET[v] = off;
    off += BINOM[k][(k + 1) / 2];
  }
  return off;
}

// Is the game over in p (ply stones on the board)? The last mover may have just won.
static inline int over(Pos p, int ply) {
  if (ply == CELLS) return 1;
  if (PLAY_ON || ply < 7) return 0;
  return four(ply % 2 ? p.a : p.a ^ p.m);
}

static inline int child(Pos p, int ply, int c, Pos *out) {
  uint64_t move = (p.m + BOTTOM) & col_bits(c);
  if (!move) return 0;
  out->m = p.m | move;
  out->a = ply % 2 == 0 ? p.a | move : p.a;
  return 1;
}

// ---------------------------------------------------------------- total (bitmap, threads)

static inline int claim(uint64_t r) {
  uint64_t bit = UINT64_C(1) << (r & 63);
  if (__atomic_load_n(&bitmap[r >> 6], __ATOMIC_RELAXED) & bit) return 0;
  return !(__atomic_fetch_or(&bitmap[r >> 6], bit, __ATOMIC_RELAXED) & bit);
}

typedef struct { Pos p; int ply; } Node;
static Node *frontier;
static size_t nfrontier, next_root;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
typedef struct { uint64_t by_ply[65]; } Counts;

static void dfs(Pos p, int ply, Counts *cnt) {
  if (over(p, ply)) return;
  for (int c = 0; c < W; c++) {
    Pos q;
    if (!child(p, ply, c, &q)) continue;
    if (!claim(index_of(q))) continue;
    cnt->by_ply[ply + 1]++;
    dfs(q, ply + 1, cnt);
  }
}

static void *worker(void *arg) {
  Counts *cnt = arg;
  for (;;) {
    pthread_mutex_lock(&lock);
    size_t i = next_root < nfrontier ? next_root++ : (size_t)-1;
    pthread_mutex_unlock(&lock);
    if (i == (size_t)-1) return NULL;
    dfs(frontier[i].p, frontier[i].ply, cnt);
  }
}

static int total(int threads) {
  uint64_t states = index_init();
  size_t words = (size_t)((states + 63) / 64);
  const char *lim = getenv("C4_LIMIT");
  if (lim && (double)words * 8 > atof(lim)) {
    printf("{\"mode\":\"total\",\"w\":%d,\"h\":%d,\"playOn\":%d,\"skipped\":\"bitmap of %zu bytes\"}\n", W, H, PLAY_ON, words * 8);
    return 0;
  }
  bitmap = calloc(words, 8);
  if (!bitmap) { fprintf(stderr, "cannot allocate %zu bytes\n", words * 8); return 1; }
  double t0 = now();

  // Breadth first until the frontier is wide enough to share out.
  Counts base = { { 0 } };
  Node *cur = malloc(sizeof(Node)), *nxt;
  size_t ncur = 1, cap = 1;
  cur[0] = (Node){ { 0, 0 }, 0 };
  claim(index_of(cur[0].p));
  base.by_ply[0] = 1;
  while (ncur < (size_t)threads * 256 && cur[0].ply < CELLS) {
    cap = ncur * W;
    nxt = malloc(cap * sizeof(Node));
    size_t n = 0;
    for (size_t i = 0; i < ncur; i++) {
      if (over(cur[i].p, cur[i].ply)) continue;
      for (int c = 0; c < W; c++) {
        Pos q;
        if (!child(cur[i].p, cur[i].ply, c, &q) || !claim(index_of(q))) continue;
        nxt[n++] = (Node){ q, cur[i].ply + 1 };
        base.by_ply[cur[i].ply + 1]++;
      }
    }
    free(cur);
    cur = nxt; ncur = n;
    if (!n) break;
  }
  frontier = cur; nfrontier = ncur; next_root = 0;

  pthread_t tid[64];
  Counts *cnt = calloc(threads, sizeof(Counts));
  for (int t = 0; t < threads; t++) pthread_create(&tid[t], NULL, worker, &cnt[t]);
  for (int t = 0; t < threads; t++) pthread_join(tid[t], NULL);

  uint64_t sum = 0;
  printf("{\"mode\":\"total\",\"w\":%d,\"h\":%d,\"playOn\":%d,\"byPly\":[", W, H, PLAY_ON);
  for (int k = 0; k <= CELLS; k++) {
    uint64_t v = base.by_ply[k];
    for (int t = 0; t < threads; t++) v += cnt[t].by_ply[k];
    sum += v;
    printf("%s%llu", k ? "," : "", (unsigned long long)v);
  }
  printf("],\"total\":%llu,\"bitmapBytes\":%zu,\"threads\":%d,\"seconds\":%.1f}\n",
         (unsigned long long)sum, words * 8, threads, now() - t0);
  return 0;
}

// ---------------------------------------------------------------- levels (hash sets)

// One open-addressing set of ranks per ply; the next ply is generated from the current one
// decoded back into bitboards, so only ranks are ever stored.
typedef struct { uint64_t *slot; size_t cap, n; } Set;

static void set_init(Set *s, size_t cap) {
  s->cap = cap; s->n = 0;
  s->slot = malloc(cap * 8);
  memset(s->slot, 0xff, cap * 8);
}

static void set_put(Set *s, uint64_t r);

static void set_grow(Set *s) {
  Set t;
  set_init(&t, s->cap * 2);
  for (size_t i = 0; i < s->cap; i++)
    if (s->slot[i] != UINT64_MAX) set_put(&t, s->slot[i]);
  free(s->slot);
  *s = t;
}

static void set_put(Set *s, uint64_t r) {
  if (s->n * 10 >= s->cap * 7) set_grow(s);
  size_t i = (size_t)((r * UINT64_C(0x9E3779B97F4A7C15)) >> 20) & (s->cap - 1);
  while (s->slot[i] != UINT64_MAX) {
    if (s->slot[i] == r) return;
    i = (i + 1) & (s->cap - 1);
  }
  s->slot[i] = r;
  s->n++;
}

static Pos unrank(uint64_t r) {
  Pos p = { 0, 0 };
  for (int c = 0; c < W; c++) {
    uint64_t code = (r / POW[c]) % BASE + 1;
    int k = 63 - __builtin_clzll(code);
    int sh = c * (H + 1);
    p.m |= ((UINT64_C(1) << k) - 1) << sh;
    p.a |= (code & ((UINT64_C(1) << k) - 1)) << sh;
  }
  return p;
}

static int levels(int maxply) {
  double t0 = now();
  uint64_t *cur = malloc(8);
  size_t ncur = 1;
  cur[0] = 0;
  printf("{\"mode\":\"levels\",\"w\":%d,\"h\":%d,\"byPly\":[1", W, H);
  fflush(stdout);
  for (int ply = 0; ply < maxply && ply < CELLS; ply++) {
    size_t cap = 1024;
    while (cap * 7 < ncur * 30) cap <<= 1;
    Set s;
    set_init(&s, cap);
    for (size_t i = 0; i < ncur; i++) {
      Pos p = unrank(cur[i]);
      if (over(p, ply)) continue;
      for (int c = 0; c < W; c++) {
        Pos q;
        if (child(p, ply, c, &q)) set_put(&s, rank_of(q));
      }
    }
    free(cur);
    cur = malloc(s.n * 8 + 8);
    ncur = 0;
    for (size_t i = 0; i < s.cap; i++)
      if (s.slot[i] != UINT64_MAX) cur[ncur++] = s.slot[i];
    free(s.slot);
    printf(",%zu", ncur);
    fflush(stdout);
  }
  printf("],\"seconds\":%.1f}\n", now() - t0);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: count total W H threads [play-on] | count levels W H maxply\n");
    return 2;
  }
  W = atoi(argv[2]); H = atoi(argv[3]); CELLS = W * H;
  if (W < 1 || H < 1 || W * (H + 1) > 64) { fprintf(stderr, "board too large\n"); return 2; }
  BASE = (UINT64_C(1) << (H + 1)) - 1;
  POW[0] = 1;
  for (int c = 1; c < W; c++) POW[c] = POW[c - 1] * BASE;
  for (int c = 0; c < W; c++) { BOTTOM |= UINT64_C(1) << (c * (H + 1)); BOARD |= col_bits(c); }
  if (!strcmp(argv[1], "total")) {
    PLAY_ON = argc > 5 && !strcmp(argv[5], "play-on");
    return total(atoi(argv[4]));
  }
  if (!strcmp(argv[1], "levels")) return levels(atoi(argv[4]));
  fprintf(stderr, "unknown mode %s\n", argv[1]);
  return 2;
}
