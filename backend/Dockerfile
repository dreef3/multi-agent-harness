FROM node:20.18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
CMD ["node", "dist/index.js"]
