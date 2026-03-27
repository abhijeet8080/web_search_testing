# Exa Search API (Node.js + TypeScript)

Small project to test Exa’s Search API using `exa-js`.

## Setup

1. `cd exa-search-test`
2. Ensure you have an Exa API key from the Exa dashboard.
3. Create a `.env` file in this folder with:
   - `EXA_API_KEY=...`

## Run examples

Basic search + highlights:

`npm run search`

Deep search with structured output (`outputSchema`):

`npm run deep`

## Notes

This uses ESM TypeScript (`"type": "module"`) and loads `.env` via `dotenv`.

