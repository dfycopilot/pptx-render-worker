FROM node:20-slim
RUN apt-get update && apt-get install -y \
    libreoffice --no-install-recommends \
    poppler-utils fonts-liberation fonts-dejavu \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
RUN npm install
EXPOSE 3000
CMD ["node", "server.js"]
