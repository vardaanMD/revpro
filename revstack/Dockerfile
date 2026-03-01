ARG CACHE_BUST=1
FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 8080

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

RUN npm run build

RUN npm prune --omit=dev
RUN npm cache clean --force

CMD ["npm", "run", "docker-start"]
