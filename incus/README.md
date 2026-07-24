# @whitemars/incus

A swamp model for **container and VM lifecycle** on an [Incus](https://linuxcontainers.org/incus/)
daemon, driven through the local **`incus`** CLI. Create, start, stop, restart,
and delete instances, and sync a full inventory of what's running.

One model instance targets one daemon/project pair. Mutating methods re-query
the affected instance afterwards and persist its fresh state, so downstream CEL
expressions read live data without a separate `sync`.

Commands run via argv arrays (never a shell), so shell metacharacters carry no
meaning. Instance, remote, project, and profile names are additionally
validated against Incus's allowed character set — which also rejects values
beginning with `-` that could otherwise be mistaken for flags.

## Prerequisites

- **`incus` on PATH**, configured to reach your daemon. The model shells out to
  it; it does not speak the Incus API directly. Verify with `incus list`.
- For a **remote** daemon, the remote must already be registered
  (`incus remote add …`) and reachable. Passing `remote=""` (the default)
  targets the local daemon.

## Configuration

Global arguments (all optional):

| Arg       | Default   | Purpose                                                          |
| --------- | --------- | ---------------------------------------------------------------- |
| `remote`  | `""`      | Incus remote name; empty targets the local daemon (e.g. `prod`). |
| `project` | `default` | Incus project the instances live in.                             |

```bash
# Direct execution (no persisted definition needed)
swamp model @whitemars/incus method run sync incus

# Or create a managed instance pinned to a remote/project
swamp model create @whitemars/incus incus \
  --global-arg remote=prod \
  --global-arg project=web
```

## Usage

```bash
# Inventory: one `container` resource per instance plus a `summary` roll-up
swamp model method run incus sync
swamp data get incus summary --json         # counts by status + instance names

# Create and start from an image
swamp model method run incus launch --input name=web01 --input image=images:debian/12
swamp model method run incus launch --input name=vm01 --input image=ubuntu:24.04 --input vm=true

# Launch with profiles and config overrides
swamp model method run incus launch \
  --input name=api01 --input image=images:debian/12 \
  --input profiles='["default","web"]' \
  --input config='["limits.cpu=2","limits.memory=2GiB"]'

# Lifecycle
swamp model method run incus start   --input name=web01
swamp model method run incus stop    --input name=web01
swamp model method run incus stop    --input name=web01 --input force=true
swamp model method run incus restart --input name=web01
swamp model method run incus delete  --input name=web01                 # refuses if running
swamp model method run incus delete  --input name=web01 --input force=true

# Inspect a single instance's persisted state
swamp data get incus web01 --json
```

## Methods

| Method    | incus command                     | Output resource        |
| --------- | --------------------------------- | ---------------------- |
| `launch`  | `incus launch <image> <name>`     | `container`            |
| `start`   | `incus start <name>`              | `container`            |
| `stop`    | `incus stop <name> [--force]`     | `container`            |
| `restart` | `incus restart <name> [--force]`  | `container`            |
| `delete`  | `incus delete <name> [--force]`   | — (removes state)      |
| `sync`    | `incus list --format json`        | `container`* + `summary` |

`sync` is a **factory**: it writes one `container` resource per discovered
instance plus a single `summary`. `delete` is **idempotent** — a missing
instance is a no-op — and refuses a running instance unless `force=true`.

## Resources

- **`container`** — state of one instance: name, type (container/VM), status,
  architecture, ephemeral flag, profiles, IPv4/IPv6 addresses, image, and
  timestamps.
- **`summary`** — roll-up for the targeted remote/project: total instances and
  counts by status (running / stopped / frozen / other), plus the instance
  names.

## Example Questions for Your Agent

- "How many containers are running in the `web` project right now?"
- "Launch a Debian 12 container called `build01` with 2 CPUs."
- "Stop everything that's ephemeral."
- "What IP did `web01` come up with?"
