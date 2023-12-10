FROM node:18-slim as ognbase
RUN apt-get update 
RUN apt-get install -y gnupg wget lsb-release
RUN wget -c https://dev.mysql.com/get/mysql-apt-config_0.8.28-1_all.deb
ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg -i mysql-apt-config_0.8.28-1_all.deb
RUN apt-get update
RUN apt-get install -y mysql-community-client
RUN apt-get clean all
WORKDIR /onglide
COPY ./package.json ./
COPY ./yarn.lock ./

FROM ognbase AS buildbase
RUN yarn install --frozen-lockfile

FROM buildbase AS nextbuildimage
WORKDIR /onglide
COPY ./next.config.js ./next.config.js
COPY ./tsconfig.json ./tsconfig.json
COPY ./.babelrc ./.babelrc
COPY ./babel-plugin-macros.config.js ./babel-plugin-macros.config.js
COPY ./next-env.d.ts ./next-env.d.ts
COPY ./styles ./styles
COPY ./pages ./pages
COPY ./lib ./lib
RUN yarn next build

FROM buildbase AS ognbuildimage
WORKDIR /onglide
RUN apt install -y protobuf-compiler
COPY ./tsconfig-bin.json ./tsconfig-bin.json
COPY ./bin ./bin
COPY ./lib ./lib
RUN yarn build

FROM ognbase AS productionbase
WORKDIR /onglide
RUN yarn install --production --frozen-lockfile

FROM productionbase AS next
WORKDIR /onglide
COPY --from=nextbuildimage /onglide/.build ./.build
COPY ./next.config.js ./next.config.js
COPY ./.env ./.env
COPY ./LICENSE ./LICENSE
EXPOSE 8080
CMD node bin/ogn.js

FROM productionbase AS ogn
WORKDIR /onglide
COPY --from=ognbuildimage /onglide/dist .
COPY ./.env ./.env.local
EXPOSE 3000


