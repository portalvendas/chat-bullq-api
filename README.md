# Chat BullQ — API

API omnichannel de atendimento. **NestJS 11 + Prisma 6 + PostgreSQL + Redis (BullMQ)**.

## Stack
- NestJS (REST + WebSocket/socket.io) · Swagger em `/docs`
- Prisma ORM → PostgreSQL · 28 migrations
- Redis/BullMQ → filas (roteamento, automações, chatbot, notificações), presença e idempotência
- Uploads em disco local (`UPLOADS_DIR`, default `/app/uploads`)

## Rodando local
```bash
yarn install
cp .env.example .env          # ajuste DATABASE_URL / REDIS_*
npx prisma migrate deploy     # aplica as 28 migrations
npx prisma db seed            # cria admin@bravy.com (senha Admin@123) + org
yarn start:dev                # http://localhost:3001/docs
```
Requer PostgreSQL e Redis acessíveis (vars `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`).

## Deploy (Render)
`render.yaml` provisiona **API (Docker) + PostgreSQL gerenciado + Key Value (Redis)**.
No build, o container roda `prisma migrate deploy` automaticamente (ver `Dockerfile`).
Veja `../DEPLOY.md`.

## Variáveis de ambiente
Todas em `.env.example`. Mínimo para subir: `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`,
`JWT_SECRET`, `JWT_REFRESH_SECRET`. Demais habilitam features (IA, push, integrações).
