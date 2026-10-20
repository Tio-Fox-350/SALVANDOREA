# Compare an environment with the application it came from

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

An environment is only as useful as it is faithful: an agent trained or graded on it should meet the behaviour of the
application it was captured from. REA checks an environment only against its own capture, so nothing says how far it
drifts from the application on calls the capture did not make, after writes, or on errors.

`rea environment-compare` measures that. It takes an environment (a manifest and its capture Evidence) and one or more
**probe captures**, each a recording of one call sequence made against the live application, and reports how many of the
probe's calls the environment answers as the application did, which tools disagree and how.

The command only reads Evidence: it makes no network call. Whoever records the probes drives the application with its own
credentials and resets it between sequences.

## Requirements

- Inputs: the manifest Evidence, its capture Evidence (`--evidence`), and one or more probe capture Evidence files
  (`--probe`, repeatable), each `inspect-web-network-capture` or `capture-browser-scenario` Evidence of one sequence.
- Each probe is one sequence run against a freshly reset application. Before each probe the environment's state is reset,
  so sequences are independent on both sides.
- Requests are taken in the probe's order (start time, then ordinal). A request is matched to the manifest tool of the
  same method whose path template it fits with the most literal segments; format-rule parameters must fit their format.
  Path values, query values the tool takes and a JSON body become the tool's arguments.
- A request no tool matches is reported `no-tool`; a matched tool the environment does not offer, such as a write it
  withholds, is reported `not-served`. Neither is answered.
- Ids differ between a re-seeded application and the capture. The comparison maps them:
  - seeded entities pair across the two answers by a natural key: a field present on every element of both arrays whose
    string values are unique on each side and shared between them;
  - identifier fields (`id`, `uuid`, `guid`, and names ending in `_id`, `Id`, `ID`, `_uuid` or `Uuid`) of paired objects,
    and of the two answers to the same call, map the live value to the environment's value; a create's two answers map
    the new ids. The `id`, `uuid` or `guid` of the answer's own entities also maps within the collection the call names,
    since two collections can reuse a live id for different entities. Outside identifier fields, a string maps when the
    environment's state holds it as an id, and the keys of two objects keyed by ids map when every value pairs;
  - ids are learned only from an answer the environment gave this call, from its state or from a recording of exactly
    these arguments: a recording of another call that replay answers with instead holds other entities;
  - path, query and body values equal to a mapped live id are translated before the environment answers, a path
    parameter by the collection it names, except query values that page a list (`limit`, `offset`, `page` and the
    like), which count items rather than name one.
    A path value the map does not know, and the environment's state does not hold, is reported `unmapped-id`.
- A call is checked against the served tool's input schema first, as the MCP server checks it; a call it refuses is
  reported `refused`. A browser probe keeps its request bodies.
- Answers compare after normalisation: an empty body equals no body; mapped ids compare equal, in scalar sets as well; two clock values (ISO-8601 strings, or epoch numbers under
  time-named fields) compare by format only; two different generated values (both UUIDs, or both of one length and the
  same character classes with a digit) that neither side maps compare equal and are counted. A body over the replay
  limit, text or binary, compares by status only.
- A step agrees when the statuses are equal and the normalised bodies are. Differences are categorised: `status`,
  `missing-field` (the application had it), `extra-field`, `value`, `length`, `order`, `clock-format`, `refused` (the
  environment refused the call), `not-served`, `no-tool` and `unmapped-id`, each with a JSON pointer and short values.
- The report gives agreement overall, per probe and per tool, agreement ignoring item order beside it, the counts per
  category, the ids mapped and the values normalised, and each step's differences (at most 20 per step).

## Non-goals

- No network access, no credentials, no reset of the application: probes are recorded outside REA.
- No generation of call sequences; a later change generates them where the environment disagrees.
- No change to how environments serve.
