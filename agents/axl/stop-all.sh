#!/usr/bin/env bash
for PORT in 9002 9003 9004 7000 7001 7002; do
  lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
done
echo "✓ All AXL nodes stopped"
