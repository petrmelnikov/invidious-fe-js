FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173
ARG INVIDIOUS_FE_REVISION=unknown
ENV INVIDIOUS_FE_REVISION=$INVIDIOUS_FE_REVISION

RUN mkdir -p /run/invidious-updates && chmod 1777 /run/invidious-updates

COPY package.json ./
COPY index.html ./
COPY scripts ./scripts
COPY src ./src

EXPOSE 5173

USER node

CMD ["npm", "run", "start"]
