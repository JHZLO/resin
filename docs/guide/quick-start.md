# Quick start

The quickest way to try resin is the [playground](https://jhzlo.github.io/resin/playground/): it runs in your browser and needs nothing installed. This page sets resin up on your machine, for schemas you keep in a repository.

## Install

resin is not on npm yet. It needs Node 22.18 or newer, which runs its TypeScript sources directly, and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/JHZLO/resin.git
cd resin
pnpm install
```

## Draw a file

Save a schema as `shop.erd`:

```erd example file=shop.erd
table customers {
  id     bigint        pk
  email  varchar(255)  uk
}

table orders {
  id           bigint    pk
  customer_id  bigint    -> customers
  placed_at    datetime
}
```

Then draw it. resin prints the SVG to standard output:

```bash
pnpm resin shop.erd > shop.svg
pnpm resin shop.erd --look aurora-dark > shop.dark.svg
```

By default the SVG has no background, so it reads on light and dark pages alike. [Command line](cli.md) lists every option.

## When something is wrong

Suppose the reference names a table that is not there:

```erd invalid
table orders {
  id           bigint    pk
  customer_id  bigint    -> customer
  placed_at    datetime
}
```

resin reports it in compiler format, with the line, the column, a pointer to the spot and, most of the time, a hint:

```text
shop.erd:3:29: error: referenced table `customer` is not in this document
  |
3 |   customer_id  bigint    -> customer
  |                             ^^^^^^^^
  = hint: declare it with `external table` if it lives outside this document
```

It keeps reading after an error, so one run reports several. When there is any error it prints no diagram and exits with status 1. [Diagnostics](diagnostics.md) lists the messages.
