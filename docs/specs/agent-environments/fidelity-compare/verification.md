# Verification

Verified commit: 235b22f2 on the write-plan branch at 7056f5ff. Executed on macOS with Node v22.23.1 (the repository
pins 24.18.0 in `.nvmrc`, which was not installed); the live applications ran on six disposable Linux VMs.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint), `npm run format:check`, `npx knip`,
  `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.46% duplicated lines over 3609 files, under the 3.5% gate.
- `npx vitest run --project domain --project services`: 7487 passed, 5 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment-compare, export and serve CLI boundaries, the
  serve MCP boundary and the tool schema validity boundary: 5 files, 30 passed.

New tests: matching, id mapping and translation, pairing guards, normalisation and every category as unit tests
(`environmentCompareIds`, `environmentCompareDiff`, `environmentCompare`, 19 tests), and the command through the built
CLI (`environmentCompareCli`, 2 tests): a probe of the books application re-seeded under other ids agrees on every step
with 2 ids mapped, and a probe that is not capture Evidence is refused with its index.

## Six environments against their live applications

Six published environments were compared with the application each was captured from: NetBox 4.7.3, Komga 1.29.1,
Mealie 3.28.0, n8n 1.123.85, Shlink 5.1.7 and self-hosted Sentry 26.9.0, the same images, brought up and seeded by the
same scripts as for their captures, on loopback. Each was snapshotted after seeding and restored from that snapshot
before every sequence (7 to 80 s), so every sequence met the same application.

A driver outside REA ran three kinds of sequence per application, each starting with the capture's read-only prefix:
the capture re-run in order; per served write type, a list, create, read, update, read, delete, read and list, then a
second create with changed free text; and a read of every seeded entity through its item tool. It translated the
environment's ids to the application's as it learned them, signed in with the application's own credentials, and wrote
each sequence as a HAR without headers or cookies, which `inspect-web-network-capture` turned into probe Evidence. The
environments' manifests use `prefix-variance`, so the comparison ran on a local build of this branch with that rule's
branch merged.

| Environment | Steps | Agreement | Ignoring order | Against its own capture |
| ----------- | ----: | --------: | -------------: | ----------------------: |
| NetBox      |   370 |     99.2% |          99.2% |                    100% |
| Komga       |   356 |     96.9% |          96.9% |                   96.6% |
| Mealie      |   301 |     96.0% |          97.0% |                   97.1% |
| Shlink      |   133 |     89.5% |          92.5% |                   92.4% |
| n8n         |   202 |     74.8% |          87.6% |                   87.5% |
| Sentry      |   230 |     23.9% |          46.5% |                   84.7% |

The last column compares each environment with its own capture as the probe: what it cannot reproduce even of the
session it was built from. The disagreements fall into four groups.

- Environment gaps, the ones to fix:
  - write tools the environment withholds, and the reads after them: readlists (Komga), recipes (Mealie), short URLs
    (Shlink), workflow and tag writes (n8n);
  - preconditions: n8n refuses to delete a workflow that is not archived and the environment deletes it;
  - lists: a create does not appear in a list that keeps its recorded members (Komga), a filtered list is answered
    without the filter (Shlink), a replayed search ignores its body (Komga);
  - a domain-scoped short URL answered without its `domain` parameter, where Shlink answers 404;
  - state rendering: a project field two recorded views disagree on is rendered with one value, and an organisation
    read whose shape depends on a query parameter is answered the same either way (Sentry);
  - a tag read refused for want of the fields its item view always carried (Mealie);
  - time: per-hour event counts move with the current time, while the environment's clock is frozen at the capture
    (Sentry);
  - a field the capture's scrubbing replaced, answered as `"<scrubbed>"` (Sentry).
- The application differing from itself between seedings: Sentry returns permission lists in no fixed order and
  reseeding changed release first-event times, feature lists and profile flags; n8n's executions and NetBox's running
  worker count differ from the captured instance.
- The probe observing itself: Komga and Sentry report the driver's own sign-in user agent.
- Driver gaps: ids the driver never mapped (Mealie units, Sentry events by hash) were sent as the environment's ids.

## What the runs fixed in the comparison

Each live run found a way the comparison itself was wrong, fixed with a test before the next run: requests are matched
to tools in the environment's terms, so a tool whose path holds a seeded id literally matches; ids are learned outside
identifier fields only from strings, after NetBox's worker count of 1 mapped a live 0 to entity 1; items paired only by
position teach ids only when no key is shared and the lengths agree, after a filtered Shlink list mapped one short URL to
another; objects keyed by ids pair their entries (n8n data tables); reordered scalar sets differ in order only and epoch
numbers in arrays are clocks (Sentry); and bodies over the replay limit compare by status.

## After the review round

The branch merged the write-plan branch at b6c3b168 (four serving and gate fixes its review found), then changed the
comparison in nine places: ids are learned only from answers to the call itself and also per collection, paging values
are never translated, calls go through the served tools' input schemas, browser probes keep their request bodies, empty
bodies and large binary bodies compare as the server answers them, scalar sets compare after mapping, and id-keyed
objects pair when some keys overlap. Each new test fails on the previous head. The gates above passed again (domain and
services 7504 passed with 5 pre-existing skips; the focused boundaries 80; conformance; `jscpd` 3.46%). Re-run on the
same probes with this branch and the template rule's merged, the six environments compare exactly as in the table above,
step for step, with the same ids mapped and the same values normalised.
