# Extending: adding a third source

The tutorial ships with two sources — `weather` and `crypto` — deliberately, to keep the
example small. Adding a third (say, a daily quote, or a stock price) touches exactly three
places.

## 1. The schema's closed vocabulary

In `src/db/schema.ts`, add the new name to `SOURCE_NAMES`:

```typescript
export const SOURCE_NAMES = ['weather', 'crypto', 'quote'] as const;
```

The `CHECK` constraint in `AGENT_DDL` is generated from a literal SQL string, not from
`SOURCE_NAMES` — update it too:

```sql
CONSTRAINT chk_name CHECK (name IN ('weather', 'crypto', 'quote'))
```

This is a deliberate lack of DRY: SQLite's `CHECK` clause can't reference a TypeScript
array at schema-application time, and generating SQL from the array would obscure exactly
the constraint a reader most needs to see when debugging a rejected insert. Keep the two
lists next to each other and change them together.

## 2. A `SourceFetcher`

Add `src/sources/quote.ts`:

```typescript
import type { SourceFetcher } from './types.js';

export function createQuoteFetcher(): SourceFetcher {
  return {
    name: 'quote',
    async fetch() {
      const response = await fetch('https://api.example.com/quote-of-the-day');
      if (!response.ok) {
        throw new Error(`quote API responded ${response.status}`);
      }
      const json = (await response.json()) as { quote?: string };
      if (json.quote === undefined) {
        throw new Error('quote API response missing quote field');
      }
      return json.quote;
    },
  };
}
```

Register it in `src/sources/index.ts`'s `switch` statement.

## 3. Nothing else

`src/agent/fetch.ts`, `src/format/*`, `src/agent/status.ts`, and `infra/stack.ts` all
operate on `SourceName` generically — none of them special-case `'weather'` or `'crypto'`
by name. Once the schema and the fetcher exist, `SOURCES='["weather","crypto","quote"]'`
(or the equivalent env var on the deployed function) picks up the new source with no
further code changes. That genericity is why the closed vocabulary lives in exactly one
place instead of being re-validated at every call site.

## What this tutorial deliberately doesn't support

A source registry, plugin system, or dynamic configuration of *which* sources exist at
runtime — see the design spec's §8 ("Out of scope"). Three sources or thirty, the pattern
is the same: edit the constraint, add a fetcher, register it. A registry would only pay
for itself past the point where "edit two files" stops being fast enough, and this
tutorial's job is to teach the storage pattern, not to anticipate that scale.
