#!/usr/bin/env bash
export PATH=$PATH:/usr/local/go/bin
set -e
AXL_DIR="$HOME/axl"
KEYS_DIR="$(dirname "$0")/keys"

echo "==> Checking Go version..."
GO_VER=$(go version 2>/dev/null | grep -oP 'go\K[0-9]+\.[0-9]+' | head -1)
if [[ -z "$GO_VER" ]]; then
  echo "ERROR: Go not found. Install Go 1.25.x from https://go.dev/dl/"
  exit 1
fi
echo "Go $GO_VER found"

echo "==> Cloning AXL..."
if [ ! -d "$AXL_DIR" ]; then
  git clone https://github.com/gensyn-ai/axl.git "$AXL_DIR"
else
  echo "AXL already cloned at $AXL_DIR"
fi

echo "==> Building AXL node binary..."
cd "$AXL_DIR"
GOTOOLCHAIN=go1.25.5 go build -o node ./cmd/node/ 2>/dev/null || \
  go build -o node ./cmd/node/
echo "✓ Built: $AXL_DIR/node"

# Symlink binary to axl dir for convenience
ln -sf "$AXL_DIR/node" "$(dirname "$0")/node" 2>/dev/null || \
  cp "$AXL_DIR/node" "$(dirname "$0")/node"

echo "==> Generating ed25519 keys..."
mkdir -p "$KEYS_DIR"
for AGENT in orchestrator agent1 agent2; do
  KEY_FILE="$KEYS_DIR/$AGENT.pem"
  if [ ! -f "$KEY_FILE" ]; then
    # Try openssl (Linux) then brew openssl (macOS)
    openssl genpkey -algorithm ed25519 -out "$KEY_FILE" 2>/dev/null || \
    /usr/local/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out "$KEY_FILE" || \
    /opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out "$KEY_FILE"
    echo "✓ Key: $KEY_FILE"
  else
    echo "  Key exists: $KEY_FILE"
  fi
done

echo ""
echo "✓ AXL setup complete!"
echo "  Run: bash agents/axl/start-all.sh"
