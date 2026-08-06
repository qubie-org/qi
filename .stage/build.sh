#!/bin/sh
# No bun, no node, no python. Just clang.
set -e
cd "$(dirname "$0")"
clang -O2 -std=c11 -Wall -Wextra -o stage hdc.c bench.c potion.c main.c -lm
echo "built ./stage"
