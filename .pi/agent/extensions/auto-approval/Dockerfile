FROM oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS bun
FROM node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /executor
COPY package.json ./package.json
COPY node_modules ./node_modules
COPY runner.ts ./runner.ts
# The runtime supplies user, readonly filesystem, network isolation, and limits.
ENTRYPOINT ["/usr/local/bin/bun", "/executor/runner.ts"]
