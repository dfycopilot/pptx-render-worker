FROM node:20-slim

# Install LibreOffice + poppler-utils for pdftoppm
RUN apt-get update && apt-get install -y \
    libreoffice-impress \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
