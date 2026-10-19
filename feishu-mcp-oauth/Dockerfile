FROM node:22-slim

WORKDIR /app

# Copy package files and install deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy server
# 注意文件名是 oauth-proxy-server.js（与 package.json 里的 main 保持一致）
COPY oauth-proxy-server.js ./server.js
COPY browser-connect.js ./browser-connect.js

ENV PORT=3011
# PUBLIC_BASE_URL / UPSTREAM 由 docker-compose.yml 用 ${DOMAIN} 注入，这里不写死任何域名。
# 注意：域名只能用连字符，下划线违反 RFC 1123，严格 TLS 客户端（如 ChatGPT）会握手失败。
ENV UPSTREAM=http://feishu-mcp:3000

EXPOSE 3011

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3011)+'/healthz',r=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "server.js"]
