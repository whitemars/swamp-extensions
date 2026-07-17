# @whitemars/cinc

A swamp model that wraps the Chef/CINC **`knife`** CLI for read-only server
administration: node check-in status, node detail, generic search, package
inventory, and (via the knife-acl plugin) group and ACL inspection.

Works against both **Chef Infra Server** and **CINC Server** — the `knife`
executable is auto-detected (`cinc-knife` preferred, falling back to `knife`)
and can be pinned explicitly.

## Prerequisites

- **`knife` (or `cinc-knife`) on PATH**, configured to talk to your server
  (a working `knife.rb`/`config.rb` + client key). The model shells out to it;
  it does not implement the Chef API itself.
- **The [`knife-acl`](https://github.com/chef-boneyard/knife-acl) plugin** —
  **required only for the `group` and `acl` methods.** These call
  `knife group …` / `knife acl …`, which do not exist in a stock knife install.
  Without the plugin, `status`, `show`, `search`, `filter`, and `checkPackage`
  still work; `group` and `acl` will fail with
  `Cannot find subcommand for: 'group'` / `'acl'`.
  - Chef Workstation / CINC Workstation ship it; otherwise install with
    `chef gem install knife-acl` (or `cinc gem install knife-acl`).
  - Verify: `knife group list` and `knife acl show groups admins` return data.

## Configuration

Global arguments (all optional):

| Arg              | Default | Purpose                                                        |
| ---------------- | ------- | -------------------------------------------------------------- |
| `knifeBinary`    | (auto)  | knife executable to use. Auto-detects `cinc-knife` → `knife`.  |
| `knifeConfigPath`| (none)  | Path to a `knife.rb`/`config.rb`, passed as `-c`.              |
| `staleHours`     | `24`    | Age (h) after which a node's last check-in is "stale".         |
| `criticalHours`  | `168`   | Age (h) after which a node is "critical".                      |

```bash
# Direct execution (no persisted definition needed)
swamp model @whitemars/cinc method run status cinc

# Or create a managed instance
swamp model create @whitemars/cinc cinc \
  --global-arg knifeBinary=cinc-knife \
  --global-arg knifeConfigPath=/home/me/.chef/knife.rb
```

## Usage

```bash
# health of every node (ok / stale / critical / never_converged) in one server call
swamp model method run cinc status
swamp data get cinc current --json          # inspect the report

# knife node show — detail for one node
swamp model method run cinc show --input nodeName=web01.example.org

# knife search — query any index (default: node), optionally selecting attributes
swamp model method run cinc search --input query='policy_group:union'
swamp model method run cinc search --input query='name:web*' --input attributes='["platform","ipaddress"]'

# knife group  (requires knife-acl)
swamp model method run cinc group --input action=list
swamp model method run cinc group --input action=show --input group=admins

# knife acl show  (requires knife-acl)
swamp model method run cinc acl --input objectType=groups --input objectName=admins
swamp model method run cinc acl --input objectType=nodes  --input objectName=web01.example.org

# Convenience methods built on the above
swamp model method run cinc filter --input status=critical
swamp model method run cinc checkPackage --input packageName=openssl --input group=union --input minVersion=3.0.0
```

`objectType` for `acl` is one of:
`nodes`, `groups`, `clients`, `roles`, `environments`, `cookbooks`, `data`, `containers`.

## Methods

| Method         | knife command                              | Output resource |
| -------------- | ------------------------------------------ | --------------- |
| `status`       | `knife search node "*:*" -a …` (one call)  | `nodeHealth`    |
| `show`         | `knife node show`                          | `nodeDetail`    |
| `search`       | `knife search <index> <query>`             | `searchResult`  |
| `group`        | `knife group list` / `knife group show`    | `groupInfo`     |
| `acl`          | `knife acl show`                           | `aclInfo`       |
| `filter`       | `knife search node "*:*"`, filtered        | `nodeHealth`    |
| `checkPackage` | `knife search node packages:…`             | `packageCheck`  |

All methods are **read-only** — the model never mutates server state.

## Example Questions for Your Agent

- "Which nodes haven't checked in this week?"
- "Show me everything in the `union` policy group."
- "Who's in the `admins` group, and what can they do to it?"
- "Is openssl ≥ 3.0.0 installed everywhere in `deliver`?"

