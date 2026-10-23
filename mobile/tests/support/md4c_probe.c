/*
 * md4c 对照程序（仅测试用）：编译 react-native-enriched-markdown 自带的同一份 md4c.c，
 * 使用与 App 相同的解析标志（MD4CParser.cpp：NOHTMLSPANS|SPOILERS|TABLES|STRIKETHROUGH|TASKLISTS
 * + latexMath + hardSoftBreaks），把行内结构输出为规范化标记流，供单测与 markdown-it 结果比较。
 *
 * 输入：stdin 中若干条用 \x1e 分隔的 Markdown 文档；输出：每条一行（\x1e 分隔），
 * 只保留 strong/em/del/code/a/math 的开闭标签与文本，块之间用 "|" 分隔，软/硬换行输出为空格。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "md4c.h"

typedef struct { char *buf; size_t len, cap; } Out;

static void put(Out *o, const char *s, size_t n) {
  if (o->len + n + 1 > o->cap) {
    o->cap = (o->len + n + 1) * 2;
    o->buf = realloc(o->buf, o->cap);
  }
  memcpy(o->buf + o->len, s, n);
  o->len += n;
  o->buf[o->len] = 0;
}
static void puts_(Out *o, const char *s) { put(o, s, strlen(s)); }

static int enter_block(MD_BLOCKTYPE t, void *d, void *u) { (void)d; (void)u; (void)t; return 0; }
static int leave_block(MD_BLOCKTYPE t, void *d, void *u) {
  (void)d;
  if (t == MD_BLOCK_P || t == MD_BLOCK_H || t == MD_BLOCK_LI || t == MD_BLOCK_TD || t == MD_BLOCK_TH || t == MD_BLOCK_CODE)
    puts_((Out *)u, "|");
  return 0;
}
static const char *span_name(MD_SPANTYPE t) {
  switch (t) {
    case MD_SPAN_STRONG: return "strong";
    case MD_SPAN_EM: return "em";
    case MD_SPAN_DEL: return "s";
    case MD_SPAN_CODE: return "code";
    case MD_SPAN_A: return "a";
    case MD_SPAN_LATEXMATH: return "math";
    case MD_SPAN_LATEXMATH_DISPLAY: return "math";
    default: return NULL;
  }
}
static int enter_span(MD_SPANTYPE t, void *d, void *u) {
  (void)d;
  const char *n = span_name(t);
  if (n) { puts_((Out *)u, "<"); puts_((Out *)u, n); puts_((Out *)u, ">"); }
  return 0;
}
static int leave_span(MD_SPANTYPE t, void *d, void *u) {
  (void)d;
  const char *n = span_name(t);
  if (n) { puts_((Out *)u, "</"); puts_((Out *)u, n); puts_((Out *)u, ">"); }
  return 0;
}
static int text(MD_TEXTTYPE t, const MD_CHAR *s, MD_SIZE n, void *u) {
  Out *o = (Out *)u;
  if (t == MD_TEXT_BR || t == MD_TEXT_SOFTBR) { puts_(o, " "); return 0; }
  if (t == MD_TEXT_NULLCHAR) return 0;
  if (t == MD_TEXT_ENTITY) { put(o, s, n); return 0; }
  for (MD_SIZE i = 0; i < n; i++) {
    char c = s[i];
    if (c == '\n') c = ' ';
    put(o, &c, 1);
  }
  return 0;
}

int main(void) {
  size_t cap = 1 << 20, len = 0;
  char *in = malloc(cap);
  size_t r;
  while ((r = fread(in + len, 1, cap - len, stdin)) > 0) {
    len += r;
    if (len == cap) { cap *= 2; in = realloc(in, cap); }
  }
  unsigned flags = MD_FLAG_NOHTMLSPANS | MD_FLAG_SPOILERS | MD_FLAG_TABLES | MD_FLAG_STRIKETHROUGH |
                   MD_FLAG_TASKLISTS | MD_FLAG_LATEXMATHSPANS | MD_FLAG_HARD_SOFT_BREAKS;
  MD_PARSER parser = {0, flags, enter_block, leave_block, enter_span, leave_span, text, NULL, NULL};
  size_t start = 0;
  for (size_t i = 0; i <= len; i++) {
    if (i == len || in[i] == '\x1e') {
      Out o = {0};
      puts_(&o, "");
      md_parse(in + start, (MD_SIZE)(i - start), &parser, &o);
      fwrite(o.buf, 1, o.len, stdout);
      fputc('\x1e', stdout);
      free(o.buf);
      start = i + 1;
    }
  }
  return 0;
}
