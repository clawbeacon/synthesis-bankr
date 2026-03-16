FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/
RUN npm ci
COPY . .
RUN npm run build --workspace=@beacon-bankr/frontend

FROM node:22-alpine
RUN npm install -g http-server
COPY --from=builder /app/packages/frontend/dist /app
COPY packages/frontend/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /app
EXPOSE 8080
CMD ["/app/entrypoint.sh"]
```
