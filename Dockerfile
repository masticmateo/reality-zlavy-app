FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY package.json .
RUN npm install
COPY index.js .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
