FROM node:20-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai
ENV PORT=8080

# 构建期不要 NODE_ENV=production，否则 npm ci 会跳过 @types 导致 typecheck 失败
# better-sqlite3 仍在依赖里，构建期需要编译工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV GA_PUBLIC_BASE=/game-analysis/
RUN npm run build

ENV NODE_ENV=production
ENV GA_BASIC_AUTH_PASSWORD=sss198821

EXPOSE 8080

CMD ["npx", "tsx", "src/server/index.ts"]
