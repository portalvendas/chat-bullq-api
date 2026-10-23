# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=false

FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN yarn build

FROM node:20-alpine AS runner
# ffmpeg: OBRIGATÓRIO — converte o áudio gravado no CRM (webm→ogg/opus) e o
# áudio de saída pro WhatsApp (ogg→mp3, libopus/libmp3lame). Sem ele o envio de
# áudio falha com "Failed to process audio".
RUN apk add --no-cache openssl curl tini ffmpeg
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=true && yarn cache clean

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -sf http://localhost:3001/docs || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
