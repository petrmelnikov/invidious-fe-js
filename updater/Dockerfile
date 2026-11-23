FROM node:22-alpine

ARG UPDATER_UID=1000
ARG UPDATER_GID=1000
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client \
    && apk add --no-cache --virtual .id-tools shadow \
    && groupmod -o -g "$UPDATER_GID" node \
    && usermod -o -u "$UPDATER_UID" -g node node \
    && apk del .id-tools \
    && mkdir -p /run/invidious-updates \
    && chmod 1777 /run/invidious-updates

USER node
CMD ["sh", "-ec", "exec node \"$INVIDIOUS_FE_DIR/updater/server.mjs\""]
