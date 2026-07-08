FROM node:22-alpine

EXPOSE 5174

WORKDIR /app

ENV HOST=0.0.0.0

COPY package.json package-lock.json* ./

RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["npm", "run", "start"]
