# EarnYld Yield Optimizer Template

A reusable KeeperHub workflow template that fetches top Uniswap v4 yield opportunities from an EarnYld agent and delivers them to your preferred notification channel.

## What it does

1. **Triggers** on a schedule (default: every 15 minutes) or manually
2. **Fetches** ranked yield opportunities from EarnYld via HTTP GET
3. **Checks** if any results matched your criteria
4. **Notifies** you with the top yields, or a "no results" message
5. **Alerts** on API errors so you know if EarnYld is unreachable

## Inputs

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `earnlabBaseUrl` | string | yes | `http://localhost:3001` | URL of the EarnYld agent API |
| `chainId` | number | no | — | Filter to a specific chain (e.g. `1` for Ethereum, `8453` for Base) |
| `network` | string | no | `all` | `mainnet`, `testnet`, or `all` |
| `minAPY` | number | yes | `5` | Minimum APY threshold (%) |
| `limit` | number | no | `5` | Max number of opportunities to fetch |
| `notifyProvider` | string | yes | — | `discord`, `telegram`, or `webhook` |
| `notifyTarget` | string | yes | — | Webhook URL, Discord webhook URL, or Telegram chat ID |

## How to use

### Via KeeperHub UI
1. Go to **Workflows > Import**
2. Upload `earnYld-yield-optimizer.json`
3. Fill in the input values
4. Enable the workflow

### Via KeeperHub CLI
```bash
kh template deploy earnYld-yield-optimizer.json \
  --input earnlabBaseUrl=http://localhost:3001 \
  --input minAPY=10 \
  --input limit=3 \
  --input notifyProvider=discord \
  --input notifyTarget=https://discord.com/api/webhooks/...
```

## Customizing the schedule

Edit the trigger node config in the JSON:
```json
"config": {
  "triggerType": "Schedule",
  "cron": "*/15 * * * *"
}
```

Change the `cron` expression to any valid cron schedule. For example:
- `0 * * * *` — every hour
- `0 9 * * *` — every day at 9 AM
- `*/5 * * * *` — every 5 minutes

Or change `triggerType` to `"Manual"` to only run on-demand.

## Requirements

- An EarnYld agent API running and accessible at `earnlabBaseUrl`
- A valid `notifyTarget` for your chosen provider

## See also

- [EarnYld documentation](../../../README.md)
- [KeeperHub Webhook Plugin docs](https://docs.keeperhub.com/plugins/webhook)
