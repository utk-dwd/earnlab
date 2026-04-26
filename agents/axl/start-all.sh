#!/usr/bin/env bash
set -e
AXLDIR="$(cd "$(dirname "$0")" && pwd)"
AXL="$AXLDIR/node"
CONFIGS="$AXLDIR/configs"
LOGS="$AXLDIR/logs"
mkdir -p "$LOGS"

if [ ! -f "$AXL" ]; then
  echo "ERROR: AXL binary not found at $AXL"
  exit 1
fi

echo "==> Starting 3 AXL nodes..."

# Kill any existing nodes
for PORT in 9002 9003 9004 7000 7001 7002; do
  lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
done

# Start nodes — cd to axl dir so relative config paths work
cd "$AXLDIR"

"$AXL" -config configs/node-orchestrator.json > logs/orchestrator.log 2>&1 &
echo "  ✓ Orchestrator node (port 9002, tcp 7000) PID=$!"
sleep 1

"$AXL" -config configs/node-agent1.json > logs/agent1.log 2>&1 &
echo "  ✓ Agent1 node      (port 9003, tcp 7001) PID=$!"

"$AXL" -config configs/node-agent2.json > logs/agent2.log 2>&1 &
echo "  ✓ Agent2 node      (port 9004, tcp 7002) PID=$!"

sleep 3

echo ""
echo "==> Fetching public keys..."
ORCH_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('our_public_key',''))" 2>/dev/null || echo "pending")
A1_KEY=$(curl -s http://127.0.0.1:9003/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('our_public_key',''))" 2>/dev/null || echo "pending")
A2_KEY=$(curl -s http://127.0.0.1:9004/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('our_public_key',''))" 2>/dev/null || echo "pending")

echo "  Orchestrator public key: $ORCH_KEY"
echo "  Agent1      public key: $A1_KEY"
echo "  Agent2      public key: $A2_KEY"

cat > "$AXLDIR/keys/public-keys.json" << KEYS
{
  "orchestrator": "$ORCH_KEY",
  "agent1":       "$A1_KEY",
  "agent2":       "$A2_KEY"
}
KEYS

echo ""
echo "✓ Public keys saved to keys/public-keys.json"
echo "  Logs: $AXLDIR/logs/"
