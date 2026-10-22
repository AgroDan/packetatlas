# PacketAtlas

A network monitor whose UI is a 16-bit isometric city. Every service you monitor is a building; the streets around it fill with cars in proportion to its traffic.

- **Targets** (buildings) are declared in YAML, or found by opt-in **discovery**, and grouped into **neighborhoods** (see below).
- **Cars**: inbound cars (rx) drive in and pull into the building; outbound cars (tx) pull out and drive off. Most trips are local, and some come in from or leave toward the edge of the map ("the internet"). Busy services get queues.
- **Kubernetes / Docker buildings** get one floor per pod / container; lit windows are ready ones. Unless you choose a building, each gets one of five styles picked from its id, so the city looks mixed and stays the same between reloads: offices, brick apartment blocks with water towers, pitched-roof houses (they turn into apartments past three floors), art-deco towers with a setback and spire, and modern blocks with solar, garden or helipad roofs.
- **Status**: a green, amber or red map pin, plus:
  - **degraded** → a construction site: unfinished top floors as bare steel frame, scaffolding, a tower crane with a moving hook, traffic cones and an amber flasher
  - **down** → on fire: scorched walls, flames from the roof and windows, smoke and embers, and a fire engine out front with flashing lights spraying the roof
  - **unknown** (not checked yet) → greyed out with dark windows

## Quickstart

### 1. See it running (no setup)

```bash
go build -o packetatlas ./cmd/packetatlas
./packetatlas -config examples/demo.yaml -demo
```

Open http://localhost:8080. `-demo` invents statuses and traffic, so you can look around before pointing it at anything real.

### 2. Monitor your first service

Create `packetatlas.yaml` with one target per thing you want to watch. Each target needs a `name` and **one** check block (`http`, `tcp`, `ping`, `kubernetes` or `docker`):

```yaml
targets:
  - name: Company website
    http: { url: https://example.com }
```

Run it without `-demo`:

```bash
./packetatlas -config packetatlas.yaml
```

The building appears grey until its first check finishes (within `defaults.interval`, 15s by default), then turns green, amber or red.

Or run it with Docker:

```bash
docker run --rm -p 8080:8080 -v "$PWD/packetatlas.yaml:/etc/packetatlas.yaml:ro" \
  ghcr.io/agrodan/packetatlas:latest -config /etc/packetatlas.yaml
```

### 3. Add more checks

Add another entry under `targets:`, then restart PacketAtlas. The config is read at startup only.

```yaml
targets:
  # A website or API: up if it answers 2xx/3xx.
  - name: Billing API
    http:
      url: https://billing.example.com/healthz
      expect_status: [200]        # optional: only these codes count as up
      contains: '"status":"ok"'   # optional: the body must contain this
    degraded_latency: 800ms       # optional: slower than this → amber (construction site)

  # Anything that listens on a port: databases, SSH, SMTP, …
  - name: Postgres (RDS)
    tcp: { address: mydb.abc123.us-east-1.rds.amazonaws.com:5432 }

  # A host that should answer ping.
  - name: Office router
    ping: { host: 192.168.1.1 }
```

