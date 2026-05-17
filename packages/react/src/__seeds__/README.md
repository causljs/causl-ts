# `__seeds__` — regression-seed records for property suites

This directory carries shrunken counterexamples from `fast-check`
property runs across the React adapter. Each `<label>.json` file is a
deterministic record loaded by the property suite before its random
trials, so a CI failure that produced a counterexample is reproducible
across every subsequent run (SPEC §15.2 reproducibility floor).

## Format

```json
{
  "$schema": "./<label>.schema.json",
  "description": "...",
  "seeds": [
    { "label": "<short-name>", "seed": <integer>, "comment": "<rationale>" }
  ]
}
```

## Why `src/__seeds__/` and not `test/__seeds__/`

Seeds are first-class artefacts that travel with the package — they
encode the failure history of contracted invariants. Putting them in
`src/` keeps them inside the source tree the test seam already treats
as canonical (`@causljs/react`), and prevents bundlers from chasing
them as test-only fixtures.

## Adding a seed

When a property test fails in CI, fast-check logs the shrunk seed.
Add an entry to the relevant `<label>.json` here, with a one-line
`comment` describing what failure it pins. Do not rotate or delete
seeds without first removing the regression they cover from the test
list — they are the only record we have that the bug existed.
