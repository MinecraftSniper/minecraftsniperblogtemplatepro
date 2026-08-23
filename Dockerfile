FROM node:20-alpine
WORKDIR /MinecraftSniper
COPY . /MinecraftSniper
RUN npm install -g pnpm
RUN pnpm install
CMD ["npm", "start"]
