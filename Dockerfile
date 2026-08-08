# ---- build stage (arm64, same architecture as the runtime stage and the Lambda) ----
FROM node:24-bookworm-slim AS build

WORKDIR /build

# Toolchain for better-sqlite3's native addon. Build and runtime stages share an
# architecture and Debian release, so this compiles natively — no cross-compile flags,
# no risk of a binary built against one glibc running against a different one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.check.json ./
COPY src/ src/

RUN npm run build

# ---- runtime stage (arm64) ----
FROM node:24-bookworm-slim AS runtime

WORKDIR /var/task

# Lambda runtime interface client. No prebuilt binary for this base image — its install
# step builds against a small toolchain, which is purged in the same layer so it never
# reaches the shipped image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake g++ make autoconf automake libtool pkg-config python3 \
      xz-utils curl ca-certificates libssl-dev zlib1g-dev libcurl4-openssl-dev \
    && npm install -g aws-lambda-ric \
    && apt-get purge -y cmake g++ make autoconf automake libtool pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=build /build/node_modules/ ./node_modules/
COPY --from=build /build/dist/ ./dist/

RUN mkdir -p /tmp && chmod 777 /tmp

ENTRYPOINT ["aws-lambda-ric"]
CMD ["dist/handler.handler"]
