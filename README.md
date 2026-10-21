# PacketAtlas

A network monitor whose UI is a 16-bit isometric city. Every service you monitor is a building; the streets around it fill with cars in proportion to its traffic.

- **Targets** (buildings) are declared in YAML and grouped into **neighborhoods** (see below).
- **Cars**: inbound cars (rx) drive in and pull into the building; outbound cars (tx) pull out and drive off. Most trips are local, and some come in from or leave toward the edge of the map ("the internet"). Busy services get queues.
- **Kubernetes / Docker buildings** get one floor per pod / container; lit windows are ready ones.
- **Status**: a green, amber or red map pin, plus:
  - **degraded** → a construction site: unfinished top floors as bare steel frame, scaffolding, a tower crane with a moving hook, traffic cones and an amber flasher
  - **down** → on fire: scorched walls, flames from the roof and windows, smoke and embers, and a fire engine out front with flashing lights spraying the roof
  - **unknown** (not checked yet) → greyed out with dark windows

## Run

```bash
go build -o packetatlas ./cmd/packetatlas
./packetatlas -config examples/demo.yaml -demo     # fake data, no cluster needed
./packetatlas -config packetatlas.yaml             # real checks
./packetatlas -config ./conf.d/                    # directory of *.yaml files
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

Neighborhood labels on the map say where each one came from ("k8s namespace" or "compose app"). If a namespace and a compose project share a name, they become one neighborhood.

## Checks

| Block        | Measures                                                                 | Default building |
|--------------|--------------------------------------------------------------------------|------------------|
| `kubernetes` | pod readiness vs desired replicas; per-pod rx/tx bytes/s from the kubelet | `office`         |
| `docker`     | container running/healthy; per-container rx/tx bytes/s from Engine stats  | `office`         |
| `ping`       | ICMP echo, loss and RTT                                                  | `radio`          |
| `http`       | status code (default 2xx/3xx or `expect_status`), optional `contains`    | `shop`           |
| `tcp`        | connect time                                                             | `datacenter`     |

Buildings: `office`, `tower`, `datacenter`, `factory`, `shop`, `radio`.

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
    verbs: [get]
```

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
cmd/packetatlas/      entry point, flags
internal/config/      YAML loading, merging, neighborhood grouping, validation
internal/monitor/     scheduler + history, checkers (kube, docker, ping, http, tcp, prometheus, demo)
internal/server/      /api/state (JSON), /api/stream (SSE), static UI
web/static/           embedded UI (plain ES modules, no build step)
  js/pixel.js         pixel buffer + isometric box rasteriser
  js/city.js          neighborhood/block layout, road grid, BFS paths, ground rendering
  js/sprites.js       procedural buildings, cars, trees, pins
  js/traffic.js       car spawning, lane following, queueing
  js/renderer.js      camera, depth-sorted drawing, pins/labels, effects, minimap
  js/ui.js            search, info panel, summary chips, tooltip
```
