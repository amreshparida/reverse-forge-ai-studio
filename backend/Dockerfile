FROM node:22-slim AS base
WORKDIR /app

# Install system deps for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    fonts-liberation libappindicator3-1 libx11-xcb1 libxcb-dri3-0 \
    libxss1 wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ── Backend build ──────────────────────────────────────────────────────────
FROM base AS backend-builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/prisma ./prisma/
COPY backend/src ./src/
RUN npx prisma generate
RUN npm run build

# ── Frontend build ──────────────────────────────────────────────────────────
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Production image ───────────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
WORKDIR /app/backend

COPY --from=backend-builder /app/backend/node_modules ./node_modules
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=backend-builder /app/backend/prisma ./prisma
COPY --from=frontend-builder /app/frontend/dist ../frontend/dist
COPY backend/package.json ./

# Install Playwright browsers
RUN npx playwright install chromium --with-deps

RUN npx prisma generate

EXPOSE 3001

VOLUME ["/app/backend/project-output", "/app/backend/sessions", "/app/backend/dev.db"]

CMD ["sh", "-c", "npx prisma db push && node dist/api/server.js"]
