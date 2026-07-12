# Swamp Extensions

Extensions for [swamp](https://github.com/swamp-club/swamp) providing model integrations for swamp club.

## Model Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@whitemars/cinc`](cinc/) | Read-only Chef/CINC administration via the `knife` CLI — node check-in status, node detail, search, package inventory, and (via knife-acl) group/ACL inspection | None (shells out to `knife`/`cinc-knife`) |

## Installation

Extensions are installed automatically when referenced in a swamp repository
(via [auto-resolution](https://github.com/swamp-club/swamp/pull/725)), or
manually with:

```bash
# Model extensions
swamp extension pull @whitemars/cinc
```

## Usage

### Chef/CINC administration

```bash
swamp extension pull @whitemars/cinc

# Direct execution (no persisted definition needed)
swamp model @whitemars/cinc method run status cinc

# Or create a managed instance
swamp model create @whitemars/cinc cinc \
  --global-arg knifeBinary=cinc-knife \
  --global-arg knifeConfigPath=/home/me/.chef/knife.rb

# knife status — health of every node (ok / stale / critical / never_converged)
swamp model method run cinc status

# knife node show — detail for one node
swamp model method run cinc show --input nodeName=web01

# knife search — query any index (default: node)
swamp model method run cinc search --input query='policy_group:union'
```

See the [`@whitemars/cinc` README](cinc/) for the full method reference,
configuration arguments, and the `knife-acl` prerequisites for group/ACL
inspection.

## Development

Each extension is a standalone swamp repository with its own manifest. All npm
dependencies are pinned to exact versions for reproducible builds.

```bash
# Model extension example
cd cinc
deno check extensions/models/cinc/cinc.ts
deno lint extensions/models/
deno fmt extensions/models/
deno test extensions/
```

## Publishing

Extensions are published to the [swamp.club registry](https://swamp.club). Each
directory containing a `manifest.yaml` is a publishable extension.

```bash
cd cinc  # or any extension directory
swamp extension push manifest.yaml
```

## License

Each extension carries its own `LICENSE.md`, bundled and published
independently to the registry.
