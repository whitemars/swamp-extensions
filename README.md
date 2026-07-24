# Swamp Extensions

Extensions for [swamp](https://github.com/swamp-club/swamp) providing model integrations for swamp club.

## Model Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@whitemars/cinc`](cinc/) | Read-only Chef/CINC administration via the `knife` CLI — node check-in status, node detail, search, package inventory, and (via knife-acl) group/ACL inspection | None (shells out to `knife`/`cinc-knife`) |
| [`@whitemars/step`](step/) | X.509 certificate lifecycle against a [Smallstep](https://smallstep.com) step-ca — `step/cert` issues, renews, revokes, and inspects certificates from any reachable CA (local or remote); `step/ca` optionally stands up a local step-ca in Docker for development | Docker (runs the `smallstep/step-cli`/`step-ca` containers) |
| [`@whitemars/incus`](incus/) | Container and VM lifecycle for an [Incus](https://linuxcontainers.org/incus/) daemon via the local `incus` CLI — launch, start, stop, restart, and delete instances, plus a `sync` factory that inventories every instance in a remote/project | None (shells out to `incus`) |

## Installation

Extensions are installed automatically when referenced in a swamp repository
(via [auto-resolution](https://github.com/swamp-club/swamp/pull/725)), or
manually with:

```bash
# Model extensions
swamp extension pull @whitemars/cinc
swamp extension pull @whitemars/step
swamp extension pull @whitemars/incus
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

### step-ca certificate lifecycle

```bash
swamp extension pull @whitemars/step

# Issue/renew/revoke/inspect certs against any reachable step-ca.
# Wire the CA's root fingerprint (to bootstrap trust) and provisioner
# password (via a vault) into the client model.
swamp model create @whitemars/step/cert certs \
  --global-arg caUrl=https://ca.example.com:9000 \
  --global-arg rootFingerprint=<the CA's root fingerprint> \
  --global-arg network= \
  --global-arg 'provisionerPassword=${{ vault.get(prod-secrets, CA_PASSWORD) }}'

# step ca certificate — issue a leaf cert (subject auto-added as SAN)
swamp model method run certs issue --input subject=web.example.com --input notAfter=24h

# renew (mTLS, same key) / inspect (local) / revoke (mTLS)
swamp model method run certs renew   --input subject=web.example.com
swamp model method run certs inspect --input subject=web.example.com
swamp model method run certs revoke  --input subject=web.example.com --input reason=superseded

# Optional: stand up a local step-ca in Docker for development
swamp model create @whitemars/step/ca step-ca \
  --global-arg caName='Whitemars CA' \
  --global-arg 'dnsNames:json=["localhost"]' \
  --global-arg 'provisionerPassword=${{ vault.get(step-secrets, CA_PASSWORD) }}'
swamp model method run step-ca up
```

See the [`@whitemars/step` README](step/) for the full method reference,
configuration arguments, and how to wire the local CA's fingerprint into the
cert client via CEL.

### Incus container/VM lifecycle

```bash
swamp extension pull @whitemars/incus

# Direct execution against the local daemon (no persisted definition needed)
swamp model @whitemars/incus method run sync incus

# Or create a managed instance pinned to a remote/project
swamp model create @whitemars/incus incus \
  --global-arg remote=prod \
  --global-arg project=web

# sync — inventory every instance (one `container` resource each + a `summary`)
swamp model method run incus sync
swamp data get incus summary --json

# launch — create and start an instance from an image
swamp model method run incus launch --input name=web01 --input image=images:debian/12

# lifecycle — start / stop / restart / delete (delete refuses a running instance
# unless force=true)
swamp model method run incus start   --input name=web01
swamp model method run incus stop    --input name=web01
swamp model method run incus restart --input name=web01
swamp model method run incus delete  --input name=web01 --input force=true
```

See the [`@whitemars/incus` README](incus/) for the full method reference,
configuration arguments, and the resource schemas.

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
