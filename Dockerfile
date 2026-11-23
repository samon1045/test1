FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
