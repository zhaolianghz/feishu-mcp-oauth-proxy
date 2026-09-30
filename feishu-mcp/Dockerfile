# feishu-mcp 服务镜像：Node 22 + lark-cli
# 在官方 Dockerfile 基础上修两个坑：
#   1) node:22-slim 默认无 curl，但 lark-cli postinstall 用 curl 拉二进制
#   2) --omit=dev 装依赖后再 npm run build 会找不到 tsc（typescript 在 devDeps）
FROM node:22-slim

# 安装 curl + ca-certificates（lark-cli install.js 调 curl --fail --location 下载二进制并校验 sha256）
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装 lark-cli（postinstall 会自动下载 linux 平台二进制）
RUN npm install -g @larksuite/cli && lark-cli --version

# 安装项目依赖（含 devDeps，build 需要 typescript）
COPY package.json package-lock.json* ./
RUN npm install

# 构建
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf src tsconfig.json

# lark-cli 凭证与配置目录（容器内无系统密钥链，CLI 回落为文件存储；
# 挂载 volume 以持久化登录态，详见 README）
ENV HOME=/home/node
RUN mkdir -p /home/node/.lark-cli && chown -R node:node /home/node/.lark-cli
VOLUME ["/home/node/.lark-cli"]

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3000)+'/mcp',r=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
