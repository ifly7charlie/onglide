# syntax=docker/dockerfile:1.7-labs 
FROM node:20-slim AS ognbase
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib,target=/var/lib/apt,sharing=locked \
    --mount=type=cache,id=debconf,target=/var/cache/debconf,sharing=locked apt-get update && \
	 apt-get install -y gnupg wget lsb-release && \
     wget -c https://dev.mysql.com/get/mysql-apt-config_0.8.30-1_all.deb && \
     dpkg -i mysql-apt-config_0.8.30-1_all.deb && \
     apt-get update && \
     apt-get install -y mysql-community-client
WORKDIR /onglide

FROM ognbase AS buildbase
COPY ./package.json ./
COPY ./yarn.lock ./
RUN --mount=type=cache,target=/tmp/.cache yarn install --frozen-lockfile --cache-folder /tmp/.ycache


FROM buildbase AS nextbuildimage
WORKDIR /onglide
ARG NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN
ARG NEXT_PUBLIC_SITEURL
ARG NEXT_PUBLIC_WEBSOCKET_HOST
ARG NEXT_PUBLIC_HISTORY_HOST
ARG NEXT_PUBLIC_COMPETITION_DELAY
COPY ./next.config.js ./next.config.js
COPY ./tsconfig.json ./tsconfig.json
COPY ./next-env.d.ts ./next-env.d.ts
COPY ./styles ./styles
COPY ./pages ./pages
#COPY ./app ./app
COPY ./public ./public
COPY --exclude=webworkers --exclude=dijkstras.ts --exclude=launchlanding.ts --exclude=".#*" ./lib ./lib
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN yarn next build

FROM buildbase AS ognbuildimage
WORKDIR /onglide
COPY ./tsconfig-bin.json ./tsconfig-bin.json
COPY ./bin ./bin
COPY ./lib ./lib
RUN yarn build:tsc

FROM ognbase AS productionbase
WORKDIR /onglide
COPY ./package.json ./
COPY ./yarn.lock ./
RUN --mount=type=cache,target=/tmp/.cache yarn install --frozen-lockfile --production --cache-folder /tmp/.ycache

FROM ognbase AS next
WORKDIR /onglide
COPY --from=nextbuildimage /onglide/.next/standalone ./
COPY --from=nextbuildimage /onglide/.next/server ./.next/server
COPY --from=nextbuildimage /onglide/.next/static ./.next/static
COPY --from=nextbuildimage /onglide/public ./public
#COPY ./next.config.js ./next.config.js
#COPY ./.env ./.env
COPY ./LICENSE ./LICENSE
EXPOSE 3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js" ]

FROM productionbase AS ogn
WORKDIR /onglide
COPY --from=ognbuildimage /onglide/dist .
ARG ENV_FILE
COPY ./${ENV_FILE:-.env} ./.env.local
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN touch .docker
EXPOSE 8080

FROM ogn AS soaringspot
RUN touch .docker


