# feishu-mcp 服务镜像：Node 22 + lark-cli
FROM node:22-slim

WORKDIR /app

# 安装 lark-cli（postinstall 会自动下载 linux 平台二进制）
RUN npm install -g @larksuite/cli && lark-cli --version

# 安装项目依赖并构建
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && rm -rf src tsconfig.json

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
