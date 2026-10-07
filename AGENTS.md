# Vinext deployment

Keep the Vinext workflows and all six `scripts/vinext` control modules together.
Dispatches and source submodule URLs accept only `Jenin82`; helper downloads
must stay pinned to the central run SHA in `Jenin82/ci-cd`. Source
`wrangler.jsonc` owns destinations and bindings. Preserve build credential
isolation, Worker serialization, Preview verification, and D1 artifact checks.
See `docs/vinext-deployment.md`. Check workflow YAML, inline shell syntax,
and JavaScript syntax when updating this runner.
