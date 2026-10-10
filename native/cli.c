// Native front end to solver.c.
//
//   c4 solve   W H [moves]   value of the position (+ first player wins, = draw, - second)
//   c4 score   W H [moves]   exact score (who wins, and with which stone)
//   c4 first   W H [weak]    value of every first move
//   c4 above   W H moves s   is the exact score (player to move) greater than s? ("-" = no moves)
//
// moves is a string of 1-based columns, e.g. 4453. Output is one JSON object per line.

#define TT_BITS 23
#include "solver.c"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

static int setup(int w, int h, const char *seq) {
  if (!c4_init(w, h)) { fprintf(stderr, "board %dx%d does not fit 64 bits\n", w, h); return 0; }
  for (const char *p = seq; *p; p++) {
    int c = *p - '1';
    if (!c4_can_play(c) || c4_is_winning_move(c)) { fprintf(stderr, "bad move %c\n", *p); return 0; }
    c4_play(c);
  }
  return 1;
}

// The value as the first player sees it, from a score for the player to move.
static char value(int s) {
  if (c4_moves() % 2) s = -s;
  return s > 0 ? '+' : s < 0 ? '-' : '=';
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: c4 solve|score|first W H [moves|weak]\n");
    return 2;
  }
  const char *mode = argv[1];
  int w = atoi(argv[2]), h = atoi(argv[3]);
  const char *seq = argc > 4 && strcmp(mode, "first") ? argv[4] : "";
  if (!strcmp(seq, "-")) seq = "";
  if (!setup(w, h, seq)) return 1;

  double t0 = now();
  if (!strcmp(mode, "solve") || !strcmp(mode, "score")) {
    int weak = !strcmp(mode, "solve");
    int s = c4_solve(weak);
    printf("{\"mode\":\"%s\",\"w\":%d,\"h\":%d,\"moves\":\"%s\",\"score\":%d,\"value\":\"%c\","
           "\"nodes\":%llu,\"seconds\":%.3f}\n",
           mode, w, h, seq, s, value(s), (unsigned long long)nodes, now() - t0);
  } else if (!strcmp(mode, "above") && argc > 5) {
    int s = atoi(argv[5]);
    int above = c4_score_above(s);
    printf("{\"mode\":\"above\",\"w\":%d,\"h\":%d,\"moves\":\"%s\",\"s\":%d,\"above\":%s,"
           "\"nodes\":%llu,\"seconds\":%.3f}\n",
           w, h, seq, s, above ? "true" : "false", (unsigned long long)nodes, now() - t0);
  } else if (!strcmp(mode, "first")) {
    int weak = argc > 4 ? atoi(argv[4]) : 1;
    printf("{\"mode\":\"first\",\"w\":%d,\"h\":%d,\"weak\":%d,\"columns\":[", w, h, weak);
    for (int c = 0; c < w; c++) {
      int s = c4_analyze(c, weak);
      printf("%s%d", c ? "," : "", s);
      fflush(stdout);
    }
    printf("],\"nodes\":%llu,\"seconds\":%.3f}\n", (unsigned long long)nodes, now() - t0);
  } else {
    fprintf(stderr, "unknown mode %s\n", mode);
    return 2;
  }
  return 0;
}