Each target can also set `building:`, `color:`, `interval:` and `timeout:`. The [Checks](#checks) section lists every option.

### 4. Group them into neighborhoods

Targets with nothing else to go on land in **Outskirts**. To give related services their own part of the city, nest them in a neighborhood, or give each one a `neighborhood:` field:

```yaml
neighborhoods:
  - name: External services
    color: "#d08a3a"
    targets:
      - name: Stripe API
        http: { url: https://status.stripe.com }
      - name: Billing API
        http: { url: https://billing.example.com/healthz }

targets:
  - name: Office router
    neighborhood: External services   # same result as nesting it above
    ping: { host: 192.168.1.1 }
```

### 5. Add discovery, keep your own checks

To map Kubernetes workloads or Docker Compose services automatically, turn on [discovery](#discovery). Declared targets keep working next to discovered ones, so in one config you can discover a cluster and also watch services outside it:

```yaml
discovery:
  kubernetes: { enabled: true }       # every deployment/statefulset/daemonset

targets:                              # plus things the cluster doesn't run
  - name: Payment provider
    neighborhood: External services
    http: { url: https://api.payments.example/health }
  - name: Legacy VM
    neighborhood: External services
    tcp: { address: 10.20.0.15:443 }
```

### Monitoring a service outside the cluster

How you do this depends on how PacketAtlas is deployed. A check always runs **from wherever PacketAtlas (or its agent) is running**, so pick the place that can reach the service.

| Your setup | Where to declare the outside service |
|---|---|
| A single PacketAtlas binary or container | In its config file, under `targets:` as above. |
| In a cluster with the chart in `mode=server` | In the chart's `config` value (see below). |
| A hub plus cluster agents | In the **hub's** config, so it shows as its own neighborhood. If you declare it in an agent's config instead, the check runs from inside that cluster and the building shows up under that cluster's prefix (e.g. `prod/External services`). Do that only for services that only the cluster can reach. |

With the Helm chart, put targets in a values file. They're merged over the generated config, and changing them restarts the pod:

```yaml
# my-values.yaml
config:
  neighborhoods:
    - name: External services
      targets:
        - name: Company website
          http: { url: https://example.com }
        - name: Legacy VM
          tcp: { address: 10.20.0.15:443 }
```

```bash
helm upgrade --install packetatlas ./chart/packetatlas -n packetatlas --create-namespace \
  --set mode=server -f my-values.yaml
```

### Keeping configs tidy

`-config` also accepts a directory. Every `*.yaml` / `*.yml` file in it is loaded in name order: later files override settings, neighborhoods with the same name are merged, and targets are combined. That makes it easy to keep one file per team or per neighborhood:

```
conf.d/
  00-base.yaml          # server, defaults, discovery
  10-external.yaml      # the "External services" neighborhood
  20-home-lab.yaml
```

Target names must be unique within a neighborhood.

## Run

```bash
go build -o packetatlas ./cmd/packetatlas
./packetatlas -config examples/demo.yaml -demo     # fake data, no cluster needed
./packetatlas -config packetatlas.yaml             # real checks
./packetatlas -config ./conf.d/                    # directory of *.yaml files
./packetatlas -config examples/discovery.yaml      # build the map from what's running
./packetatlas -config examples/hub.yaml            # accept pushes from cluster agents
./packetatlas agent -config examples/agent.yaml    # push this cluster to a hub
```

Open http://localhost:8080. Drag to pan, scroll to zoom, click a building for details, `/` to search. The URL hash deep-links to the selected building.

Flags: `-listen` overrides `server.listen`. `-web web/static` serves the UI from disk, so frontend edits only need a browser refresh, not a rebuild.

## Neighborhoods

Every target lands in exactly one neighborhood, chosen by the first match:

1. **Explicit**: declared inside a `neighborhoods:` entry, or given a `neighborhood:` field
2. **Kubernetes namespace** (`kubernetes.namespace`)
3. **docker-compose project** (`docker.project`)
4. **Outskirts**, the catch-all

```yaml
neighborhoods:
  - name: Home Lab              # custom neighborhood with its own targets
    targets:
      - name: Router
        ping: { host: 192.168.1.1 }
  - name: prod                  # no targets: just colours the "prod" namespace
    color: "#4f7cc4"

targets:                        # placed automatically
  - name: api
    kubernetes: { namespace: prod, deployment: api }    # → prod
  - name: web
    docker: { project: blog, service: web }             # → blog
  - name: NAS
    neighborhood: Home Lab                              # → Home Lab
    tcp: { address: 192.168.1.10:445 }
```

On the map, neighborhoods with four or more buildings get whole blocks; smaller ones share blocks, one lot per building, with plain paving marking the boundary between them. Neighborhoods grow outward from the middle of the map as organic clusters of blocks, with a river winding through (or past, for small cities) crossed by bridges, plus a lake and a park once the city is big enough. Highways run from the city to each edge of the map, where through-traffic enters. The layout is seeded from neighborhood names, so it stays the same between reloads. Neighborhood labels (shown when zoomed out) say where each one came from ("k8s namespace" or "compose app"). If a namespace and a compose project share a name, they become one neighborhood.

## Discovery

Off by default: without it, the map shows only the targets you declare, and a config with no targets is an error. Turn it on per source:

```yaml
discovery:
  interval: 30s                 # rescan period
  kubernetes:
    enabled: true
    namespaces: []              # default: all
    exclude_namespaces: [...]   # default: kube-system, kube-public, kube-node-lease; [] includes them
    kinds: [deployment, statefulset, daemonset]
    require_annotation: false   # true: only workloads annotated packetatlas.io/discover: "true"
  docker:
    enabled: true
    projects: []                # default: all compose projects
    exclude_projects: []
    require_label: false        # true: only containers labelled packetatlas.io/discover=true
```

- **Kubernetes**: each deployment, statefulset and daemonset becomes a building in its namespace's neighborhood. Workloads scaled to zero are skipped.
- **Docker**: each docker-compose service becomes a building in its project's neighborhood. Services whose containers all exited with code 0 count as finished jobs and are skipped; `docker compose down` removes the building, while a crashed or killed service stays and burns.
- New workloads appear and deleted ones disappear on the next scan. If the API can't be reached, the current buildings stay.
- A declared target for the same workload (same namespace and deployment/statefulset/daemonset, or same compose project and service) replaces the discovered one, so you can tune a building by hand. Declared neighborhoods keep their colour for discovered buildings.
- Discovered buildings carry a "discovered" badge in the side panel. Discovery is off in `-demo` mode.

Buildings are guessed from the workload name and images: databases and caches (postgres, redis, mongo, …) and statefulsets are datacenters, gateways and proxies (ingress, traefik, envoy, …) are towers, workers and queues are factories, daemonsets are shops, and everything else is `auto` (a mix of styles). Override with Kubernetes annotations or Docker labels:

| Annotation / label             | Effect                                                |
|--------------------------------|-------------------------------------------------------|
| `packetatlas.io/ignore: "true"`   | never discover this workload                       |
| `packetatlas.io/discover: "true"` | opt in, when `require_annotation`/`require_label` is set |
| `packetatlas.io/name`             | building label                                     |
| `packetatlas.io/building`         | any building below                                 |
| `packetatlas.io/neighborhood`     | place it in a named neighborhood instead           |
| `packetatlas.io/color`            | building colour                                    |

## Agents and the Helm chart

To map a cluster on a PacketAtlas running elsewhere, install the agent in that cluster. It runs discovery and checks locally and pushes the results to the hub (`POST /api/ingest`) every `push_interval`. Connections only go outbound, so the API server isn't exposed and no kubeconfig leaves the cluster. One hub can take any number of clusters.

On the hub, list each cluster with its own token (see `examples/hub.yaml`):

```yaml
agents:
  - cluster: prod
    token_env: PROD_AGENT_TOKEN   # or token_file / token, at least 16 characters
    stale_after: 1m               # default 1m
    neighborhood_prefix: "prod/"  # the default, "<cluster>/"; "" for none
```

Then install the agent in the cluster:

```bash
helm install packetatlas ./chart/packetatlas -n packetatlas --create-namespace \
  --set agent.hub=https://atlas.example.com \
  --set agent.cluster=prod \
  --set agent.token="$PROD_AGENT_TOKEN"        # or agent.existingSecret
```

- **On the map:** the agent's neighborhoods appear on the hub as `prod/<namespace>`, and their buildings carry a "cluster prod" badge.
- **Updates:** each push replaces the cluster's buildings, so deleted workloads disappear. The agent's first push waits for its first discovery scan.
- **Outages:** if an agent stops pushing for `stale_after`, its buildings go grey (unknown) and show how long it has been silent.
- **History:** the hub keeps its own history for agent buildings; agents don't send theirs.
- **Health:** the agent pod is Ready once the hub has accepted a push. `/healthz` and `/readyz` are on `agent.listen` (default `:8081`).
- **Rejected pushes:** wrong tokens get `401`. A token used with another cluster's name gets `403`. If the agent and hub are on different report versions, the push gets `400` and you upgrade the older side.
- **Security:** use HTTPS for the hub, because the token goes with every push. The agent warns about plain `http://`. `agent.caBundle` (chart) or `agent.ca_file` trusts a private CA.

The chart can also run the whole map inside the cluster with `--set mode=server`. That adds a Service, plus an optional Ingress (`server.ingress.*`). Chart values:

| Value | Meaning |
|---|---|
| `mode` | `agent` (default) or `server` |
| `agent.hub`, `agent.cluster` | where to push and as which cluster (agent mode, required) |
| `agent.token` / `agent.existingSecret` (+ `existingSecretKey`) | the cluster's token; mounted as a file |
| `discovery.*` | `enabled`, `interval`, `namespaces`, `excludeNamespaces`, `kinds`, `requireAnnotation` |
| `config` | extra PacketAtlas YAML merged over the generated config: targets, neighborhoods, `agents:` for a server-mode hub, … |
| `extraEnv` | e.g. Secret-backed `token_env` variables for a server-mode hub's `agents:` |

The pod runs as non-root on a read-only filesystem with every capability dropped. It sets `net.ipv4.ping_group_range` so ping targets work without root. It needs read-only RBAC: the ClusterRole above plus `list` on workloads. The chart pulls `ghcr.io/agrodan/packetatlas:latest`, which CI publishes from `main`. Pushing a `v0.1.0` git tag also publishes `:0.1.0`; pin it with `--set image.tag=0.1.0 --set image.pullPolicy=IfNotPresent`. To build the image yourself: `docker build -t ghcr.io/agrodan/packetatlas:dev .`.

## Checks

| Block        | Measures                                                                 | Default building |
|--------------|--------------------------------------------------------------------------|------------------|
| `kubernetes` | pod readiness vs desired replicas; per-pod rx/tx bytes/s from the kubelet | `auto`           |
| `docker`     | container running/healthy; per-container rx/tx bytes/s from Engine stats  | `auto`           |
| `ping`       | ICMP echo, loss and RTT                                                  | `radio`          |
| `http`       | status code (default 2xx/3xx or `expect_status`), optional `contains`    | `shop`           |
| `tcp`        | connect time                                                             | `datacenter`     |

Buildings: `auto`, `office`, `apartment`, `house`, `deco`, `modern`, `tower`, `datacenter`, `factory`, `shop`, `radio`. `auto` picks one of the five multi-storey styles from the target's id.

A target's `type` is inferred from which block it has. Common per-target options are `interval`, `timeout`, `degraded_latency`, `building` and `color`. See `examples/demo.yaml` for every option.

**Kubernetes** pods are selected with exactly one of `deployment`, `statefulset`, `daemonset`, `service` or `selector`. Traffic comes from the kubelet Summary API (`nodes/proxy`). Pods with `hostNetwork: true` report no network stats. The client uses in-cluster config, or `kubernetes.kubeconfig` / `context`, or `$KUBECONFIG` / `~/.kube/config`. RBAC needed for in-cluster use:

```yaml
rules:
  - apiGroups: [""]
    resources: [pods, services, nodes]
    verbs: [get, list]
  - apiGroups: [""]
    resources: [nodes/proxy]
    verbs: [get]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets]
    verbs: [get, list]          # list: only for discovery
```

Discovery across all namespaces needs these as a ClusterRole; with `discovery.kubernetes.namespaces` set, a Role in each namespace is enough.

**Docker** containers are selected with `project` (the whole compose app, or narrowed with `service`) or with `container` (an exact name). The client connects to `docker.host` (`unix://`, `tcp://` or `http(s)://`), falling back to `$DOCKER_HOST` and then `/var/run/docker.sock`. Containers that are running and not `unhealthy` or `health: starting` count as ready. Containers that exited with code 0 are treated as finished one-shot jobs and ignored. Host-network containers report no traffic.

**Ping** first tries an unprivileged ICMP socket (Linux `net.ipv4.ping_group_range`), then a raw socket (root / `CAP_NET_RAW`).

**Prometheus traffic**: any target can take its rx/tx from PromQL, which replaces traffic from the check itself:

```yaml
prometheus:
  url: http://prometheus:9090
# on a target:
traffic:
  rx: sum(rate(nginx_ingress_controller_request_size_sum[1m]))
  tx: sum(rate(nginx_ingress_controller_response_size_sum[1m]))
  unit: B/s        # or e.g. req/s
  max: 10000000    # value that renders as gridlock (log scale); default defaults.traffic_max
```

Targets without traffic data (ping, plain HTTP/TCP) show a light trickle of cars while they're up.

## Layout

```
cmd/packetatlas/      entry point, flags, `agent` subcommand
internal/config/      YAML loading, merging, neighborhood grouping, validation
internal/monitor/     scheduler + history, discovery, checkers (kube, docker, ping, http, tcp, prometheus, demo)
internal/agent/       agent → hub push loop, report format, health endpoints
internal/server/      /api/state (JSON), /api/stream (SSE), /api/ingest (agent pushes), static UI
chart/packetatlas/    Helm chart (agent or server mode)
web/static/           embedded UI (plain ES modules, no build step)
  js/pixel.js         pixel buffer + isometric box rasteriser
  js/city.js          organic block layout, roads, river/lakes, BFS paths, ground rendering
  js/sprites.js       procedural buildings, cars, trees, pins
  js/traffic.js       car spawning, lane following, queueing
  js/renderer.js      camera, depth-sorted drawing, pins/labels, effects, minimap
  js/ui.js            search, info panel, summary chips, tooltip
```
