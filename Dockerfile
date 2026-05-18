# Stage 1: Build Frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM python:3.13-slim
WORKDIR /app

# Install Python dependencies, including the ncplot7py package from Git.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
RUN git clone --depth 1 https://github.com/d-creations/nccode7plot.git /opt/ncplot7py

# Copy backend adapter and static assets.
COPY backend/ ./backend/
COPY public/favicon/ ./public/favicon/
COPY public/images/ ./public/images/

# Copy built frontend from the builder stage
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 8000

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/opt/ncplot7py/src:$PYTHONPATH
ENV FRONTEND_BUILD_DIR=/app/dist

# Use shell form to allow variable expansion if we wanted to use $PORT, 
# but for now we stick to 8000. Azure can be configured with WEBSITES_PORT=8000.
CMD ["uvicorn", "backend.main_import:app", "--host", "0.0.0.0", "--port", "8000"]
