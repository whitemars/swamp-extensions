# @whitemars/colima

A swamp model for the **lifecycle of a [Colima](https://github.com/abiosoft/colima) VM**
— the macOS container runtime — driven through the local **`colima`** CLI. Start
and provision, stop, restart, and delete the VM; sync its live status; and run
commands inside it.

One model instance targets one **Colima profile** (`colima -p`). Create
additional instances to manage additional profiles. Mutating methods re-query
the profile afterwards and persist its fresh state, so downstream CEL
expressions read live data without a separate `sync`.

## Prerequisites

- **`colima` on PATH.** The model shells out to it; it does not speak any API
  directly. Verify with `colima version`. The bundled `colima-installed` check
  confirms this before a run.
- Colima's own dependencies (Lima / a VM backend) installed per the
  [Colima docs](https://github.com/abiosoft/colima#installation).

## Configuration

Global arguments (only `profile` is required; it defaults to `default`):

| Arg       | Default     | Purpose                                             |
| --------- | ----------- | --------------------------------------------------- |
| `profile` | `default`   | Colima profile this instance manages (`colima -p`). |
| `cpus`    | —           | CPUs to provision on start (`--cpu`).               |
| `memory`  | —           | Memory in GiB to provision on start (`--memory`).   |
| `disk`    | —           | Disk size in GiB to provision on start (`--disk`).  |
| `arch`    | —           | VM architecture: `x86_64` or `aarch64` (`--arch`).  |
| `runtime` | —           | Runtime: `docker`, `containerd`, or `incus`.        |
| `vmType`  | —           | VM type: `qemu` or `vz` (`--vm-type`).              |

```bash
# Direct execution (no persisted definition needed)
swamp model @whitemars/colima method run sync colima

# Or create a managed instance pinned to a profile and provisioning size
swamp model create @whitemars/colima colima \
  --global-arg profile=default \
  --global-arg cpus=4 \
  --global-arg memory=8
```

## Usage

```bash
# Start / provision, then read the persisted status
swamp model method run colima start
swamp data get colima status --json

# Lifecycle
swamp model method run colima stop
swamp model method run colima stop    --input force=true
swamp model method run colima restart
swamp model method run colima delete                     # destructive, always -f

# Refresh stored state without changing the VM
swamp model method run colima sync

# Run a command inside the VM (stdout/stderr/exit code captured, not thrown)
swamp model method run colima exec --input command='docker ps'
swamp data get colima exec --json
```

## Methods

| Method    | colima command                        | Output resource     |
| --------- | ------------------------------------- | ------------------- |
| `start`   | `colima start -p <profile> [flags]`   | `status`            |
| `stop`    | `colima stop -p <profile> [-f]`       | `status`            |
| `restart` | `colima restart -p <profile> [-f]`    | `status`            |
| `delete`  | `colima delete -p <profile> -f`       | — (removes `status`) |
| `sync`    | `colima list --json` + `colima status`| `status`            |
| `exec`    | `colima ssh -p <profile> -- sh -c …`  | `exec`              |

`delete` is **destructive** (always `-f`) and drops the stored `status` so it
doesn't read stale. `exec` records a non-zero exit code rather than throwing.

## Resources

- **`status`** — current state of the profile's VM: status
  (`Running` / `Stopped` / `Broken` / `not_found`), arch, cpus, memory, disk,
  runtime, and — when running — driver, IP address, Docker socket, kubernetes
  flag, mount type, and display name.
- **`exec`** — result of the last `exec`: command, stdout, stderr, exit code,
  success flag, and timestamp.

## Example Questions for Your Agent

- "Is the default Colima VM running, and what's its Docker socket?"
- "Start Colima with 4 CPUs and 8 GiB of memory."
- "Run `docker ps` inside the VM and show me the output."
- "Stop and delete the `build` profile."
