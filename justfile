# Format and apply safe lint fixes.
fix:
    npx biome check --write .

# Lint, check formatting, and typecheck.
lint:
    npx biome check .
    npm run typecheck

test:
    npm test

# Everything CI runs.
ci: lint test
