#!/usr/bin/env bash
set -e
echo "==> Compiling contracts..."
cd "$(dirname "$0")/../contracts"
npm run compile
echo "==> Deploying to: ${HARDHAT_NETWORK:-sepolia}"
npm run deploy -- --network "${HARDHAT_NETWORK:-sepolia}"
echo "==> Done. Update .env with the printed addresses."
