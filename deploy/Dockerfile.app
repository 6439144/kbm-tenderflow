FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY packages/ packages/
COPY services/ services/
COPY apps/ apps/

RUN npm install
RUN npm run build --workspace=packages/tenant-config
RUN npm run build --workspace=packages/ui

ARG APP_DIR=vendor-portal
ARG APP_PORT=3000
ENV PORT=${APP_PORT}
ENV APP_DIR=${APP_DIR}

WORKDIR /app/apps/${APP_DIR}

EXPOSE ${APP_PORT}

CMD ["npm", "run", "dev"]
