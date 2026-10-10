// Connect Four solver for any board with width * (height + 1) <= 64.
//
// The same file is compiled natively (tools/runs: the board-size table, the counts) and to
// WebAssembly for the page, so the numbers in the README and the moves on screen come from
// one search. No libc: only <stdint.h>, so clang can target wasm32 freestanding.
//
// The search follows Pascal Pons's solver (blog.gamesolver.org): a bitboard with one spare
// bit on top of every column, negamax with alpha-beta, a transposition table that stores
// upper and lower bounds, pruning of moves that hand the opponent a win, moves ordered by
// how many threats they create, and the exact score found by a sequence of null-window
// searches. Scores: a player who wins with their k-th stone scores (cells/2 + 1 - k);
// a draw is 0; a loss is the negative of the opponent's score.

#include <stdint.h>

#ifndef TT_BITS
#define TT_BITS 21
#endif
#define TT_SIZE (1u << TT_BITS)

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#else
#define EXPORT(name)
#endif

static int W = 7, H = 6, CELLS = 42;
static int MIN_SCORE, MAX_SCORE;
static uint64_t BOTTOM, BOARD;
static int ORDER[16];

static uint64_t current;  // stones of the player to move
static uint64_t mask;     // all stones
static int moves;
static uint64_t nodes;
static uint64_t budget;  // 0 = unlimited; otherwise give up after this many nodes
static int aborted;

static uint64_t tt_key[TT_SIZE];
static uint8_t tt_val[TT_SIZE];

static inline uint64_t col_mask(int c) { return ((UINT64_C(1) << H) - 1) << (c * (H + 1)); }
static inline uint64_t top_mask(int c) { return UINT64_C(1) << (H - 1 + c * (H + 1)); }
static inline uint64_t bottom_mask(int c) { return UINT64_C(1) << (c * (H + 1)); }
static inline int popcount(uint64_t x) { return __builtin_popcountll(x); }

EXPORT(c4_clear_tt) void c4_clear_tt(void) {
  for (uint32_t i = 0; i < TT_SIZE; i++) { tt_key[i] = 0; tt_val[i] = 0; }
}

EXPORT(c4_reset) void c4_reset(void) {
  current = mask = 0;
  moves = 0;
}

EXPORT(c4_init) int c4_init(int w, int h) {
  if (w < 1 || h < 1 || w > 16 || w * (h + 1) > 64) return 0;
  W = w; H = h; CELLS = w * h;
  MIN_SCORE = -CELLS / 2 + 3;
  MAX_SCORE = (CELLS + 1) / 2 - 3;
  BOTTOM = BOARD = 0;
  for (int c = 0; c < W; c++) { BOTTOM |= bottom_mask(c); BOARD |= col_mask(c); }
  for (int i = 0; i < W; i++) ORDER[i] = W / 2 + (1 - 2 * (i % 2)) * (i + 1) / 2;
  c4_clear_tt();
  c4_reset();
  nodes = 0;
  return 1;
}

// Cells that would complete four for the stones p, among the empty cells.
static uint64_t winning_cells(uint64_t p, uint64_t m) {
  uint64_t r = (p << 1) & (p << 2) & (p << 3);  // vertical: only ever above
  const int shifts[3] = { H + 1, H, H + 2 };    // horizontal, two diagonals
  for (int i = 0; i < 3; i++) {
    int s = shifts[i];
    uint64_t t = (p << s) & (p << 2 * s);
    r |= t & (p << 3 * s);
    r |= t & (p >> s);
    t = (p >> s) & (p >> 2 * s);
    r |= t & (p << s);
    r |= t & (p >> 3 * s);
  }
  return r & (BOARD ^ m);
}

static inline uint64_t possible(void) { return (mask + BOTTOM) & BOARD; }
static inline uint64_t own_wins(void) { return winning_cells(current, mask); }
static inline uint64_t opp_wins(void) { return winning_cells(current ^ mask, mask); }
static inline int can_win_next(void) { return (own_wins() & possible()) != 0; }

// Moves that do not lose at once: if the opponent threatens two cells we can block only
// one; never fill the cell under an opponent's threat.
static uint64_t non_losing_moves(void) {
  uint64_t pm = possible();
  uint64_t opp = opp_wins();
  uint64_t forced = pm & opp;
  if (forced) {
    if (forced & (forced - 1)) return 0;
    pm = forced;
  }
  return pm & ~(opp >> 1);
}

static inline void play_bit(uint64_t move) {
  current ^= mask;
  mask |= move;
  moves++;
}

static inline uint64_t key(void) { return current + mask; }

static inline uint32_t tt_index(uint64_t k) {
  return (uint32_t)((k * UINT64_C(0x9E3779B97F4A7C15)) >> (64 - TT_BITS));
}

