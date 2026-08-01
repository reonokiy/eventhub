FROM node:24.18.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.18.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S eventhub && adduser -S -G eventhub eventhub
COPY --chown=eventhub:eventhub package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=eventhub:eventhub --from=build /app/dist ./dist
COPY --chown=eventhub:eventhub migrations ./migrations
USER eventhub
EXPOSE 3000
CMD ["node", "dist/server.js"]
