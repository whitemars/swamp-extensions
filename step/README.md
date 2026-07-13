# @whitemars/step

Swamp models for managing the **X.509 certificate lifecycle** against a
[Smallstep](https://smallstep.com) **step-ca** certificate authority — issue,
renew, revoke, and inspect certificates from any reachable CA, local or remote.

The extension is organized into two model types with distinct lifecycles:

| Type                   | Concern                                     | Status      |
| ---------------------- | ------------------------------------------- | ----------- |
| `@whitemars/step/cert` | Certificate lifecycle (CA-agnostic client)  | ✅ available |
| `@whitemars/step/ca`   | Run a local step-ca in Docker (optional)    | ✅ available |

The **primary** model is `@whitemars/step/cert`, a CA client that works against
any step-ca you can reach over the network. `@whitemars/step/ca` is a
**secondary, optional** helper for standing up a local step-ca in Docker during
development.

## `@whitemars/step/cert`

Manages the leaf-certificate lifecycle as a **CA client**, independent of where
the CA runs. It reaches the CA over the network at `caUrl`, bootstrapping trust
from the CA's root fingerprint, and runs the `step` CLI in an ephemeral
`smallstep/step-cli` container — it does **not** exec into the CA or read its
filesystem. The same model works against a **remote** step-ca or the local
`@whitemars/step/ca` container. One instance manages many subjects (each method
takes a `subject`); certificates are stored per-subject.

### Prerequisites

- A reachable step-ca (local or remote) and its root fingerprint.
- Docker, to run the ephemeral `step-cli` container.

### Configuration

Global arguments:

| Arg                   | Default                    | Purpose                                                                                     |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `caUrl`               | `https://localhost:9000`   | CA URL as reachable from the step-cli container.                                            |
| `rootFingerprint`     | (required for issue/renew/revoke) | Root fingerprint to bootstrap trust.                                                 |
| `provisionerName`     | `admin`                    | JWK provisioner used to authorize issuance.                                                 |
| `provisionerPassword` | (required for `issue`)     | Provisioner password. **Supply via `vault.get()`.**                                         |
| `stepImage`           | `smallstep/step-cli`       | Image providing the `step` CLI (tag-pinnable).                                              |
| `network`             | `container:step-ca`        | Docker `--network` for CA-contacting runs. Shares the local CA's netns so `localhost` + TLS SANs match. Set empty for a remote CA on the default bridge. |
| `dockerBinary`        | `docker`                   | Docker CLI executable to invoke.                                                            |

**Against a remote CA** — the common case — point the client at the CA's URL and
fingerprint and use the default bridge network:

```bash
swamp model create @whitemars/step/cert certs \
  --global-arg caUrl=https://ca.example.com:9000 \
  --global-arg rootFingerprint=<the CA's root fingerprint> \
  --global-arg network= \
  --global-arg 'provisionerPassword=${{ vault.get(prod-secrets, CA_PASSWORD) }}'
```

**Against the local `@whitemars/step/ca` container**, wire the fingerprint
straight from the CA model's output via CEL (see that model below) and keep the
default `network`:

```bash
swamp model create @whitemars/step/cert certs \
  --global-arg 'rootFingerprint=${{ data.latest("step-ca", "ca").attributes.rootFingerprint }}' \
  --global-arg 'provisionerPassword=${{ vault.get(step-secrets, CA_PASSWORD) }}'
```

### Methods

| Method    | What it does                                                            | Output resource |
| --------- | ----------------------------------------------------------------------- | --------------- |
| `issue`   | Issue a leaf cert (subject auto-added as SAN). Stores cert + vaulted key.| `cert`          |
| `renew`   | Renew via mTLS (same key, extended validity). Updates the stored record. | `cert`          |
| `revoke`  | Revoke via mTLS. Marks the record `revoked`; it can no longer renew.     | `cert`          |
| `inspect` | Report validity window, expiry countdown, serial, fingerprint (local).   | `inspection`    |

The private key is stored with `.meta({ sensitive: true })`, so it is written to
a vault and the stored record holds a `${{ vault.get(...) }}` reference — never
plaintext.

```bash
swamp model method run certs issue  --input subject=web.example.com --input notAfter=24h
swamp model method run certs issue  --input subject=api.example.com --input 'sans:json=["api.example.com","api-alt.example.com"]'
swamp data get certs cert-web.example.com --json     # stored cert (key is a vault ref)

swamp model method run certs renew   --input subject=web.example.com
swamp model method run certs inspect --input subject=web.example.com
swamp data get certs inspect-web.example.com --json  # expiry / validity
swamp model method run certs revoke  --input subject=web.example.com --input reason=superseded
```

Certificates are stored under the instance name `cert-<subject>`; inspections
under `inspect-<subject>`.

## `@whitemars/step/ca` (optional — local CA in Docker)

A convenience model for running a `smallstep/step-ca` container locally, mainly
for development and for exercising `@whitemars/step/cert` without a remote CA.
One model instance models one CA. In production you would typically point
`@whitemars/step/cert` at an existing step-ca instead.

The `smallstep/step-ca` image **auto-initializes** a new CA the first time it
boots against an empty volume (using `DOCKER_STEPCA_INIT_*` environment
variables). On later boots the volume already holds the CA, so the init
variables are ignored — which makes `up` naturally idempotent.

### Prerequisites

- **Docker** installed and the daemon running locally (`docker version` works).
- The model pulls `smallstep/step-ca` on first use.

### Configuration

Global arguments (one instance = one CA):

| Arg                  | Default              | Purpose                                                                 |
| -------------------- | -------------------- | ----------------------------------------------------------------------- |
| `caName`             | (required)           | Human-readable CA name; the root issuer/subject.                        |
| `dnsNames`           | (required)           | DNS names / IPs the CA answers on. First entry builds the client CA URL.|
| `provisionerPassword`| (required)           | Password protecting the provisioner + CA keys. **Use `vault.get()`.**   |
| `provisionerName`    | `admin`              | Name of the initial JWK provisioner.                                    |
| `port`               | `9000`               | Host port published to the container's internal `9000`.                 |
| `address`            | `:9000`              | Address step-ca listens on inside the container.                        |
| `image`              | `smallstep/step-ca`  | Docker image, optionally tag-pinned.                                    |
| `containerName`      | `step-ca`            | Docker container name.                                                   |
| `volume`             | `step`               | Docker named volume mounted at `/home/step`.                            |
| `remoteManagement`   | `false`              | Enable step-ca's admin/remote provisioner management API on init.       |
| `acme`               | `false`              | Add an ACME provisioner on init.                                        |
| `ssh`                | `false`              | Enable the SSH CA on init.                                              |
| `dockerBinary`       | `docker`             | Docker CLI executable to invoke.                                        |

> **Security note.** The provisioner password is passed to the container as an
> environment variable on the initial `up` (the image needs it to bootstrap and
> persist the CA keys). It is therefore visible in `docker inspect` on that
> container. This is acceptable for a local development CA; supply it via
> `${{ vault.get(...) }}` so it never lives in the model YAML in plaintext.

```bash
# Store the CA password in a vault (see the swamp-vault skill), then:
swamp model create @whitemars/step/ca step-ca \
  --global-arg caName='Whitemars CA' \
  --global-arg 'dnsNames:json=["localhost"]' \
  --global-arg 'provisionerPassword=${{ vault.get(step-secrets, CA_PASSWORD) }}' \
  --global-arg port=9000
```

### Methods

| Method   | What it does                                                                                  | Output resource |
| -------- | --------------------------------------------------------------------------------------------- | --------------- |
| `up`     | Ensure the CA container is running (create + auto-init on first run, start if stopped).        | `ca`            |
| `status` | Report container existence, running state, root fingerprint, and CA `/health`.                | `status`        |
| `down`   | Stop and remove the container. The volume (CA material) is preserved for a later `up`.        | `status`        |

```bash
swamp model method run step-ca up          # boot the CA
swamp model method run step-ca status      # check on it
swamp data get step-ca ca --json           # read the root fingerprint, CA URL, ...
swamp model method run step-ca down         # tear the container down (keeps the volume)
```

### Wiring into `@whitemars/step/cert`

Once `up` has run, the root fingerprint and CA URL are available to the cert
model via CEL:

```
data.latest("step-ca", "ca").attributes.rootFingerprint
data.latest("step-ca", "ca").attributes.caUrl
```

These are exactly what the client needs to bootstrap trust — see the
`@whitemars/step/cert` configuration above.