static int negamax(int alpha, int beta) {
  if (budget && nodes >= budget) { aborted = 1; return alpha; }
  nodes++;
  uint64_t next = non_losing_moves();
  if (next == 0) return -(CELLS - moves) / 2;
  if (moves >= CELLS - 2) return 0;

  int lo = -(CELLS - 2 - moves) / 2;
  if (alpha < lo) { alpha = lo; if (alpha >= beta) return alpha; }
  int hi = (CELLS - 1 - moves) / 2;
  if (beta > hi) { beta = hi; if (alpha >= beta) return beta; }

  uint64_t k = key();
  uint32_t idx = tt_index(k);
  if (tt_key[idx] == k && tt_val[idx]) {
    int v = tt_val[idx];
    if (v > MAX_SCORE - MIN_SCORE + 1) {
      lo = v + 2 * MIN_SCORE - MAX_SCORE - 2;
      if (alpha < lo) { alpha = lo; if (alpha >= beta) return alpha; }
    } else {
      hi = v + MIN_SCORE - 1;
      if (beta > hi) { beta = hi; if (alpha >= beta) return beta; }
    }
  }

  // Order: most new threats first, centre columns first among equals.
  uint64_t mv[16];
  int sc[16], n = 0;
  for (int i = 0; i < W; i++) {
    uint64_t m = next & col_mask(ORDER[i]);
    if (!m) continue;
    int s = popcount(winning_cells(current | m, mask));
    int j = n++;
    while (j > 0 && sc[j - 1] < s) { mv[j] = mv[j - 1]; sc[j] = sc[j - 1]; j--; }
    mv[j] = m; sc[j] = s;
  }

  uint64_t sc_cur = current, sc_mask = mask;
  for (int i = 0; i < n; i++) {
    play_bit(mv[i]);
    int score = -negamax(-beta, -alpha);
    current = sc_cur; mask = sc_mask; moves--;
    if (aborted) return alpha;  // nothing half-searched goes into the table
    if (score >= beta) {
      tt_key[idx] = k;
      tt_val[idx] = (uint8_t)(score + MAX_SCORE - 2 * MIN_SCORE + 2);
      return score;
    }
    if (score > alpha) alpha = score;
  }
  tt_key[idx] = k;
  tt_val[idx] = (uint8_t)(alpha - MIN_SCORE + 1);
  return alpha;
}

// Node budget for the next searches (0 = none). After a search, c4_aborted() says whether
// it ran out; entries already in the table stay valid, so a retry resumes the work.
EXPORT(c4_set_budget) void c4_set_budget(double b) { budget = (uint64_t)b; aborted = 0; }
EXPORT(c4_aborted) int c4_aborted(void) { return aborted; }

// Exact score of the current position (weak = 1: only its sign, -1 / 0 / +1).
EXPORT(c4_solve) int c4_solve(int weak) {
  if (can_win_next()) return (CELLS + 1 - moves) / 2;
  if (moves == CELLS) return 0;
  int lo = -(CELLS - moves) / 2, hi = (CELLS + 1 - moves) / 2;
  if (weak) { lo = -1; hi = 1; }
  while (lo < hi) {
    int med = lo + (hi - lo) / 2;
    if (med <= 0 && lo / 2 < med) med = lo / 2;
    else if (med >= 0 && hi / 2 > med) med = hi / 2;
    int r = negamax(med, med + 1);
    if (aborted) return 0;
    if (r <= med) hi = r; else lo = r;
  }
  if (weak) return lo > 0 ? 1 : lo < 0 ? -1 : 0;
  return lo;
}

// One null-window search: is the score of the current position greater than s?
// Two of these pin a score down, which is cheaper than the full sequence in c4_solve.
EXPORT(c4_score_above) int c4_score_above(int s) {
  if (can_win_next()) return (CELLS + 1 - moves) / 2 > s;
  if (moves == CELLS) return 0 > s;
  return negamax(s, s + 1) > s;
}

EXPORT(c4_can_play) int c4_can_play(int c) {
  return c >= 0 && c < W && moves < CELLS && (mask & top_mask(c)) == 0;
}

EXPORT(c4_is_winning_move) int c4_is_winning_move(int c) {
  return (own_wins() & possible() & col_mask(c)) != 0;
}

EXPORT(c4_play) void c4_play(int c) {
  play_bit((mask + bottom_mask(c)) & col_mask(c));
}

EXPORT(c4_moves) int c4_moves(void) { return moves; }
EXPORT(c4_nodes) double c4_nodes(void) { return (double)nodes; }
EXPORT(c4_reset_nodes) void c4_reset_nodes(void) { nodes = 0; }

// Score, for the player to move, of playing column c (weak: sign only). The position is
// left unchanged. Returns -1000 when the column is full.
EXPORT(c4_analyze) int c4_analyze(int c, int weak) {
  if (!c4_can_play(c)) return -1000;
  if (c4_is_winning_move(c)) return weak ? 1 : (CELLS + 1 - moves) / 2;
  uint64_t sc_cur = current, sc_mask = mask;
  c4_play(c);
  int s = -c4_solve(weak);
  current = sc_cur; mask = sc_mask; moves--;
  return s;
}

// Whether the player who just moved has four in a row (the page checks after each move).
EXPORT(c4_last_mover_won) int c4_last_mover_won(void) {
  uint64_t p = current ^ mask;
  const int shifts[4] = { 1, H + 1, H, H + 2 };
  for (int i = 0; i < 4; i++) {
    uint64_t t = p & (p >> shifts[i]);
    if (t & (t >> 2 * shifts[i])) return 1;
  }
  return 0;
}
