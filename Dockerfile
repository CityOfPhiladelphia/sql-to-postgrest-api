# Builder stage: install all dependencies and compile TypeScript.
FROM node:24-slim AS builder

WORKDIR /app

# Install build dependencies if needed, or stick to clean npm install
RUN --mount=type=cache,target=/root/.npm \
  --mount=type=bind,source=package.json,target=package.json \
  npm install

# Copy source and compile
COPY . .
RUN npm run build


# Deps stage: install production dependencies only.
FROM node:24-slim AS deps

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
  --mount=type=bind,source=package.json,target=package.json \
  npm install --omit=dev


# Runner stage: minimal production runtime image
FROM node:24-slim AS runner

# Drop into a non-root user for basic container hygiene
USER node

ENV PATH=/app/node_modules/.bin:$PATH
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Expose proxy port
EXPOSE 3010

# Run the application
CMD ["node", "dist/index.js"]
