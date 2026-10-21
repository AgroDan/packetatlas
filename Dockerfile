FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /packetatlas ./cmd/packetatlas

FROM gcr.io/distroless/static:nonroot
COPY --from=build /packetatlas /packetatlas
USER 65532:65532
EXPOSE 8080 8081
ENTRYPOINT ["/packetatlas"]
