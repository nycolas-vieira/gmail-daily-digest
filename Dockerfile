# syntax=docker/dockerfile:1

# --- build stage ---
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache modules first (no external deps today, but keeps rebuilds fast).
COPY go.mod ./
RUN go mod download

COPY . .
# Static, stripped binary so the runtime image can be distroless/scratch-tiny.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gmail-daily-digest .

# --- runtime stage ---
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app

COPY --from=build /out/gmail-daily-digest /usr/local/bin/gmail-daily-digest

# config.json is MOUNTED at runtime (never baked in - it holds secrets and
# this repo is public). Default mode organizes once and exits.
ENTRYPOINT ["gmail-daily-digest"]
