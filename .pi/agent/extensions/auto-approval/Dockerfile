FROM oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS bun
FROM node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /extensions/auto-approval
COPY auto-approval/package.json ./package.json
COPY auto-approval/node_modules ./node_modules
COPY auto-approval/runner.ts ./runner.ts
COPY web-research /extensions/web-research
RUN python3 -m venv /tmp/web-venv && /tmp/web-venv/bin/pip install --no-cache-dir --only-binary=:all: --target /opt/pi-web/dependencies -r /extensions/web-research/requirements.txt && rm -rf /tmp/web-venv
COPY web-research/worker.py /opt/pi-web/worker.py
RUN mkdir /executor && ln -s /extensions/auto-approval/runner.ts /executor/runner.ts
# The runtime supplies user, readonly filesystem, network isolation, and limits.
ENTRYPOINT ["/usr/local/bin/bun", "/executor/runner.ts"]
