# ABU9 API + web apps (single image; the API serves the built web apps and media).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && node apps/web/build.ts

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN addgroup -S abu9 && adduser -S abu9 -G abu9
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER abu9
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "apps/api/src/main.ts"]
