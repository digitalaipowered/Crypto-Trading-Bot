# Crypto Trading Bot

Paper-only Alpaca foundation for the Cloudflare Worker `tradingbot`.

## v0.1 safety boundary
- Hard-locks Alpaca trading API to `https://paper-api.alpaca.markets/v2`
- No order-creation endpoint exists
- `/health` is public; all account/data endpoints require `Authorization: Bearer <OWNER_TOKEN>`
- Alpaca API key and secret stay in Cloudflare secrets
- Responses are `no-store`

## Required Cloudflare variables/secrets
Existing:
- `alpaca_api_endpoint` = `https://paper-api.alpaca.markets/v2`
- `alpaca_api_key` (Secret)
- `alpaca_api_secret` (Secret)

Add:
- `OWNER_TOKEN` (Secret): a long random value used only for owner API access.

## Routes
- `GET /health`
- `GET /account`
- `GET /positions`
- `GET /orders`
- `GET /crypto/assets`
- `GET /crypto/quotes?symbols=BTC/USD,ETH/USD`

Automated paper trading is deliberately deferred until this foundation is authenticated and verified.
