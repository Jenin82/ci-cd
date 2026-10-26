# Vinext deployment

Keep the Vinext workflows and all six `scripts/vinext` control modules together.
Dispatches and source submodule URLs accept only `Jenin82`; helper downloads
must stay pinned to the central run SHA in `Jenin82/ci-cd`. Source
`wrangler.jsonc` owns destinations and bindings. Preserve build credential
isolation, Worker serialization, Preview verification, and D1 artifact checks.
Preview Durable Object migrations are source-owned SQLite creates only, staging-only; preserve the production rejection and exact artifact/source comparison.
See `docs/vinext-deployment.md`. Check workflow YAML, inline shell syntax,
and JavaScript syntax when updating this runner.

# Django deployment

Mint a fresh Infisical token for each deploy; send it only over SSH stdin and
re-send it on deploy retries. Preserve stdin for migrations and other commands.
Never log credentials/provider bodies or fall back to the droplet's cached token.
