FROM node:18-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN chmod +x /app/container-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/container-entrypoint.sh"]
