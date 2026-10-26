# Helm values

The chart is published to GHCR as an OCI chart at `oci://ghcr.io/agrodan/charts/packetatlas`, one version per PacketAtlas release. Its source is [`chart/packetatlas`](../chart/packetatlas). It is configured with a values file, like any Helm chart.

To see the defaults:

```bash
helm show values oci://ghcr.io/agrodan/charts/packetatlas --version 0.2.0
```

They're also in [`chart/packetatlas/values.yaml`](../chart/packetatlas/values.yaml). Don't edit that file. Write your own values file with only the settings you want to change, and pass it with `-f`:

```bash
helm upgrade --install packetatlas oci://ghcr.io/agrodan/charts/packetatlas --version 0.2.0 \
  -n packetatlas --create-namespace -f packetatlas-values.yaml
```

Helm merges your file over the defaults:

- Maps are merged key by key, so you only need to set the keys you change.
- Lists replace the default list entirely.

To change the deployment later, edit your file and re-run the same command. The pod restarts whenever the generated config or the token changes.

To upgrade PacketAtlas, re-run it with the new `--version`. Each chart version runs the image of the same version, so you don't need to set `image.tag`.

To work from a clone of this repo instead, for example to try out chart changes, use `./chart/packetatlas` in place of the `oci://` reference and drop `--version`. The chart in the repo defaults to the `latest` image, rather than a fixed version.

## Contents

