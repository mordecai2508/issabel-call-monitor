# ── Stage 1: build frontend ──────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ── Stage 2: production ───────────────────────────────────────────
FROM node:20-alpine

# better-sqlite3 compiles a native addon — requires build tools on Alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY --from=builder /app/frontend/dist ../frontend/dist

# Directorios persistentes; serán sobreescritos por los volúmenes en prod
RUN mkdir -p db uploads

EXPOSE 4000
CMD ["node", "server.js"]
