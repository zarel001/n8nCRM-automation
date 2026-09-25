FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.mjs"]
