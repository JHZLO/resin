# Comparing versions

`resin diff` compares two versions of a schema and draws the newer one with what changed marked on it, so a change to a `.erd` file can be reviewed as a picture as well as a text diff.

## From the command line

```bash
pnpm resin diff old.erd new.erd > diff.svg
pnpm resin diff old.erd new.erd --markdown
```

With these two versions:

```erd
table users {
  id     bigint        pk
  email  varchar(255)
}

table orders {
  id       bigint   pk
  user_id  bigint   -> users  index
  status   varchar  enum(PENDING, PAID)
  memo     text?
}
```

```erd
table users {
  id     bigint        pk
  email  varchar(255)  uk
}

table orders {
  id       bigint   pk
  user_id  bigint   -> users  index
  status   varchar  enum(PENDING, PAID, REFUNDED)
}

table refunds {
  id        bigint  pk
  order_id  bigint  -> orders  index
}
```

`--markdown` prints:

```text
- ~ table `users` changed
  - ~ column `email` changed: now unique
- ~ table `orders` changed
  - ~ column `status` changed: values PENDING, PAID → PENDING, PAID, REFUNDED
  - - column `memo` removed
- + table `refunds` added
```

Without it, the command prints the drawing. The drawing options of the command line apply (`--look`, `--keys`, `--names`, `--curved`). An empty file is an empty schema, so comparing with one shows a file that a change adds. When either version has an error, the command prints it and exits with status 1.

## In the drawing

The drawing is the newer version with what is gone put back where it was.

| What | How it is marked |
|---|---|
| A new table | A green border and a `NEW` tag |
| A removed table | A red border and a `REMOVED` tag, drawn faded |
| A changed table | An amber border and a `CHANGED` tag |
| A new, removed or changed column | A bar at the left of its row in the same colors; a removed column is struck through. Its tooltip says what changed: `now NOT NULL`, `type int → bigint` |
| A new, removed or changed connector | Drawn in the same colors, a removed one faded |

A column changes when its type, nullability, keys, encryption, enum values, index, reference or description changes. A table changes when one of its columns does, or its description, group, composite constraints or audit. Generated audit tables are not compared on their own.

## On pull requests

resin is also a GitHub Action. On a pull request that changes `.erd` files, it compares each one with its version on the base branch and keeps one comment on the pull request up to date: the list of changes, the drawing, and a link that opens both versions in the playground.

```yaml
name: Schema diff
on:
  pull_request:
    paths: ["**/*.erd"]
permissions:
  contents: write        # to commit the drawings
  pull-requests: write   # to comment
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: JHZLO/resin@main
```

A comment can only show a picture from an address, so the action commits the drawings to a branch of their own, `resin-diff`, under the pull request's number and head commit. Without permission to write it, as on a pull request from a fork, the comment keeps the list and the link and leaves the drawings out.

| Input | What it does | Default |
|---|---|---|
| `files` | Git pathspecs of the files to compare | `*.erd` |
| `look` | The look of the drawings | `graphite` |
| `branch` | The branch the drawings are committed to | `resin-diff` |
| `playground` | The playground the link opens | resin's own |
| `token` | A token that can write the branch and comment | the workflow's token |

## In the playground

The link in the comment opens the [playground](playground.md) comparing the two versions: the diagram is marked as above, a line under the editor counts the tables added, removed and changed, and the side panel says what happened to each column. The editor holds the newer version; edits are compared with the older one as you type. Stop comparing draws the document alone.

## In code

`diff(before, after)` takes two models and returns `{ model, changes }`: the merged model, which `toSvg` draws with the marks, and the list of changes. `diffMarkdown(changes)` writes the list as above. See [Library](library.md).
