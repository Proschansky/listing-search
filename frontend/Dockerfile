# syntax=docker/dockerfile:1
# Frontend image: the built React app served by nginx, which also proxies
# /api/* to the backend (so the browser only ever talks to one origin).
#
# Build:  docker build -t listing-search-web frontend
#
#  * Stage 1 (node)  - install exact locked deps (npm ci) and build static files.
#  * Stage 2 (nginx) - serve those files; no Node, no source, no node_modules.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
