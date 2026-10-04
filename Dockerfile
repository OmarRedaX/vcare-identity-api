# One image for identity-api, identity-worker and identity-migrate (deployment.md).
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS prod-deps
WORKDIR /app
# argon2 (auth module) needs `apk add --no-cache python3 make g++` here; this stage exists so native
# builds never reach the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000 3100
CMD ["node", "dist/server.js"]