- [Examples](#examples): [server](#a-server-the-whole-map-in-this-cluster) · [server with ingress and TLS](#a-server-behind-an-ingress-with-tls) · [agent](#an-agent-pushing-to-a-hub) · [hub](#a-hub-that-agents-push-to) · [private registry](#a-private-registry-and-a-pinned-image)
- [All values](#all-values): [mode](#mode) · [image](#image) · [agent](#agent) · [discovery](#discovery) · [config](#config) · [extraEnv](#extraenv) · [server](#server) · [rbac and serviceAccount](#rbac-and-serviceaccount) · [pod settings](#pod-settings)
- [How the config is built](#how-the-config-is-built)
- [Checking your values](#checking-your-values)

## Examples

### A server: the whole map in this cluster

```yaml
mode: server

discovery:
  namespaces: [shop, payments]       # [] watches every namespace

config:
  map:
    environment: mountains           # suburban, mountains, islands, desert, winter
  targets:
    - name: Router
      neighborhood: Home network     # outside the cluster, so across the border
      ping: { host: 192.168.1.1 }
    - name: Public site
      neighborhood: Home network
      http: { url: https://example.com }
```

Then open it with `kubectl -n packetatlas port-forward svc/packetatlas 8080:80` and go to http://localhost:8080.

### A server behind an ingress, with TLS

```yaml
mode: server

server:
  ingress:
    enabled: true
    className: traefik
    host: atlas.example.com
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt
    tls:
      - secretName: atlas-tls
        hosts: [atlas.example.com]
```

### An agent, pushing to a hub

The default mode. The agent discovers this cluster and pushes to a PacketAtlas hub elsewhere. It only makes outbound connections and creates no Service.

```yaml
agent:
  hub: https://atlas.example.com
  cluster: prod
  existingSecret: packetatlas-agent     # a Secret you created, with key "token"
```

Create the Secret first:

```bash
kubectl -n packetatlas create secret generic packetatlas-agent --from-literal=token="$PROD_AGENT_TOKEN"
```

Alternatively, set `agent.token` and the chart creates the Secret itself. That puts the token in your values file and in Helm's release history.

If the hub's certificate comes from a private CA, add that CA's PEM:

```yaml
agent:
  caBundle: |
    -----BEGIN CERTIFICATE-----
    ...
    -----END CERTIFICATE-----
```

### A hub that agents push to

A hub is a server whose config lists the clusters it accepts pushes from. Keep each token in a Secret and pass it in through `extraEnv`:

```yaml
mode: server

config:
  agents:
    - cluster: prod
      token_env: PROD_AGENT_TOKEN
    - cluster: edge
      token_env: EDGE_AGENT_TOKEN

extraEnv:
  - name: PROD_AGENT_TOKEN
    valueFrom: { secretKeyRef: { name: packetatlas-agents, key: prod } }
  - name: EDGE_AGENT_TOKEN
    valueFrom: { secretKeyRef: { name: packetatlas-agents, key: edge } }
```

The hub also discovers its own cluster, unless you set `discovery.enabled: false`.

### A private registry and a pinned image

```yaml
image:
  repository: registry.example.com/mirror/packetatlas
  tag: "0.2.0"
  pullPolicy: IfNotPresent

imagePullSecrets:
  - name: registry-login
```

## All values

### mode

| Value | Default | Meaning |
|---|---|---|
| `mode` | `agent` | `agent`: discover and check this cluster, and push the results to a hub. `server`: run the whole map here, with a Service and an optional Ingress. |

The chart refuses to render with any other value.

### image

| Value | Default | Meaning |
|---|---|---|
| `image.repository` | `ghcr.io/agrodan/packetatlas` | |
| `image.tag` | `""` | `""` runs the image matching the chart's version (`appVersion`). CI also publishes `latest` from `main`. In a clone of the repo, this defaults to `latest`. |
| `image.pullPolicy` | `IfNotPresent` | Use `Always` with `latest`, so that restarts pick up new builds. In a clone of the repo, this defaults to `Always`. |
| `imagePullSecrets` | `[]` | e.g. `[{ name: registry-login }]` |

### agent

These are used only when `mode: agent`.

| Value | Default | Meaning |
|---|---|---|
| `agent.hub` | | **Required.** The hub's URL, e.g. `https://atlas.example.com`. |
| `agent.cluster` | | **Required.** This cluster's name. It must match a `cluster` under `agents:` on the hub. |
| `agent.token` | | The token the hub lists for this cluster. The chart stores it in a Secret. |
| `agent.existingSecret` | | Use an existing Secret for the token instead. One of `token` or `existingSecret` is required. |
| `agent.existingSecretKey` | `token` | The key inside `existingSecret`. |
| `agent.pushInterval` | `10s` | How often to push to the hub. |
| `agent.caBundle` | | PEM of a private CA that signed the hub's certificate. |
| `agent.insecureSkipVerify` | `false` | Skip TLS verification of the hub. Only for testing. |

The token is mounted as a file at `/var/run/secrets/packetatlas/token`, not passed in an environment variable. The pod becomes Ready once the hub has accepted a push.

### discovery

Kubernetes discovery turns each workload into a building and each namespace into a neighborhood. It works in both modes.

| Value | Default | Meaning |
|---|---|---|
| `discovery.enabled` | `true` | |
| `discovery.interval` | `30s` | How often to rescan the cluster. |
| `discovery.namespaces` | `[]` | Namespaces to watch. `[]` means all of them. |
| `discovery.excludeNamespaces` | `[kube-system, kube-public, kube-node-lease]` | Namespaces to skip. Setting this replaces the whole list, so repeat the defaults if you want to keep them. |
| `discovery.kinds` | `[deployment, statefulset, daemonset]` | Workload kinds to show. |
| `discovery.requireAnnotation` | `false` | `true` shows only workloads annotated `packetatlas.io/discover: "true"`. |

To rename a discovered workload, pick its building or move it to another neighborhood, annotate it. See [Tune discovered buildings](../README.md#tune-discovered-buildings).

### config

| Value | Default | Meaning |
|---|---|---|
| `config` | `{}` | Any PacketAtlas config, written exactly as in a config file. |

This is where most of the map's content goes:

- `targets:` and `neighborhoods:`, for checks the chart doesn't discover. See [Add a check](../README.md#add-a-check).
- `map.environment`, for the land around the city. See [Environments](../README.md#environments).
- `defaults:`, for the default interval, timeout and history size of every check.
- `prometheus:`, for traffic from Prometheus.
- `agents:`, on a hub.

Use the config file's own key names (`token_env`, `expect_status`), not the chart's camelCase. [How the config is built](#how-the-config-is-built) explains how this combines with the settings above.

Don't write tokens here: the ConfigMap that holds it is readable by anyone who can read ConfigMaps in the namespace. Use `token_env` with [`extraEnv`](#extraenv) instead.

### extraEnv

| Value | Default | Meaning |
|---|---|---|
| `extraEnv` | `[]` | Extra environment variables for the container, in the usual Kubernetes `env:` format. |

Use it for anything in `config` that reads from the environment, mainly `token_env` on a hub (see [the hub example](#a-hub-that-agents-push-to)).

### server

These are used only when `mode: server`.

| Value | Default | Meaning |
|---|---|---|
| `server.service.type` | `ClusterIP` | |
| `server.service.port` | `80` | The Service port. The container listens on 8080. |
| `server.ingress.enabled` | `false` | |
| `server.ingress.className` | `""` | e.g. `traefik` or `nginx`. Empty uses the cluster's default class. |
| `server.ingress.annotations` | `{}` | e.g. a cert-manager issuer. |
| `server.ingress.host` | `atlas.example.com` | |
| `server.ingress.tls` | `[]` | Standard Ingress `tls:` entries. |

The map has no login of its own. If you expose it outside your network, put authentication in front of it, for example with your ingress controller's basic-auth or forward-auth middleware.

### rbac and serviceAccount

| Value | Default | Meaning |
|---|---|---|
| `rbac.create` | `true` | Create a read-only ClusterRole and its binding. |
| `serviceAccount.create` | `true` | |
| `serviceAccount.name` | `""` | Defaults to the release's full name, or `default` when `create` is false. |
| `serviceAccount.annotations` | `{}` | |

The ClusterRole is read-only: it can `get` and `list` pods, services, nodes and workloads, and `get` `nodes/proxy`, for per-pod traffic from the kubelet. [Kubernetes access](../README.md#kubernetes-access) lists the exact rules and what you need if you manage RBAC yourself.

### Pod settings

| Value | Default | Meaning |
|---|---|---|
| `resources` | requests `20m` CPU / `48Mi`; limit `256Mi` | |
| `podSecurityContext` | non-root UID 65532, `RuntimeDefault` seccomp, `net.ipv4.ping_group_range` sysctl | |
| `securityContext` | no privilege escalation, read-only root filesystem, every capability dropped | |
| `nodeSelector`, `tolerations`, `affinity` | empty | |
| `podAnnotations`, `podLabels` | empty | |

The `ping_group_range` sysctl lets the non-root process send ping. It is a "safe" sysctl, allowed by default since Kubernetes 1.18. If your cluster still refuses it, remove `sysctls` from `podSecurityContext`. Ping targets will then fail, but every other check still works.

The chart always runs one replica, because state is held in memory. Two agents would double-report, and two servers would each show only half of the pushes.

## How the config is built

The chart writes a ConfigMap with two files. PacketAtlas loads them in name order:

1. `00-chart.yaml` is generated from `mode`, `agent.*` and `discovery.*`.
2. `10-values.yaml` is your `config` value, written as-is.

The second file merges over the first [as split config files always do](../README.md#split-the-config-across-files):

- Single settings, such as `discovery.interval` or `map.environment`, are overridden by `config`.
- Lists, such as `discovery.kubernetes.namespaces`, are replaced when `config` sets them.
- Targets, `agents:` and neighborhoods are combined. Neighborhoods with the same name are merged.
- On/off switches can only be turned on. `config.discovery.kubernetes.enabled: false` does **not** turn off the chart's discovery; set `discovery.enabled: false` instead.

To see the result:

```bash
kubectl -n packetatlas get configmap packetatlas -o yaml
```

## Checking your values

Render the chart without installing it:

```bash
helm template packetatlas oci://ghcr.io/agrodan/charts/packetatlas --version 0.2.0 -f packetatlas-values.yaml
```

A missing `agent.hub`, `agent.cluster` or token in agent mode, or an unknown `mode`, fails here with a clear message rather than at startup. Mistakes inside `config` are only caught when the pod starts. To catch those too, extract the generated config and run it locally:

```bash
mkdir -p /tmp/pa && helm template packetatlas oci://ghcr.io/agrodan/charts/packetatlas --version 0.2.0 -f packetatlas-values.yaml \
  -s templates/configmap.yaml | yq '.data["10-values.yaml"]' > /tmp/pa/10-values.yaml
packetatlas -demo -config /tmp/pa
```

To see what an installed release is using:

```bash
helm -n packetatlas get values packetatlas          # your overrides
helm -n packetatlas get values packetatlas --all    # merged with the defaults
```
