FROM node:13.14.0-alpine3.11

# install system dependencies
RUN apk add --no-cache make gcc g++ python bzip2 lz4 bash

# create directory for downloaded files
RUN mkdir /downloads
ENV DOWNLOAD_DIRECTORY_BASE_PATH=/downloads

WORKDIR /usr/src/app

# install node dependencies
ADD package.json /usr/src/app/package.json
ADD package-lock.json /usr/src/app/package-lock.json
RUN npm i --production

# add code
ADD configuration  /usr/src/app/configuration
ADD scripts  /usr/src/app/scripts
ADD lib  /usr/src/app/lib
ADD index.js  /usr/src/app/index.js

ENTRYPOINT [ "node", "index.js" ]
