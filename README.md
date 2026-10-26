# PacketAtlas

<p align="center"><img src="docs/images/demo.gif" alt="PacketAtlas: an isometric pixel-art city where each monitored service is a building, with cars driving through its streets in proportion to traffic" width="640"></p>

A network monitor whose UI is a 16-bit isometric city. Every service you watch is a building, and the streets around it fill with cars in proportion to its traffic. A healthy building has lit windows, a degraded one turns into a construction site, and one that's down catches fire, with a fire engine on the way.

- **Checks:** HTTP, TCP, ping, Docker containers and Kubernetes workloads, or discover your compose projects and namespaces automatically.
- **Neighborhoods:** group services into parts of the city. Anything outside your Docker host or cluster sits across a river, mountain range, sea or canyon.
- **Landmarks:** mark important services, like a firewall or a NAS, and they become skyscrapers, castles, domed capitols and other big buildings.
- **Environments:** set the city in the suburbs, the mountains, on islands, in the desert or in winter.

**📖 Documentation lives in the [wiki](https://github.com/AgroDan/packetatlas/wiki).**

## Quickstart

See it with made-up data in under a minute:

```bash
git clone https://github.com/AgroDan/packetatlas && cd packetatlas
docker run --rm -p 8080:8080 -v "$PWD/examples/demo.yaml:/etc/packetatlas.yaml:ro" \
  ghcr.io/agrodan/packetatlas:latest -config /etc/packetatlas.yaml -demo
```

Then open http://localhost:8080. Drag to pan, scroll to zoom, and click a building for its details.

## Running it for real

PacketAtlas runs wherever your services do:

- **A single binary or Docker container**, watching whatever you list in a YAML file. See [Installation: standalone](https://github.com/AgroDan/packetatlas/wiki/Installation#standalone-a-binary-or-a-docker-container).
- **Docker Compose**, alongside your other services, discovering every compose project on the host through a locked-down socket proxy rather than the raw Docker socket. See [Installation: Docker Compose](https://github.com/AgroDan/packetatlas/wiki/Installation#docker-compose).
- **Kubernetes**, from a Helm chart published to GHCR, discovering your workloads with read-only access. Agents in other clusters can push to one shared map. See [Installation: Kubernetes](https://github.com/AgroDan/packetatlas/wiki/Installation#kubernetes) and the [Helm chart](https://github.com/AgroDan/packetatlas/wiki/Helm-Chart).

The [wiki](https://github.com/AgroDan/packetatlas/wiki) covers everything else: [checks](https://github.com/AgroDan/packetatlas/wiki/Checks), [neighborhoods](https://github.com/AgroDan/packetatlas/wiki/Neighborhoods), [landmarks](https://github.com/AgroDan/packetatlas/wiki/Landmarks), [environments](https://github.com/AgroDan/packetatlas/wiki/Environments), [discovery](https://github.com/AgroDan/packetatlas/wiki/Discovery), the [full configuration](https://github.com/AgroDan/packetatlas/wiki/Configuration) and [troubleshooting](https://github.com/AgroDan/packetatlas/wiki/Troubleshooting).
