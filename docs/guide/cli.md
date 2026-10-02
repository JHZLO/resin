# Command line

From a clone of the repository, `pnpm resin` compiles one file; see [Quick start](quick-start.md) to set it up.

```text
usage: resin <file.erd> [options]

  (no option)      print the diagram as SVG (needs elkjs)
    --look <look>  graphite (default, no background), or a glass theme:
                   aurora-dark, aurora-light, silk-dark, silk-light,
                   caustic-dark, caustic-light
    --curved       curved connectors instead of right-angled ones
    --keys         show key and reference columns only
    --expand-audit draw audit tables instead of folding them
  --model          print the resolved model as JSON
  --ast            print the syntax tree as JSON
```

## Output

The result goes to standard output, and problems go to standard error in compiler format, so a redirect keeps them apart:

```bash
pnpm resin schema.erd > schema.svg
pnpm resin schema.erd --keys --curved > schema.keys.svg
pnpm resin schema.erd --model > schema.json
```

The SVG is ready to embed with `<img>`: with the default look it picks its ink color from the reader's light or dark theme.

## Exit status

| Status | When |
|---|---|
| `0` | The file compiled, possibly with warnings |
| `1` | There was at least one error; nothing was printed but the problems |
| `2` | The command was wrong: no file, or an unknown look |
